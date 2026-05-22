/**
 * React Query hooks for the WatchTower API.
 *
 * Why centralise here?
 *  - Stable query keys (cache invalidation has to use the *same* shape).
 *  - One place to evolve fetch error handling, retry policy, and stale-time.
 *  - Page components stay declarative — no more useState/useEffect/try-catch
 *    triplets per endpoint, no missing-load-on-mount bugs, and unmount
 *    automatically aborts in-flight requests.
 *
 * Adoption pattern: convert one consumer at a time. Each conversion deletes
 * ~15 lines of imperative state code per call site.
 */
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import apiClient from '@/lib/api';

// ── Query keys ───────────────────────────────────────────────────────────────
// Treat these as the public contract. Mutations invalidate by key prefix.

export const queryKeys = {
  projects: ['projects'] as const,
  project: (id: string) => ['project', id] as const,
  projectDeployments: (id: string) => ['project', id, 'deployments'] as const,
  projectRelated: (id: string) => ['project', id, 'related'] as const,
  vscodeStatus: ['vscode-status'] as const,
  health: ['health'] as const,
  updateCheck: ['runtime', 'version'] as const,
  me: ['me'] as const,
  activeDeployments: ['deployments', 'active-count'] as const,
  edition: ['edition'] as const,
  audit: (params: AuditQueryParams) => ['audit', params] as const,
  remoteAccessProviders: ['remote-access', 'providers'] as const,
  remoteAccessDefaultPort: ['remote-access', 'default-port'] as const,
  managedDatabases: ['managed-databases'] as const,
  managedDatabase: (id: string) => ['managed-databases', id] as const,
  managedDbRuntime: ['managed-databases', 'runtime'] as const,
  managedDbEngines: ['managed-databases', 'engines'] as const,
  managedDbReplicas: (id: string) => ['managed-databases', id, 'replicas'] as const,
  managedDbBackups: (id: string) => ['managed-databases', id, 'backups'] as const,
  managedDbBackupUsage: (id: string) => ['managed-databases', id, 'backups', 'usage'] as const,
  managedDbSchedule: (id: string) => ['managed-databases', id, 'schedule'] as const,
  externalDatabases: ['external-databases'] as const,
  projectDatabases: (projectId: string) => ['projects', projectId, 'databases'] as const,
} as const;

// ── Edition / license tier ───────────────────────────────────────────────────
// Drives the Pro lock UI. Long staleTime — the tier doesn't flip mid-session
// in any normal flow, and refetching on every mount would mean every page
// loads a /edition request before deciding what to render.

export type ProFeatureKey =
  | 'audit-log'
  | 'team-rbac'
  | 'multi-region-failover'
  | 'sso'
  | 'priority-support';

export type EditionResponse = {
  tier: 'free' | 'pro';
  is_pro: boolean;
  features: Record<ProFeatureKey, {
    name: string;
    description: string;
    unlocked: boolean;
  }>;
  upgrade_url: string;
};

export function useEdition() {
  return useQuery<EditionResponse>({
    queryKey: queryKeys.edition,
    queryFn: async () => (await apiClient.get<EditionResponse>('/edition')).data,
    staleTime: 5 * 60_000,
    retry: 1,
  });
}

// Convenience: returns true iff the named feature is unlocked. Defaults
// to false (locked) on loading/error so we never accidentally show a Pro
// feature to a Free user during a network blip.
export function useProFeature(feature: ProFeatureKey): boolean {
  const { data } = useEdition();
  return Boolean(data?.features?.[feature]?.unlocked);
}

// ── Audit log ────────────────────────────────────────────────────────────────
// Pro-gated server-side. The hook still runs on Free; it just gets a 402.
// Page-level UI swaps in the upgrade prompt based on useProFeature('audit-log').

export type AuditQueryParams = {
  entity_type?: string;
  action?: string;
  days?: number;
  limit?: number;
};

export type AuditEvent = {
  id: string;
  created_at: string;
  action: string;
  entity_type: string;
  entity_id: string | null;
  org_id: string | null;
  actor_user_id: string | null;
  actor_email: string | null;
  request_id: string | null;
  client_ip: string | null;
  extra: Record<string, unknown> | null;
};

export function useAuditEvents(params: AuditQueryParams, enabled: boolean = true) {
  return useQuery<AuditEvent[]>({
    queryKey: queryKeys.audit(params),
    queryFn: async () => (await apiClient.get<AuditEvent[]>('/audit', { params })).data,
    enabled,
    staleTime: 10_000,
  });
}

// Polled live so the sidebar badge stays close-to-real-time. 8s is the
// sweet spot — fast enough that you see a build start, slow enough to
// not hammer the API on idle tabs. Lives on /api/runtime/ instead of
// /api/projects/ to avoid colliding with the projects router's
// /{project_id} catch-all path.
export function useActiveDeploymentCount() {
  return useQuery<{ active: number }>({
    queryKey: queryKeys.activeDeployments,
    queryFn: async () =>
      (await apiClient.get<{ active: number }>('/runtime/active-deployments')).data,
    refetchInterval: 8_000,
    staleTime: 5_000,
    retry: false,
  });
}

// ── Project queries ──────────────────────────────────────────────────────────

export type ProjectListItem = {
  id: string;
  name: string;
  use_case: string;
  deployment_model: string;
  source_type: string;
  local_folder_path: string | null;
  launch_url: string | null;
  repo_url: string;
  repo_branch: string;
  created_at: string;
};

export function useProjects() {
  return useQuery<ProjectListItem[]>({
    queryKey: queryKeys.projects,
    queryFn: async () => (await apiClient.get<ProjectListItem[]>('/projects')).data,
    // Dashboard polls anyway; keep this short so manual refresh is cheap.
    staleTime: 5_000,
  });
}

export function useProject(id: string | undefined) {
  return useQuery<ProjectListItem>({
    // Always pass an array; the `enabled` flag controls whether we actually fire.
    queryKey: id ? queryKeys.project(id) : ['project', 'disabled'],
    queryFn: async () => (await apiClient.get<ProjectListItem>(`/projects/${id}`)).data,
    enabled: !!id,
  });
}

export function useDeleteProject() {
  const qc = useQueryClient();
  return useMutation<void, unknown, string>({
    mutationFn: async (id) => {
      await apiClient.delete(`/projects/${id}`);
    },
    // Invalidate the list view after a successful delete.
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: queryKeys.projects });
    },
  });
}

// ── Project relations (run-with-related feature) ─────────────────────────────

export type ProjectRelation = {
  id: string;
  project_id: string;
  related_project_id: string;
  related_project_name: string | null;
  related_project_branch: string | null;
  order_index: number;
  note: string | null;
};

export function useProjectRelations(projectId: string | undefined) {
  return useQuery<ProjectRelation[]>({
    queryKey: projectId ? queryKeys.projectRelated(projectId) : ['project', 'disabled', 'related'],
    queryFn: async () => (await apiClient.get<ProjectRelation[]>(`/projects/${projectId}/related`)).data,
    enabled: !!projectId,
  });
}

export type AddRelationInput = {
  related_project_id: string;
  order_index?: number;
  note?: string;
};

export function useAddRelation(projectId: string) {
  const qc = useQueryClient();
  return useMutation<ProjectRelation, unknown, AddRelationInput>({
    mutationFn: async (input) =>
      (await apiClient.post<ProjectRelation>(`/projects/${projectId}/related`, input)).data,
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: queryKeys.projectRelated(projectId) });
    },
  });
}

export function useRemoveRelation(projectId: string) {
  const qc = useQueryClient();
  return useMutation<void, unknown, string>({
    mutationFn: async (relatedId) => {
      await apiClient.delete(`/projects/${projectId}/related/${relatedId}`);
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: queryKeys.projectRelated(projectId) });
    },
  });
}

export type RunWithRelatedResult = {
  triggered_count: number;
  skipped_count: number;
  results: Array<{
    project_id: string;
    project_name: string;
    deployment_id: string | null;
    status: 'queued' | 'skipped' | 'error';
    detail: string | null;
  }>;
};

export function useRunWithRelated(projectId: string) {
  const qc = useQueryClient();
  return useMutation<RunWithRelatedResult, unknown, void>({
    mutationFn: async () =>
      (await apiClient.post<RunWithRelatedResult>(`/projects/${projectId}/run-with-related`)).data,
    onSuccess: () => {
      // A successful run creates new Deployment rows for each project in
      // the bundle. Invalidate the deployments list per project so the
      // Deployments tab reflects them on next focus.
      void qc.invalidateQueries({ queryKey: ['project'], exact: false });
    },
  });
}

// ── Integrations ─────────────────────────────────────────────────────────────

export type VSCodeStatus = {
  installed: boolean;
  version: string | null;
  root_dir: string;
  install_instructions: { linux: string; macos: string; windows: string };
};

export function useVSCodeStatus() {
  return useQuery<VSCodeStatus>({
    queryKey: queryKeys.vscodeStatus,
    queryFn: async () => (await apiClient.get<VSCodeStatus>('/runtime/integrations/vscode/status')).data,
    // Probe doesn't change often.
    staleTime: 60_000,
  });
}

// ── Update check ─────────────────────────────────────────────────────────────

export type UpdateCheck = {
  current: string;
  latest: string | null;
  has_update: boolean;
  release_url: string | null;
  release_name?: string | null;
  published_at: string | null;
  checked_at: string;
  error?: string;
};

export const AUTO_UPDATE_CHECK_KEY = 'watchtower:autoUpdateCheck';

export function isAutoUpdateCheckEnabled(): boolean {
  // Default ON — users opt out via Settings.
  try {
    const v = localStorage.getItem(AUTO_UPDATE_CHECK_KEY);
    return v === null ? true : v === 'true';
  } catch {
    return true;
  }
}

export function setAutoUpdateCheckEnabled(enabled: boolean): void {
  try {
    localStorage.setItem(AUTO_UPDATE_CHECK_KEY, enabled ? 'true' : 'false');
  } catch {
    /* localStorage unavailable — silently fall back to defaults */
  }
}

// ── Identity ─────────────────────────────────────────────────────────────────

export type Me = {
  user_id: string;
  email: string | null;
  name: string | null;
  github_id: string | null;
  avatar_url: string | null;
  org_id: string | null;
  org_name: string | null;
  role: string | null;
  can_manage_team: boolean;
  can_manage_deployments: boolean;
  can_manage_nodes: boolean;
  can_create_projects: boolean;
  is_guest: boolean;
  is_github_authenticated: boolean;
};

export function useMe() {
  return useQuery<Me>({
    queryKey: queryKeys.me,
    queryFn: async () => (await apiClient.get<Me>('/me')).data,
    staleTime: 5 * 60 * 1000, // identity is cheap and rarely changes mid-session
    retry: false,
  });
}

/**
 * Fetches current vs latest GitHub release. Honors the user's
 * auto-check preference: when disabled, the query stays idle until
 * something forces it (e.g. clicking "Check for Updates").
 */
export function useUpdateCheck(opts?: { autoCheck?: boolean; force?: boolean }) {
  const auto = opts?.autoCheck ?? isAutoUpdateCheckEnabled();
  const force = opts?.force ?? false;
  return useQuery<UpdateCheck>({
    queryKey: force ? [...queryKeys.updateCheck, 'force'] : queryKeys.updateCheck,
    queryFn: async () =>
      (await apiClient.get<UpdateCheck>(`/runtime/version${force ? '?force=true' : ''}`)).data,
    enabled: auto,
    // Backend caches for 1h; UI cache for 30 min so a fresh tab gets a recheck-ish.
    staleTime: 30 * 60 * 1000,
    retry: false,
  });
}

// ── Remote Access ────────────────────────────────────────────────────────────
// Each provider (Tailscale today; Cloudflare Tunnel / SSH later) reports
// installed / ready / sharing state independently. Detection is cheap
// server-side but does shell out, so we don't refetch on window focus.

export type RemoteAccessProvider = {
  id: string;
  name: string;
  installed: boolean;
  ready: boolean;
  sharing: boolean;
  url: string | null;
  detail: string | null;
  hint: string | null;
  install_url: string | null;
};

export function useRemoteAccessProviders() {
  return useQuery<RemoteAccessProvider[]>({
    queryKey: queryKeys.remoteAccessProviders,
    queryFn: async () =>
      (await apiClient.get<RemoteAccessProvider[]>('/remote-access/providers')).data,
    staleTime: 10_000,
    refetchOnWindowFocus: false,
  });
}

export function useRemoteAccessDefaultPort() {
  return useQuery<{ port: number }>({
    queryKey: queryKeys.remoteAccessDefaultPort,
    queryFn: async () =>
      (await apiClient.get<{ port: number }>('/remote-access/default-port')).data,
    staleTime: 60 * 60 * 1000,
  });
}

export function useEnableRemoteAccess(providerId: string) {
  const qc = useQueryClient();
  return useMutation<RemoteAccessProvider, unknown, { port: number }>({
    mutationFn: async ({ port }) =>
      (await apiClient.post<RemoteAccessProvider>(
        `/remote-access/providers/${providerId}/enable`,
        { port },
      )).data,
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: queryKeys.remoteAccessProviders });
    },
  });
}

export function useDisableRemoteAccess(providerId: string) {
  const qc = useQueryClient();
  return useMutation<RemoteAccessProvider, unknown, void>({
    mutationFn: async () =>
      (await apiClient.post<RemoteAccessProvider>(
        `/remote-access/providers/${providerId}/disable`,
      )).data,
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: queryKeys.remoteAccessProviders });
    },
  });
}

// ── Managed databases ────────────────────────────────────────────────────────
// WatchTower-owned Postgres pods running in Podman on this host.

export type ManagedDatabase = {
  id: string;
  name: string;
  engine: string;
  version: string;
  status: 'creating' | 'running' | 'stopped' | 'failed' | 'deleting';
  status_message: string | null;
  host: string;
  port: number;
  database_name: string;
  username: string;
  pod_name: string;
  container_name: string;
  image: string;
  created_at: string | null;
  updated_at: string | null;
};

export type ManagedDatabaseCreateInput = {
  name: string;
  engine?: string;
  version?: string;
  database_name?: string;
  username?: string;
};

export type ManagedDatabaseCreateResponse = ManagedDatabase & {
  password: string;
  connection_string: string;
};

export function useManagedDbRuntime() {
  return useQuery<{ available: boolean }>({
    queryKey: queryKeys.managedDbRuntime,
    queryFn: async () =>
      (await apiClient.get<{ available: boolean }>('/managed-databases/runtime')).data,
    staleTime: 60 * 1000,
  });
}

export type ManagedDbEngine = {
  id: string;
  name: string;
  versions: string[];
  default_db_name: string;
  default_user: string;
};

export function useManagedDbEngines() {
  return useQuery<ManagedDbEngine[]>({
    queryKey: queryKeys.managedDbEngines,
    queryFn: async () =>
      (await apiClient.get<ManagedDbEngine[]>('/managed-databases/engines')).data,
    staleTime: 60 * 60 * 1000,
  });
}

export function useManagedDatabases() {
  return useQuery<ManagedDatabase[]>({
    queryKey: queryKeys.managedDatabases,
    queryFn: async () =>
      (await apiClient.get<ManagedDatabase[]>('/managed-databases')).data,
    staleTime: 5_000,
  });
}

export function useCreateManagedDatabase() {
  const qc = useQueryClient();
  return useMutation<ManagedDatabaseCreateResponse, unknown, ManagedDatabaseCreateInput>({
    mutationFn: async (input) =>
      (await apiClient.post<ManagedDatabaseCreateResponse>('/managed-databases', input)).data,
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: queryKeys.managedDatabases });
    },
  });
}

export function useStartManagedDatabase() {
  const qc = useQueryClient();
  return useMutation<ManagedDatabase, unknown, string>({
    mutationFn: async (id) =>
      (await apiClient.post<ManagedDatabase>(`/managed-databases/${id}/start`)).data,
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: queryKeys.managedDatabases });
    },
  });
}

export function useStopManagedDatabase() {
  const qc = useQueryClient();
  return useMutation<ManagedDatabase, unknown, string>({
    mutationFn: async (id) =>
      (await apiClient.post<ManagedDatabase>(`/managed-databases/${id}/stop`)).data,
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: queryKeys.managedDatabases });
    },
  });
}

export function useDeleteManagedDatabase() {
  const qc = useQueryClient();
  return useMutation<void, unknown, { id: string; purge: boolean }>({
    mutationFn: async ({ id, purge }) => {
      await apiClient.delete(`/managed-databases/${id}${purge ? '?purge=true' : ''}`);
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: queryKeys.managedDatabases });
    },
  });
}

export function useRevealManagedDatabase() {
  return useMutation<{ password: string; connection_string: string }, unknown, string>({
    mutationFn: async (id) =>
      (await apiClient.get<{ password: string; connection_string: string }>(
        `/managed-databases/${id}/credentials`,
      )).data,
  });
}

// ── Replicas (HA v1: Postgres streaming replication) ─────────────────────────

export type ManagedDbReplica = {
  id: string;
  primary_db_id: string;
  name: string;
  role: 'standby' | 'promoted';
  status: 'initializing' | 'streaming' | 'failed' | 'promoted';
  status_message: string | null;
  host: string;
  port: number;
  pod_name: string;
  container_name: string;
  replication_slot_name: string;
  last_lag_seconds: number | null;
  last_health_check: string | null;
  created_at: string | null;
  updated_at: string | null;
};

export function useManagedDbReplicas(primaryId: string, enabled: boolean = true) {
  return useQuery<ManagedDbReplica[]>({
    queryKey: queryKeys.managedDbReplicas(primaryId),
    queryFn: async () =>
      (await apiClient.get<ManagedDbReplica[]>(`/managed-databases/${primaryId}/replicas`)).data,
    enabled,
    staleTime: 5_000,
  });
}

export function useAddReplica(primaryId: string) {
  const qc = useQueryClient();
  return useMutation<ManagedDbReplica, unknown, { name?: string }>({
    mutationFn: async (input) =>
      (await apiClient.post<ManagedDbReplica>(
        `/managed-databases/${primaryId}/replicas`,
        input,
      )).data,
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: queryKeys.managedDbReplicas(primaryId) });
      // Promotion shifts the primary's state; refresh that list too.
      void qc.invalidateQueries({ queryKey: queryKeys.managedDatabases });
    },
  });
}

export function usePromoteReplica(primaryId: string) {
  const qc = useQueryClient();
  return useMutation<ManagedDbReplica, unknown, string>({
    mutationFn: async (replicaId) =>
      (await apiClient.post<ManagedDbReplica>(
        `/managed-databases/${primaryId}/replicas/${replicaId}/promote`,
      )).data,
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: queryKeys.managedDbReplicas(primaryId) });
      void qc.invalidateQueries({ queryKey: queryKeys.managedDatabases });
    },
  });
}

export function useRemoveReplica(primaryId: string) {
  const qc = useQueryClient();
  return useMutation<void, unknown, string>({
    mutationFn: async (replicaId) => {
      await apiClient.delete(`/managed-databases/${primaryId}/replicas/${replicaId}`);
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: queryKeys.managedDbReplicas(primaryId) });
    },
  });
}

// ── Backups (v0: on-demand pg_dump, local disk) ──────────────────────────────

export type ManagedDbBackup = {
  id: string;
  primary_db_id: string;
  label: string | null;
  file_path: string;
  size_bytes: number | null;
  format: string;
  status: 'running' | 'ready' | 'failed';
  status_message: string | null;
  completed_at: string | null;
  created_at: string | null;
};

export function useManagedDbBackups(primaryId: string, enabled: boolean = true) {
  return useQuery<ManagedDbBackup[]>({
    queryKey: queryKeys.managedDbBackups(primaryId),
    queryFn: async () =>
      (await apiClient.get<ManagedDbBackup[]>(`/managed-databases/${primaryId}/backups`)).data,
    enabled,
    staleTime: 10_000,
  });
}

export function useManagedDbBackupUsage(primaryId: string, enabled: boolean = true) {
  return useQuery<{ used_bytes: number; free_bytes: number }>({
    queryKey: queryKeys.managedDbBackupUsage(primaryId),
    queryFn: async () =>
      (await apiClient.get<{ used_bytes: number; free_bytes: number }>(
        `/managed-databases/${primaryId}/backups/usage`,
      )).data,
    enabled,
    staleTime: 30_000,
  });
}

export function useCreateBackup(primaryId: string) {
  const qc = useQueryClient();
  return useMutation<ManagedDbBackup, unknown, { label?: string }>({
    mutationFn: async (input) =>
      (await apiClient.post<ManagedDbBackup>(
        `/managed-databases/${primaryId}/backups`,
        input,
      )).data,
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: queryKeys.managedDbBackups(primaryId) });
      void qc.invalidateQueries({ queryKey: queryKeys.managedDbBackupUsage(primaryId) });
    },
  });
}

export function useDeleteBackup(primaryId: string) {
  const qc = useQueryClient();
  return useMutation<void, unknown, string>({
    mutationFn: async (backupId) => {
      await apiClient.delete(`/managed-databases/${primaryId}/backups/${backupId}`);
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: queryKeys.managedDbBackups(primaryId) });
      void qc.invalidateQueries({ queryKey: queryKeys.managedDbBackupUsage(primaryId) });
    },
  });
}

// Two restore modes:
//   - "in-place": replaces every object in the live DB with the
//     contents of the backup. Destructive. Requires confirm_db_name
//     to match the target's name exactly.
//   - "new": creates a brand-new managed DB alongside the original,
//     restores into it. Safer (nothing existing is destroyed) but
//     runs 2× pods until the operator deletes one. Requires new_name.
export type RestoreBackupResponse = {
  ok: boolean;
  mode?: 'in-place' | 'new';
  id: string;
  database_name?: string;       // in-place
  source_db_name?: string;      // new
  new_db_id?: string;           // new
  new_db_name?: string;         // new
  new_db_port?: number;         // new
  restored_from: {
    label: string | null;
    created_at: string | null;
    size_bytes: number | null;
  };
};

export type RestoreBackupInput =
  | { mode?: 'in-place'; backupId: string; confirmDbName: string; newName?: never }
  | { mode: 'new'; backupId: string; newName: string; confirmDbName?: never };

// ── Scheduled backups ────────────────────────────────────────────────────────

export type BackupSchedule = {
  id: string;
  name: string;
  schedule_cron: string | null;
  schedule_retention_count: number;
  last_scheduled_backup_at: string | null;
  next_run_at: string | null;
};

export function useBackupSchedule(primaryId: string, enabled: boolean = true) {
  return useQuery<BackupSchedule>({
    queryKey: queryKeys.managedDbSchedule(primaryId),
    queryFn: async () =>
      (await apiClient.get<BackupSchedule>(`/managed-databases/${primaryId}/schedule`)).data,
    enabled,
    staleTime: 30_000,
  });
}

export function useUpdateBackupSchedule(primaryId: string) {
  const qc = useQueryClient();
  return useMutation<
    BackupSchedule,
    unknown,
    { cron?: string | null; retention_count?: number }
  >({
    mutationFn: async (patch) =>
      (await apiClient.patch<BackupSchedule>(
        `/managed-databases/${primaryId}/schedule`,
        patch,
      )).data,
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: queryKeys.managedDbSchedule(primaryId) });
      // The schedule might have produced new backups already — refresh.
      void qc.invalidateQueries({ queryKey: queryKeys.managedDbBackups(primaryId) });
    },
  });
}

export function useRestoreBackup(primaryId: string) {
  const qc = useQueryClient();
  return useMutation<RestoreBackupResponse, unknown, RestoreBackupInput>({
    mutationFn: async (input) => {
      const body: Record<string, unknown> =
        input.mode === 'new'
          ? { mode: 'new', new_name: input.newName }
          : { mode: 'in-place', confirm_db_name: input.confirmDbName };
      return (await apiClient.post<RestoreBackupResponse>(
        `/managed-databases/${primaryId}/backups/${input.backupId}/restore`,
        body,
      )).data;
    },
    onSuccess: () => {
      // restore-to-new creates a new DB row, so refresh the list.
      // restore-in-place doesn't change the list shape but DB state
      // may differ (last_status_at etc.) — invalidate either way.
      void qc.invalidateQueries({ queryKey: queryKeys.managedDatabases });
    },
  });
}

// ── External databases (bring-your-own connection) ───────────────────────────

export type ExternalDatabase = {
  id: string;
  name: string;
  engine: string;
  host: string;
  port: number;
  database_name: string;
  username: string;
  use_tls: boolean;
  notes: string | null;
  has_password: boolean;
  created_at: string | null;
  updated_at: string | null;
};

export type ExternalDatabaseCreateInput = {
  name: string;
  engine: string;
  host: string;
  port: number;
  database_name?: string;
  username?: string;
  password?: string;
  use_tls?: boolean;
  notes?: string;
};

export function useExternalDatabases() {
  return useQuery<ExternalDatabase[]>({
    queryKey: queryKeys.externalDatabases,
    queryFn: async () =>
      (await apiClient.get<ExternalDatabase[]>('/external-databases')).data,
    staleTime: 10_000,
  });
}

export function useCreateExternalDatabase() {
  const qc = useQueryClient();
  return useMutation<ExternalDatabase, unknown, ExternalDatabaseCreateInput>({
    mutationFn: async (input) =>
      (await apiClient.post<ExternalDatabase>('/external-databases', input)).data,
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: queryKeys.externalDatabases });
    },
  });
}

export function useDeleteExternalDatabase() {
  const qc = useQueryClient();
  return useMutation<void, unknown, string>({
    mutationFn: async (id) => {
      await apiClient.delete(`/external-databases/${id}`);
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: queryKeys.externalDatabases });
    },
  });
}

export function useRevealExternalDatabase() {
  return useMutation<{ password: string; connection_string: string }, unknown, string>({
    mutationFn: async (id) =>
      (await apiClient.get<{ password: string; connection_string: string }>(
        `/external-databases/${id}/credentials`,
      )).data,
  });
}

// ── Project ↔ Database links ────────────────────────────────────────────────
// Each link binds a project to a managed-or-external DB + names the
// env var the connection string is injected as at deploy time.

export type ProjectDatabaseLink = {
  id: string;
  project_id: string;
  managed_database_id: string | null;
  external_database_id: string | null;
  database_name: string;
  database_engine: string;
  database_kind: 'managed' | 'external' | '?';
  env_var_name: string;
  is_active: boolean;
  notes: string | null;
  created_at: string | null;
  updated_at: string | null;
};

export type CreateLinkInput = {
  managed_database_id?: string;
  external_database_id?: string;
  env_var_name?: string;
  notes?: string;
};

export function useProjectDatabases(projectId: string | undefined) {
  return useQuery<ProjectDatabaseLink[]>({
    queryKey: projectId ? queryKeys.projectDatabases(projectId) : ['projects', 'disabled', 'databases'],
    queryFn: async () =>
      (await apiClient.get<ProjectDatabaseLink[]>(
        `/projects/${projectId}/databases`,
      )).data,
    enabled: !!projectId,
    staleTime: 10_000,
  });
}

export function useCreateProjectDatabaseLink(projectId: string) {
  const qc = useQueryClient();
  return useMutation<ProjectDatabaseLink, unknown, CreateLinkInput>({
    mutationFn: async (input) =>
      (await apiClient.post<ProjectDatabaseLink>(
        `/projects/${projectId}/databases`,
        input,
      )).data,
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: queryKeys.projectDatabases(projectId) });
    },
  });
}

export function useUpdateProjectDatabaseLink(projectId: string) {
  const qc = useQueryClient();
  return useMutation<
    ProjectDatabaseLink,
    unknown,
    { linkId: string; env_var_name?: string; is_active?: boolean; notes?: string }
  >({
    mutationFn: async ({ linkId, ...patch }) =>
      (await apiClient.patch<ProjectDatabaseLink>(
        `/projects/${projectId}/databases/${linkId}`,
        patch,
      )).data,
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: queryKeys.projectDatabases(projectId) });
    },
  });
}

export function useDeleteProjectDatabaseLink(projectId: string) {
  const qc = useQueryClient();
  return useMutation<void, unknown, string>({
    mutationFn: async (linkId) => {
      await apiClient.delete(`/projects/${projectId}/databases/${linkId}`);
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: queryKeys.projectDatabases(projectId) });
    },
  });
}
