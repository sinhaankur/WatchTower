import { useEffect, useState } from 'react';
import { Link /*, useNavigate*/ } from 'react-router-dom';
import axios from 'axios';
import apiClient from '@/lib/api';
import { trackEvent } from '@/lib/analytics';

type Project = {
  id: string;
  name: string;
  use_case: 'netlify_like' | 'vercel_like' | 'docker_platform';
  deployment_model: 'self_hosted' | 'saas';
  source_type?: 'github' | 'local_folder';
  repo_url: string;
  repo_branch: string;
  launch_url?: string;
  created_at: string;
};

type Deployment = {
  id: string;
  status: string;
  branch: string;
  commit_sha: string;
  created_at: string;
  completed_at: string | null;
};

type ProjectWithDeployment = Project & { lastDeployment: Deployment | null; deploying: boolean };

const USE_CASE_META: Record<Project['use_case'], { icon: string; label: string; color: string }> = {
  netlify_like:    { icon: '🌐', label: 'Static Site',   color: 'bg-blue-50 text-blue-700 border-blue-200' },
  vercel_like:     { icon: '⚡', label: 'SSR / Node.js', color: 'bg-indigo-50 text-indigo-700 border-indigo-200' },
  docker_platform: { icon: '🐳', label: 'Docker App',    color: 'bg-cyan-50 text-cyan-700 border-cyan-200' },
};

const STATUS_COLOR: Record<string, string> = {
  live:        'bg-emerald-100 text-emerald-700 border-emerald-200',
  building:    'bg-blue-100 text-blue-700 border-blue-200',
  deploying:   'bg-indigo-100 text-indigo-700 border-indigo-200',
  pending:     'bg-amber-100 text-amber-700 border-amber-200',
  failed:      'bg-red-100 text-red-700 border-red-200',
  rolled_back: 'bg-slate-100 text-slate-500 border-slate-200',
};

function Badge({ status }: { status: string }) {
  const cls = STATUS_COLOR[status.toLowerCase()] ?? 'bg-slate-100 text-slate-600 border-slate-200';
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium border ${cls}`}>
      {status.replace(/_/g, ' ')}
    </span>
  );
}

function fmtDate(s: string) {
  const d = new Date(s);
  const now = Date.now();
  const diff = Math.floor((now - d.getTime()) / 1000);
  if (diff < 60) return 'just now';
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return d.toLocaleDateString();
}

const Applications = () => {
  // const navigate = useNavigate();
  const [projects, setProjects] = useState<ProjectWithDeployment[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [deployingId, setDeployingId] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ kind: 'success' | 'error'; text: string } | null>(null);

  const showMsg = (kind: 'success' | 'error', text: string) => {
    setMsg({ kind, text });
    window.setTimeout(() => setMsg((c) => (c?.text === text ? null : c)), 4500);
  };

  const loadProjects = async () => {
    setLoading(true);
    setError('');
    try {
      const [projRes] = await Promise.all([apiClient.get('/projects')]);
      const rows = (projRes.data as any[]) ?? [];

      // Fetch last deployment for each project in parallel
      const enriched: ProjectWithDeployment[] = await Promise.all(
        rows.map(async (p: any) => {
          let lastDeployment: Deployment | null = null;
          try {
            const depRes = await apiClient.get(`/projects/${p.id}/deployments`);
            const deps = (depRes.data as Deployment[]) ?? [];
            lastDeployment = deps[0] ?? null;
          } catch { /* non-fatal */ }
          return {
            id:               String(p.id),
            name:             p.name ?? 'Unnamed',
            use_case:         (p.use_case ?? 'docker_platform') as Project['use_case'],
            deployment_model: (p.deployment_model ?? 'self_hosted') as Project['deployment_model'],
            source_type:      p.source_type,
            repo_url:         p.repo_url ?? '',
            repo_branch:      p.repo_branch ?? 'main',
            launch_url:       p.launch_url,
            created_at:       p.created_at ?? new Date().toISOString(),
            lastDeployment,
            deploying: false,
          };
        })
      );
      setProjects(enriched);
    } catch (err) {
      if (axios.isAxiosError(err)) {
        const s = err.response?.status;
        if (s === 401) setError('Not authenticated. Please sign in.');
        else if (s === 503) setError('API not configured. Set WATCHTOWER_API_TOKEN.');
        else setError('Could not load projects from the API.');
      } else {
        setError('Unable to reach the API.');
      }
    } finally {
      setLoading(false);
    }
  };

  const triggerDeploy = async (projectId: string, branch: string) => {
    setDeployingId(projectId);
    try {
      await apiClient.post(`/projects/${projectId}/deployments`, {
        branch,
        commit_sha: 'manual-trigger',
      });
      trackEvent('deploy_triggered', { source: 'applications_page' });
      showMsg('success', 'Deployment queued. Refreshing…');
      await loadProjects();
    } catch (err) {
      const detail = axios.isAxiosError(err)
        ? ((err.response?.data as any)?.detail ?? 'Deployment failed')
        : 'Deployment failed';
      showMsg('error', detail);
    } finally {
      setDeployingId(null);
    }
  };

  const deleteProject = async (id: string) => {
    try {
      await apiClient.delete(`/projects/${id}`);
      setProjects((p) => p.filter((x) => x.id !== id));
      showMsg('success', 'Project deleted.');
    } catch {
      showMsg('error', 'Could not delete project.');
    }
    setConfirmDelete(null);
  };

  useEffect(() => {
    void loadProjects();
    const interval = setInterval(() => void loadProjects(), 15_000);
    return () => clearInterval(interval);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="flex-1 overflow-auto bg-transparent">
      {/* Header */}
      <header
        className="px-4 sm:px-6 lg:px-8 py-4 flex items-center justify-between border-b sticky top-0 z-10 backdrop-blur-sm"
        style={{ borderColor: 'hsl(214 32% 88%)', background: 'rgba(248,251,255,0.9)' }}
      >
        <div>
          <h1 className="text-lg font-semibold text-slate-900">Applications</h1>
          <p className="text-xs text-slate-600 mt-0.5 hidden sm:block">
            {loading ? 'Loading…' : `${projects.length} project${projects.length !== 1 ? 's' : ''}`}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => void loadProjects()}
            disabled={loading}
            className="px-3 py-1.5 rounded-lg border border-border text-xs text-slate-700 hover:bg-slate-100 transition-colors disabled:opacity-50"
          >
            {loading ? '…' : '↻ Refresh'}
          </button>
          <Link
            to="/setup"
            className="px-3 sm:px-4 py-1.5 rounded-lg bg-red-700 hover:bg-red-800 text-white text-xs sm:text-sm font-medium transition-colors border border-slate-800 shadow-[2px_2px_0_0_#1f2937]"
          >
            + Deploy App
          </Link>
        </div>
      </header>

      <main className="px-4 sm:px-6 lg:px-8 py-6 max-w-5xl mx-auto w-full space-y-4 fade-in-up">
        {/* Toast */}
        {msg && (
          <div className={`rounded-lg border px-4 py-3 text-sm ${
            msg.kind === 'success'
              ? 'border-emerald-300 bg-emerald-50 text-emerald-700'
              : 'border-red-300 bg-red-50 text-red-700'
          }`}>
            {msg.text}
          </div>
        )}

        {/* Error state */}
        {error && !loading && (
          <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
            {error}
          </div>
        )}

        {/* Skeleton */}
        {loading && (
          <div className="space-y-3">
            {[1, 2, 3].map((i) => (
              <div key={i} className="h-24 rounded-xl border border-border bg-card animate-pulse" />
            ))}
          </div>
        )}

        {/* Project list */}
        {!loading && projects.length > 0 && (
          <div className="space-y-3">
            {projects.map((p) => {
              const meta = USE_CASE_META[p.use_case];
              const isDeploying = deployingId === p.id;
              const inProgress = ['pending', 'building', 'deploying'].includes(
                p.lastDeployment?.status.toLowerCase() ?? ''
              );
              return (
                <div
                  key={p.id}
                  className="rounded-xl border border-border bg-card hover:border-red-200 transition-colors shadow-sm overflow-hidden"
                >
                  <div className="px-5 py-4 flex items-start justify-between gap-4">
                    {/* Left: name + meta */}
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="text-base">{meta.icon}</span>
                        <Link
                          to={`/projects/${p.id}`}
                          className="font-semibold text-slate-900 hover:text-red-700 transition-colors truncate"
                        >
                          {p.name}
                        </Link>
                        <span className={`text-[11px] px-2 py-0.5 rounded-full border font-medium ${meta.color}`}>
                          {meta.label}
                        </span>
                        {p.lastDeployment && (
                          <Badge status={p.lastDeployment.status} />
                        )}
                        {!p.lastDeployment && (
                          <span className="text-[11px] px-2 py-0.5 rounded-full border border-slate-200 bg-slate-50 text-slate-500 font-medium">
                            never deployed
                          </span>
                        )}
                      </div>
                      <div className="mt-1.5 flex items-center gap-3 text-xs text-slate-500 flex-wrap">
                        {p.repo_url && !p.repo_url.startsWith('local://') ? (
                          <span className="truncate max-w-xs font-mono">{p.repo_url.replace('https://github.com/', '')}</span>
                        ) : (
                          <span className="font-mono">{p.source_type === 'local_folder' ? 'local folder' : p.repo_url}</span>
                        )}
                        <span className="font-mono bg-slate-100 px-1.5 py-0.5 rounded">{p.repo_branch}</span>
                        {p.lastDeployment && (
                          <span>Last deploy {fmtDate(p.lastDeployment.created_at)}</span>
                        )}
                      </div>
                    </div>

                    {/* Right: actions */}
                    <div className="flex items-center gap-2 shrink-0">
                      {p.launch_url && /^https?:\/\//i.test(p.launch_url) && (
                        <a
                          href={p.launch_url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="px-3 py-1.5 rounded-lg border border-border text-xs text-slate-700 hover:bg-slate-100 transition-colors"
                        >
                          Open ↗
                        </a>
                      )}
                      <button
                        onClick={() => void triggerDeploy(p.id, p.repo_branch)}
                        disabled={isDeploying || inProgress}
                        className="px-3 py-1.5 rounded-lg bg-red-700 hover:bg-red-800 text-white text-xs font-medium transition-colors border border-slate-800 shadow-[1px_1px_0_0_#1f2937] disabled:opacity-50 disabled:cursor-not-allowed"
                      >
                        {isDeploying || inProgress ? (
                          <span className="inline-flex items-center gap-1">
                            <span className="inline-block w-2.5 h-2.5 border-2 border-white/40 border-t-white rounded-full animate-spin" />
                            {inProgress ? 'Running…' : 'Queuing…'}
                          </span>
                        ) : '▶ Deploy'}
                      </button>
                      <Link
                        to={`/projects/${p.id}`}
                        className="px-3 py-1.5 rounded-lg border border-border text-xs text-slate-700 hover:bg-slate-100 transition-colors"
                      >
                        Details
                      </Link>
                      <button
                        onClick={() => setConfirmDelete(p.id)}
                        className="px-2 py-1.5 rounded-lg border border-border text-xs text-slate-400 hover:text-red-600 hover:border-red-300 transition-colors"
                        title="Delete project"
                      >
                        ✕
                      </button>
                    </div>
                  </div>

                  {/* Deployment progress bar */}
                  {inProgress && (
                    <div className="h-0.5 w-full bg-slate-100">
                      <div className="h-full bg-blue-400 animate-pulse w-full" />
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}

        {/* Empty state */}
        {!loading && !error && projects.length === 0 && (
          <div className="rounded-xl border border-border bg-card p-6">
            <div className="text-center py-10 border border-dashed border-border rounded-xl mb-6">
              <div className="w-12 h-12 rounded-xl bg-red-50 border border-red-200 flex items-center justify-center mx-auto mb-3">
                <span className="text-xl">📦</span>
              </div>
              <p className="text-sm font-semibold text-slate-900">No applications yet</p>
              <p className="text-xs text-slate-600 mt-1 mb-4">
                Add a server node first, then use the Setup Wizard to deploy your first app.
              </p>
              <div className="flex items-center justify-center gap-3">
                <Link to="/servers"
                  className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg border border-border text-slate-700 hover:bg-slate-100 text-sm transition-colors">
                  → Add Server First
                </Link>
                <Link to="/setup"
                  className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-red-700 hover:bg-red-800 text-white text-sm transition-colors border border-slate-800 shadow-[2px_2px_0_0_#1f2937]">
                  Setup Wizard →
                </Link>
              </div>
            </div>

            <h2 className="text-sm font-semibold text-slate-900 mb-3">What can I deploy?</h2>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              {[
                { icon: '🌐', title: 'Static Site',   desc: 'React, Vue, Angular — any static build. Fast to serve, ideal for frontends.' },
                { icon: '⚡', title: 'Node.js / SSR', desc: 'Next.js, Nuxt, Express — full-stack apps with server-side rendering.' },
                { icon: '🐳', title: 'Docker App',    desc: 'Any containerised service. Bring your own Dockerfile.' },
              ].map(({ icon, title, desc }) => (
                <Link key={title} to="/setup"
                  className="p-4 rounded-lg border border-border bg-muted/20 hover:border-red-300 hover:bg-red-50/40 transition-all group">
                  <span className="text-2xl">{icon}</span>
                  <p className="text-sm font-semibold text-slate-900 mt-2">{title}</p>
                  <p className="text-xs text-slate-600 mt-1">{desc}</p>
                  <p className="text-xs text-red-700 mt-3 opacity-0 group-hover:opacity-100 transition-opacity">Deploy this →</p>
                </Link>
              ))}
            </div>
          </div>
        )}
      </main>

      {/* Delete confirmation dialog */}
      {confirmDelete && (
        <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4">
          <div className="bg-white rounded-xl border border-border shadow-xl p-6 max-w-sm w-full">
            <h2 className="text-base font-semibold text-slate-900">Delete project?</h2>
            <p className="text-sm text-slate-600 mt-1">
              This removes the project and all deployment history. This cannot be undone.
            </p>
            <div className="flex gap-2 mt-4 justify-end">
              <button
                onClick={() => setConfirmDelete(null)}
                className="px-4 py-2 rounded-lg border border-border text-sm text-slate-700 hover:bg-slate-100 transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={() => void deleteProject(confirmDelete)}
                className="px-4 py-2 rounded-lg bg-red-700 hover:bg-red-800 text-white text-sm font-medium transition-colors"
              >
                Delete
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default Applications;
