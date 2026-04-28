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
} as const;

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
