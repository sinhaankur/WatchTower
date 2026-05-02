import { Link, useLocation, useNavigate } from 'react-router-dom';
import { useEffect, useMemo, useState } from 'react';
import axios from 'axios';
import apiClient from '@/lib/api';

// ── Types ─────────────────────────────────────────────────────────────────────
type LocalProject = {
  id: string;
  name: string;
  use_case: 'netlify_like' | 'vercel_like' | 'docker_platform';
  deployment_model: 'self_hosted' | 'saas';
  source_type?: 'github' | 'local_folder';
  local_folder_path?: string;
  launch_url?: string;
  repo_url: string;
  repo_branch: string;
  created_at: string;
};

type RuntimeStatus = {
  podman: {
    installed: boolean;
    version: string | null;
    running_containers: number;
    sample_containers: Array<{ name: string; image: string; state: string }>;
  };
  watchtower: {
    cli_available: boolean;
    cli_error: string | null;
    systemd_service: string;
    appcenter_service: string;
    background_process: {
      running: boolean;
      pid: number | null;
      pid_file: string;
      log_file: string;
      log_tail: string;
    };
  };
};

type Notice = { kind: 'success' | 'error' | 'info'; message: string };

const STORAGE_KEY = 'wt_projects';

const USE_CASE_META: Record<LocalProject['use_case'], { label: string; color: string; dot: string }> = {
  netlify_like:    { label: 'Static + Functions', color: 'bg-blue-100 text-blue-700 border-blue-200', dot: 'bg-blue-500' },
  vercel_like:     { label: 'SSR App',            color: 'bg-indigo-100 text-indigo-700 border-indigo-200', dot: 'bg-indigo-500' },
  docker_platform: { label: 'Docker App',         color: 'bg-cyan-100 text-cyan-700 border-cyan-200', dot: 'bg-cyan-500' },
};

/**
 * Defensive deduplication: remove duplicate projects by name.
 * Keeps the most recently created one if duplicates are found.
 * (Backend now prevents duplicates, but this guards against any edge cases)
 */
function deduplicateProjects<T extends LocalProject>(projects: T[]): T[] {
  const seen = new Map<string, { item: T; createdAt: number }>();
  
  projects.forEach((p) => {
    const createdAt = new Date(p.created_at).getTime();
    const existing = seen.get(p.name);
    
    if (!existing || createdAt > existing.createdAt) {
      seen.set(p.name, { item: p, createdAt });
    }
  });
  
  return Array.from(seen.values()).map((v) => v.item);
}

// ── Small components ──────────────────────────────────────────────────────────
function StatCard({ label, value, sub, accent }: { label: string; value: string | number; sub?: string; accent?: string }) {
  return (
    <div className="rounded-xl border border-border bg-card p-5 hover:border-red-300 transition-colors shadow-sm">
      <p className="text-xs text-muted-foreground uppercase tracking-wider mb-2">{label}</p>
      <p className={`text-3xl font-bold ${accent ?? 'text-foreground'}`}>{value}</p>
      {sub && <p className="text-xs text-muted-foreground mt-1">{sub}</p>}
    </div>
  );
}

function StatusDot({ running }: { running: boolean }) {
  return (
    <span className={`inline-block w-2 h-2 rounded-full shrink-0 ${running ? 'bg-emerald-500 status-pulse' : 'bg-slate-400'}`} />
  );
}

function NoticeBanner({ notice }: { notice: Notice }) {
  const styles = {
    success: 'border-emerald-300 bg-emerald-50 text-emerald-700',
    error:   'border-red-300 bg-red-50 text-red-700',
    info:    'border-amber-300 bg-amber-50 text-amber-800',
  };
  return (
    <div className={`border rounded-lg px-4 py-3 text-sm ${styles[notice.kind]}`}>
      {notice.message}
    </div>
  );
}

// ── Main Dashboard ────────────────────────────────────────────────────────────
const Dashboard = () => {
  const location = useLocation();
  const navigate = useNavigate();
  const [projects, setProjects]           = useState<LocalProject[]>([]);
  const [loading, setLoading]             = useState(true);
  const [serverStatus, setServerStatus]   = useState<'checking' | 'online' | 'offline'>('checking');
  const [dataSource, setDataSource]       = useState<'server' | 'local'>('local');
  const [runtimeStatus, setRuntime]       = useState<RuntimeStatus | null>(null);
  const [runtimeLoading, setRtLoading]    = useState(false);
  const [runtimeAction, setRtAction]      = useState<'start' | 'stop' | 'update' | null>(null);
  const [notice, setNotice]               = useState<Notice | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);

  const showNotice = (kind: Notice['kind'], message: string) => {
    setNotice({ kind, message });
    window.setTimeout(() => setNotice((c) => (c?.message === message ? null : c)), 4200);
  };

  const parseApiError = (error: unknown, fallback: string): string => {
    if (!axios.isAxiosError(error)) return fallback;
    const detail = (error.response?.data as any)?.detail;
    if (typeof detail === 'string' && detail.trim()) return detail;
    if (detail && typeof detail === 'object') {
      const m = detail.message || detail.stderr || detail.stdout;
      if (typeof m === 'string' && m.trim()) return m;
    }
    return fallback;
  };

  const loadRuntime = async () => {
    setRtLoading(true);
    try {
      const r = await apiClient.get('/runtime/status');
      setRuntime(r.data as RuntimeStatus);
    } catch (err) {
      showNotice('error', parseApiError(err, 'Runtime status check failed.'));
    } finally {
      setRtLoading(false);
    }
  };

  const startBackground = async () => {
    setRtAction('start');
    try {
      const r = await apiClient.post('/runtime/watchtower/start-background');
      showNotice('success', (r.data as any)?.message || 'WatchTower background process started.');
      await loadRuntime();
    } catch (err) { showNotice('error', parseApiError(err, 'Unable to start.')); }
    finally { setRtAction(null); }
  };

  const stopBackground = async () => {
    setRtAction('stop');
    try {
      const r = await apiClient.post('/runtime/watchtower/stop-background');
      showNotice('info', (r.data as any)?.message || 'WatchTower stopped.');
      await loadRuntime();
    } catch (err) { showNotice('error', parseApiError(err, 'Unable to stop.')); }
    finally { setRtAction(null); }
  };

  const runUpdateNow = async () => {
    setRtAction('update');
    try {
      const r = await apiClient.post('/runtime/watchtower/update-now');
      const out = ((r.data as any)?.stdout as string) || '';
      showNotice('success', out ? `Update complete. ${out.split('\n')[0]}` : 'Update check completed.');
      await loadRuntime();
    } catch (err) { showNotice('error', parseApiError(err, 'Update failed.')); }
    finally { setRtAction(null); }
  };

  const loadLocalProjects = () => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      const parsed = raw ? (JSON.parse(raw) as LocalProject[]) : [];
      setProjects(Array.isArray(parsed) ? parsed : []);
      setDataSource('local');
    } catch { setProjects([]); }
  };

  const loadProjects = async () => {
    setLoading(true);
    setServerStatus('checking');
    let apiReachable = false;
    try {
      const health = await apiClient.get('/health');
      apiReachable = health.status < 300;
      setServerStatus(apiReachable ? 'online' : 'offline');
    } catch {
      setServerStatus('offline');
    }

    try {
      const proj = await apiClient.get('/projects');
      const rows = (proj.data as any[]) ?? [];
      const mapped = rows.map((p) => ({
        id:               String(p.id),
        name:             p.name ?? 'Unnamed Project',
        use_case:         (p.use_case ?? 'docker_platform') as LocalProject['use_case'],
        deployment_model: (p.deployment_model ?? 'self_hosted') as LocalProject['deployment_model'],
        source_type:      (p.source_type ?? 'github') as LocalProject['source_type'],
        local_folder_path: p.local_folder_path,
        launch_url:       p.launch_url,
        repo_url:         p.repo_url ?? '',
        repo_branch:      p.repo_branch ?? 'main',
        created_at:       p.created_at ?? new Date().toISOString(),
      }));
      setProjects(deduplicateProjects(mapped));
      setDataSource('server');
    } catch (err) {
      if (apiReachable) {
        // API is reachable, but the data fetch failed (auth/validation/etc).
        // Keep the online indicator and fall back to local cache.
        showNotice('error', parseApiError(err, 'Unable to load projects from API. Showing local cache.'));
      }
      loadLocalProjects();
    } finally {
      setLoading(false);
    }
  };

  const deleteProject = async (id: string) => {
    if (dataSource === 'server') {
      try { await apiClient.delete(`/projects/${id}`); } catch { /* best-effort */ }
    }
    const next = projects.filter((p) => p.id !== id);
    setProjects(next);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    setConfirmDelete(null);
  };

  const resolveLaunchUrl = (p: LocalProject) => {
    if (p.launch_url && /^https?:\/\//i.test(p.launch_url)) return p.launch_url;
    if (p.repo_url   && /^https?:\/\//i.test(p.repo_url))   return p.repo_url;
    if (p.source_type === 'local_folder') return 'http://127.0.0.1:3000';
    return '';
  };

  useEffect(() => {
    void loadProjects();
    void loadRuntime();
    // Poll every 15 seconds to refresh deployment statuses
    const interval = setInterval(() => void loadProjects(), 15_000);
    return () => clearInterval(interval);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const navState = (location.state ?? null) as null | {
      just_created?: string;
      source_type?: 'github' | 'local_folder';
      initial_deploy_queued?: boolean;
    };
    if (!navState?.just_created) return;

    if (navState.source_type === 'github') {
      if (navState.initial_deploy_queued) {
        showNotice('success', `Project ${navState.just_created} created. Initial deployment queued and repository clone has started.`);
      } else {
        showNotice('info', `Project ${navState.just_created} created. Click Deploy to start cloning and building from GitHub.`);
      }
    } else {
      showNotice('success', `Project ${navState.just_created} created successfully.`);
    }

    navigate(location.pathname, { replace: true, state: null });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.state]);

  const stats = useMemo(() => ({
    total:  projects.length,
    static: projects.filter((p) => p.use_case === 'netlify_like').length,
    ssr:    projects.filter((p) => p.use_case === 'vercel_like').length,
    docker: projects.filter((p) => p.use_case === 'docker_platform').length,
  }), [projects]);

  const containers = runtimeStatus?.podman.running_containers ?? 0;
  const bgRunning  = runtimeStatus?.watchtower.background_process.running ?? false;

  return (
    <div className="flex-1 overflow-auto bg-transparent">
      {/* Page header */}
      <header
        className="px-4 sm:px-6 lg:px-8 py-4 flex items-center justify-between gap-3 border-b sticky top-0 z-10 backdrop-blur-sm"
        style={{ borderColor: 'hsl(var(--border-soft))', background: 'hsl(var(--surface-soft) / 0.9)' }}
      >
        <div className="min-w-0">
          <h1 className="text-lg font-semibold text-slate-900">Dashboard</h1>
          <p className="text-xs text-slate-600 mt-0.5 hidden sm:block">Overview of your self-hosted infrastructure</p>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <span
            className={`hidden sm:inline-flex items-center gap-1.5 text-xs px-2.5 py-1 rounded-full border font-medium ${
              serverStatus === 'online'
                ? 'bg-emerald-50 text-emerald-800 border-emerald-300'
                : serverStatus === 'offline'
                  ? 'bg-red-50 text-red-800 border-red-300'
                  : 'bg-slate-100 text-slate-700 border-slate-300'
            }`}
          >
            <StatusDot running={serverStatus === 'online'} />
            {serverStatus === 'online' ? 'API online' : serverStatus === 'offline' ? 'Offline' : 'Connecting…'}
          </span>
          <button
            onClick={() => void loadProjects()}
            disabled={loading}
            className="px-3 py-1.5 rounded-lg border border-border text-xs text-slate-700 hover:bg-slate-100 transition-colors disabled:opacity-50"
          >
            {loading ? '…' : 'Refresh'}
          </button>
          <Link
            to="/setup"
            className="px-3 sm:px-4 py-1.5 rounded-lg bg-red-700 hover:bg-red-800 transition-colors text-white text-xs sm:text-sm font-medium border border-slate-800 shadow-[2px_2px_0_0_#1f2937]"
          >
            + New
          </Link>
        </div>
      </header>

      <main className="px-4 sm:px-6 lg:px-8 py-6 space-y-6 max-w-6xl mx-auto w-full fade-in-up">
        {notice && <NoticeBanner notice={notice} />}

        {/* Hero / onboarding banner */}
        <section className="wt-panel p-5 bg-gradient-to-br from-white to-amber-50">
          <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-4">
            <div className="min-w-0">
              <p className="text-[11px] uppercase tracking-[0.18em] text-red-700 font-semibold">WatchTower</p>
              <h2 className="text-xl font-bold text-slate-900 mt-1">Simple Infrastructure Control</h2>
              <p className="text-sm text-slate-600 mt-1.5">
                Manage hosts, deploy apps, connect databases, and keep containers up to date from one place.
              </p>
            </div>
            <Link
              to="/host-connect?tab=tools"
              className="shrink-0 px-4 py-2 rounded-xl border border-slate-800 bg-white hover:bg-amber-50 text-red-700 text-sm font-semibold transition-colors shadow-[2px_2px_0_0_#1f2937]"
            >
              Host Connect
            </Link>
          </div>
          {/* Quick start steps — shown when offline / no projects */}
          {(serverStatus !== 'online' || projects.length === 0) && !loading && (
            <div className="mt-4 pt-4 border-t border-amber-200">
              <p className="text-xs font-semibold text-slate-700 mb-2">Getting started</p>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                {[
                  { step: '1', label: 'Set up tools', desc: 'Install Podman, Docker or Nginx on your server', to: '/host-connect?tab=tools' },
                  { step: '2', label: 'Add a server', desc: 'Connect your infrastructure node to WatchTower', to: '/servers' },
                  { step: '3', label: 'Deploy a project', desc: 'Use the Setup Wizard to launch your first app', to: '/setup' },
                ].map(({ step, label, desc, to }) => (
                  <Link key={step} to={to} className="flex items-start gap-3 p-3 rounded-lg border border-amber-200 bg-white/60 hover:bg-white hover:border-amber-300 transition-all">
                    <span className="w-5 h-5 rounded-full bg-red-700 text-white text-[10px] font-bold flex items-center justify-center shrink-0 mt-0.5">{step}</span>
                    <div>
                      <p className="text-xs font-semibold text-slate-800">{label}</p>
                      <p className="text-[11px] text-slate-500 mt-0.5">{desc}</p>
                    </div>
                  </Link>
                ))}
              </div>
            </div>
          )}
        </section>

        {/* Stats row */}
        <div className="grid grid-cols-2 sm:grid-cols-2 lg:grid-cols-4 gap-3 sm:gap-4">
          <StatCard label="Total Projects" value={stats.total} sub={dataSource === 'server' ? 'from API' : 'local cache'} accent="text-red-700" />
          <StatCard label="Containers" value={containers} sub={runtimeStatus?.podman.installed ? `Podman ${runtimeStatus.podman.version ?? ''}` : 'Podman not detected'} />
          <StatCard label="Static Sites"   value={stats.static} sub="Netlify-style" />
          <StatCard label="Docker Apps"    value={stats.docker} sub="Container-based" />
        </div>

        {/* Runtime health + quick actions */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          {/* Container status */}
          <div className="rounded-xl border border-border bg-card p-5 space-y-3">
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-semibold text-slate-900">Container Runtime</h2>
              <button
                onClick={() => void loadRuntime()}
                disabled={runtimeLoading}
                className="text-xs text-slate-600 hover:text-slate-900 transition-colors disabled:opacity-50"
              >
                {runtimeLoading ? 'Refreshing…' : '↻ Refresh'}
              </button>
            </div>
            {[
              {
                label: 'Podman',
                running: runtimeStatus?.podman.installed ?? false,
                detail: runtimeStatus?.podman.version ?? 'Not detected',
                right: `${containers} running`,
              },
              {
                label: 'WatchTower Updater',
                running: bgRunning,
                detail: bgRunning ? `Running · PID ${runtimeStatus?.watchtower.background_process.pid}` : 'Stopped',
                right: '',
              },
              {
                label: 'Systemd Service',
                running: runtimeStatus?.watchtower.systemd_service === 'active',
                detail: runtimeStatus?.watchtower.systemd_service ?? 'unknown',
                right: '',
              },
            ].map((row) => (
              <div key={row.label} className="flex items-center gap-3 p-3 rounded-lg bg-muted/40">
                <StatusDot running={row.running} />
                <div className="flex-1 min-w-0">
                  <p className="text-sm text-slate-900 font-medium">{row.label}</p>
                  <p className="text-xs text-slate-600 truncate">{row.detail}</p>
                </div>
                {row.right && <span className="text-xs text-slate-600 shrink-0">{row.right}</span>}
              </div>
            ))}
          </div>

          {/* Quick actions */}
          <div className="rounded-xl border border-border bg-card p-5 space-y-3">
            <h2 className="text-sm font-semibold text-slate-900">Quick Actions</h2>
            <button
              onClick={() => void (bgRunning ? stopBackground() : startBackground())}
              disabled={runtimeAction !== null}
              className={`w-full flex items-center gap-3 p-3 rounded-lg border transition-colors disabled:opacity-50 text-left ${
                bgRunning
                  ? 'border-red-300 bg-red-50 hover:bg-red-100 text-red-700'
                  : 'border-emerald-300 bg-emerald-50 hover:bg-emerald-100 text-emerald-700'
              }`}
            >
              <span className="text-lg leading-none">{bgRunning ? '⏹' : '▶'}</span>
              <div>
                <p className="text-sm font-medium">
                  {runtimeAction === 'start' ? 'Starting…' : runtimeAction === 'stop' ? 'Stopping…' : bgRunning ? 'Stop Background Updater' : 'Start Background Updater'}
                </p>
                <p className="text-xs opacity-70 mt-0.5">Manage auto-update daemon</p>
              </div>
            </button>

            <button
              onClick={() => void runUpdateNow()}
              disabled={runtimeAction !== null}
              className="w-full flex items-center gap-3 p-3 rounded-lg border border-red-300 bg-red-50 hover:bg-red-100 text-red-700 transition-colors disabled:opacity-50 text-left"
            >
              <span className="text-lg leading-none">🔄</span>
              <div>
                <p className="text-sm font-medium">{runtimeAction === 'update' ? 'Checking…' : 'Run Update Check Now'}</p>
                <p className="text-xs opacity-70 mt-0.5">Force a container image refresh</p>
              </div>
            </button>

            <Link
              to="/servers"
              className="flex items-center gap-3 p-3 rounded-lg border border-border hover:bg-slate-100 text-slate-800 transition-colors"
            >
              <span className="text-lg leading-none">🖥</span>
              <div>
                <p className="text-sm font-medium">Manage Servers</p>
                <p className="text-xs text-slate-600 mt-0.5">Add or monitor infrastructure nodes</p>
              </div>
            </Link>
          </div>
        </div>

        {/* Monitored containers (if any) */}
        {(runtimeStatus?.podman.sample_containers?.length ?? 0) > 0 && (
          <div className="rounded-xl border border-border bg-card p-5">
            <h2 className="text-sm font-semibold text-slate-900 mb-3">Monitored Containers</h2>
            <div className="space-y-2">
              {runtimeStatus!.podman.sample_containers.map((c) => (
                <div key={c.name} className="flex items-center gap-3 p-3 rounded-lg bg-muted/40 hover:bg-muted/60 transition-colors">
                  <StatusDot running={c.state === 'running'} />
                  <div className="flex-1 min-w-0">
                    <p className="text-sm text-slate-900 font-mono truncate">{c.name}</p>
                    <p className="text-xs text-slate-600 truncate">{c.image}</p>
                  </div>
                  <span className={`text-xs px-2 py-0.5 rounded-full border font-medium ${
                    c.state === 'running' ? 'badge-running' : c.state === 'exited' ? 'badge-stopped' : 'badge-unknown'
                  }`}>
                    {c.state}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Projects list */}
        <div className="rounded-xl border border-border bg-card p-5">
          <div className="flex items-center justify-between mb-4">
            <div>
              <h2 className="text-sm font-semibold text-slate-900">Projects</h2>
              <p className="text-xs text-slate-600 mt-0.5">
                {loading ? 'Loading…' : projects.length === 0
                  ? 'No projects yet'
                  : `${projects.length} project${projects.length !== 1 ? 's' : ''} · ${dataSource === 'server' ? 'live data' : 'local cache'}`}
              </p>
            </div>
            <Link
              to="/setup"
              className="px-3 py-1.5 rounded-lg bg-red-700 hover:bg-red-800 transition-colors text-white text-xs font-medium border border-slate-800 shadow-[2px_2px_0_0_#1f2937]"
            >
              + New Project
            </Link>
          </div>

          {!loading && projects.length === 0 && (
            <div className="text-center py-14 border border-dashed border-border rounded-xl">
              <div className="w-12 h-12 rounded-xl bg-red-50 border border-red-200 flex items-center justify-center mx-auto mb-3">
                <span className="text-xl">📦</span>
              </div>
              <p className="text-sm font-medium text-slate-900">No projects yet</p>
              <p className="text-xs text-slate-600 mt-1 mb-4">Deploy your first application to get started.</p>
              <Link
                to="/setup"
                className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-red-700 hover:bg-red-800 text-white text-sm transition-colors border border-slate-800 shadow-[2px_2px_0_0_#1f2937]"
              >
                Start Setup Wizard →
              </Link>
            </div>
          )}

          {projects.length > 0 && (
            <div className="space-y-2">
              {projects.map((project) => {
                const meta = USE_CASE_META[project.use_case];
                const launchUrl = resolveLaunchUrl(project);
                return (
                  <div
                    key={project.id}
                    className="flex items-center justify-between gap-4 p-4 rounded-xl border border-border hover:border-red-300 bg-muted/20 hover:bg-red-50/40 transition-all"
                  >
                    <div className="flex items-center gap-3 min-w-0">
                      <div className={`w-2.5 h-2.5 rounded-full shrink-0 ${meta.dot}`} />
                      <Link to={`/projects/${project.id}`} className="min-w-0 hover:underline">
                        <p className="text-sm font-semibold text-slate-900 truncate">{project.name}</p>
                        <div className="flex items-center gap-2 mt-1 flex-wrap">
                          <span className={`text-xs px-2 py-0.5 rounded-full border ${meta.color}`}>{meta.label}</span>
                          <span className="text-xs text-slate-600">{project.deployment_model === 'self_hosted' ? 'Self-hosted' : 'SaaS'}</span>
                          <span className="font-mono text-xs text-slate-500">{project.repo_branch}</span>
                        </div>
                      </Link>
                    </div>

                    <div className="flex items-center gap-2 shrink-0">
                      {/* Open in VS Code deep link */}
                      {(() => {
                        const vsUrl = project.source_type === 'local_folder' && project.local_folder_path
                          ? `vscode://file${project.local_folder_path}`
                          : project.repo_url && /^https?:\/\//i.test(project.repo_url)
                            ? `vscode://vscode.git/clone?url=${encodeURIComponent(project.repo_url)}`
                            : null;
                        return vsUrl ? (
                          <a
                            href={vsUrl}
                            title="Open in VS Code"
                            className="inline-flex items-center gap-1 text-xs px-2 py-1 rounded border border-[#007ACC]/40 bg-[#007ACC]/5 text-[#007ACC] hover:bg-[#007ACC]/15 transition-colors font-medium"
                          >
                            <svg width="11" height="11" viewBox="0 0 100 100" fill="currentColor">
                              <path d="M74.9 13.3L51.7 38.6 31.4 22.6 13.3 33.2v33.6l18.1 10.6 20.3-16 23.2 25.3L87 75.5V24.5L74.9 13.3zM31.4 60.8l-9-5.4V44.6l9-5.4 13 10.8-13 10.8z"/>
                            </svg>
                            VS Code
                          </a>
                        ) : null;
                      })()}
                      {launchUrl && (
                        <a href={launchUrl} target="_blank" rel="noreferrer"
                          className="text-xs text-red-700 hover:text-red-800 transition-colors">
                          Open ↗
                        </a>
                      )}
                      {project.repo_url && (
                        <a href={project.repo_url} target="_blank" rel="noreferrer"
                          className="text-xs text-slate-600 hover:text-slate-900 transition-colors">
                          Repo ↗
                        </a>
                      )}
                      {confirmDelete === project.id ? (
                        <div className="flex items-center gap-1">
                          <span className="text-xs text-slate-600">Delete?</span>
                          <button onClick={() => void deleteProject(project.id)}
                            className="px-2 py-1 text-xs rounded border border-red-300 text-red-600 hover:bg-red-50 transition-colors">Yes</button>
                          <button onClick={() => setConfirmDelete(null)}
                            className="px-2 py-1 text-xs rounded border border-border text-slate-600 hover:bg-slate-100 transition-colors">No</button>
                        </div>
                      ) : (
                        <button onClick={() => setConfirmDelete(project.id)}
                          className="px-2 py-1 text-xs rounded border border-border text-slate-600 hover:border-red-300 hover:text-red-600 transition-colors">
                          Delete
                        </button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* Getting started */}
        <div className="rounded-xl border border-border bg-card p-5">
          <h2 className="text-sm font-semibold text-slate-900 mb-4">Getting Started</h2>
          <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-3">
            {[
              { n: 1, title: 'Start the server',  desc: 'Run ./scripts/dev-up.sh to launch the UI + API backend.' },
              { n: 2, title: 'Add a server',       desc: 'Go to Servers and connect a VPS via SSH to host resources.' },
              { n: 3, title: 'Deploy a project',   desc: 'Click "+ New Resource", choose your app type and repo.' },
              { n: 4, title: 'Monitor & scale',    desc: 'Track containers, set up teams, and manage deployments.' },
            ].map(({ n, title, desc }) => (
              <div key={n} className="flex gap-3 p-4 rounded-lg bg-muted/30 border border-border">
                <span className="w-6 h-6 rounded-full bg-blue-100 text-blue-700 border border-blue-200 text-xs flex items-center justify-center shrink-0 font-bold mt-0.5">
                  {n}
                </span>
                <div>
                  <p className="text-sm font-medium text-slate-900">{title}</p>
                  <p className="text-xs text-slate-600 mt-1">{desc}</p>
                </div>
              </div>
            ))}
          </div>
        </div>
      </main>
    </div>
  );
};

export default Dashboard;
