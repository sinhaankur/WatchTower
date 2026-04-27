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
