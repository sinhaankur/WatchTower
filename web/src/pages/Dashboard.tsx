import { Link } from 'react-router-dom';
import { useEffect, useMemo, useState } from 'react';
import axios from 'axios';
import apiClient from '@/lib/api';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';

type LocalProject = {
  id: string;
  name: string;
  use_case: 'netlify_like' | 'vercel_like' | 'docker_platform';
  deployment_model: 'self_hosted' | 'saas';
  repo_url: string;
  repo_branch: string;
  created_at: string;
};

const STORAGE_KEY = 'wt_projects';

const USE_CASE_META: Record<LocalProject['use_case'], { label: string; icon: string; color: string }> = {
  netlify_like: { label: 'Static + Functions', icon: '⚡', color: 'bg-blue-50 text-blue-700 border-blue-200' },
  vercel_like:  { label: 'SSR App',            icon: '▲', color: 'bg-purple-50 text-purple-700 border-purple-200' },
  docker_platform: { label: 'Docker App',      icon: '🐳', color: 'bg-cyan-50 text-cyan-700 border-cyan-200' },
};

const Dashboard = () => {
  const [projects, setProjects] = useState<LocalProject[]>([]);
  const [loading, setLoading] = useState(true);
  const [serverStatus, setServerStatus] = useState<'checking' | 'online' | 'offline'>('checking');
  const [dataSource, setDataSource] = useState<'server' | 'local'>('local');
  const [serverClock, setServerClock] = useState<string>('');
  const [deviceMode, setDeviceMode] = useState<'light' | 'dark'>('light');

  const loadLocalProjects = () => {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return;
    try {
      const parsed = JSON.parse(raw) as LocalProject[];
      setProjects(Array.isArray(parsed) ? parsed : []);
      setDataSource('local');
    } catch {
      setProjects([]);
      setDataSource('local');
    }
  };

  const loadProjects = async () => {
    setLoading(true);
    setServerStatus('checking');
    try {
      const [healthResp, projectsResp] = await Promise.all([
        apiClient.get('/health'),
        apiClient.get('/projects'),
      ]);

      if (healthResp.status >= 200 && healthResp.status < 300) {
        setServerStatus('online');
      }
      const httpDate = healthResp.headers?.date as string | undefined;
      if (httpDate) {
        setServerClock(httpDate);
      }

      const rows = (projectsResp.data as any[]) ?? [];
      const normalized = rows.map((p) => ({
        id: String(p.id),
        name: p.name ?? 'Unnamed Project',
        use_case: (p.use_case ?? 'docker_platform') as LocalProject['use_case'],
        deployment_model: (p.deployment_model ?? 'self_hosted') as LocalProject['deployment_model'],
        repo_url: p.repo_url ?? '',
        repo_branch: p.repo_branch ?? 'main',
        created_at: p.created_at ?? new Date().toISOString(),
      }));

      setProjects(normalized);
      setDataSource('server');
    } catch {
      setServerStatus('offline');
      loadLocalProjects();
    } finally {
      setLoading(false);
    }
  };

  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);

  useEffect(() => {
    void loadProjects();
  }, []);

  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const setMode = () => setDeviceMode(media.matches ? 'dark' : 'light');
    setMode();

    if (media.addEventListener) {
      media.addEventListener('change', setMode);
      return () => media.removeEventListener('change', setMode);
    }

    media.addListener(setMode);
    return () => media.removeListener(setMode);
  }, []);

  const clientTimeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const clientLocale = Intl.DateTimeFormat().resolvedOptions().locale;
  const utcOffsetMins = -new Date().getTimezoneOffset();
  const utcOffsetHours = Math.trunc(Math.abs(utcOffsetMins) / 60)
    .toString()
    .padStart(2, '0');
  const utcOffsetMinutes = (Math.abs(utcOffsetMins) % 60).toString().padStart(2, '0');
  const utcOffsetSign = utcOffsetMins >= 0 ? '+' : '-';
  const apiTarget = ((import.meta as any).env?.VITE_API_URL as string | undefined) || '/api';

  const stats = useMemo(() => ({
    staticCount: projects.filter((p) => p.use_case === 'netlify_like').length,
    ssrCount:    projects.filter((p) => p.use_case === 'vercel_like').length,
    dockerCount: projects.filter((p) => p.use_case === 'docker_platform').length,
  }), [projects]);

  const deleteProject = async (id: string) => {
    if (dataSource === 'server') {
      try {
        await apiClient.delete(`/projects/${id}`);
      } catch (error) {
        if (!axios.isAxiosError(error) || !error.response) {
          return;
        }
      }
    }

    const next = projects.filter((p) => p.id !== id);
    setProjects(next);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    setConfirmDelete(null);
  };

  const isFirstVisit = projects.length === 0;

  return (
    <div className="flex-1 overflow-auto">
      {/* Page header */}
      <header className="electron-card-solid electron-divider border-b">
        <div className="px-8 py-5 flex justify-between items-center">
          <div>
            <h1 className="text-base font-semibold">Overview</h1>
            <p className="text-xs electron-accent mt-0.5">Your projects and deployment status</p>
          </div>
          <div className="flex items-center gap-2">
            <span className={`text-xs px-2 py-1 border ${serverStatus === 'online' ? 'bg-green-50 text-green-700 border-green-200' : serverStatus === 'offline' ? 'bg-amber-50 text-amber-700 border-amber-200' : 'bg-gray-50 text-gray-500 border-gray-200'}`}>
              {serverStatus === 'online' ? 'API online' : serverStatus === 'offline' ? 'Offline mode' : 'Checking API...'}
            </span>
            <Button variant="outline" onClick={() => void loadProjects()} className="electron-button rounded-md text-xs" disabled={loading}>
              {loading ? 'Refreshing…' : 'Refresh'}
            </Button>
            <Link to="/setup">
              <Button className="electron-accent-bg rounded-md text-sm">+ New Project</Button>
            </Link>
          </div>
        </div>
      </header>

      <main className="px-8 py-6 space-y-6 max-w-5xl">

        <div className="electron-card rounded-xl p-6">
          <p className="text-xs uppercase tracking-[0.2em] electron-accent">WatchTower Desktop</p>
          <h2 className="text-2xl font-semibold mt-2">Ship from your own infrastructure with Electron-style clarity</h2>
          <p className="text-sm mt-2 text-slate-300">Monitor deployments, node health, team access, and environment context from one control surface.</p>
        </div>

        <Card className="electron-card rounded-xl shadow-none">
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Environment Context</CardTitle>
            <CardDescription>Mode and timezone details for better server location awareness</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="grid md:grid-cols-2 gap-3 text-xs">
              <div className="electron-card-solid rounded-md px-3 py-2">
                <p className="text-gray-500">Device mode</p>
                <p className="text-gray-900 font-medium mt-0.5">{deviceMode === 'dark' ? 'Dark (from OS)' : 'Light (from OS)'}</p>
              </div>
              <div className="electron-card-solid rounded-md px-3 py-2">
                <p className="text-gray-500">Client timezone</p>
                <p className="text-gray-900 font-medium mt-0.5">{clientTimeZone} (UTC{utcOffsetSign}{utcOffsetHours}:{utcOffsetMinutes})</p>
              </div>
              <div className="electron-card-solid rounded-md px-3 py-2">
                <p className="text-gray-500">Client locale</p>
                <p className="text-gray-900 font-medium mt-0.5">{clientLocale}</p>
              </div>
              <div className="electron-card-solid rounded-md px-3 py-2">
                <p className="text-gray-500">Server clock (HTTP Date)</p>
                <p className="text-gray-900 font-medium mt-0.5">{serverClock || 'Not available yet (server offline)'}</p>
              </div>
              <div className="electron-card-solid rounded-md px-3 py-2 md:col-span-2">
                <p className="text-gray-500">API target</p>
                <p className="text-gray-900 font-medium mt-0.5">{apiTarget}</p>
              </div>
            </div>
          </CardContent>
        </Card>

        {serverStatus === 'offline' && (
          <div className="border border-amber-200 bg-amber-50 px-5 py-4">
            <p className="text-sm font-medium text-amber-800">Server connection unavailable</p>
            <p className="text-xs text-amber-700 mt-1">You are viewing local project cache. Start backend at 127.0.0.1:8000 for live project data and team/node features.</p>
          </div>
        )}

        {/* Getting started banner for first-time users */}
        {isFirstVisit && (
          <div className="border border-amber-200 bg-amber-50 px-5 py-4 flex items-start gap-3">
            <span className="text-amber-500 text-lg mt-0.5">👋</span>
            <div>
              <p className="text-sm font-medium text-amber-900">Welcome to WatchTower!</p>
              <p className="text-xs text-amber-700 mt-0.5">Get started by creating your first project. The setup wizard will guide you through every step.</p>
              <Link to="/setup">
                <Button className="mt-3 electron-accent-bg rounded-md text-xs">Start Setup Wizard →</Button>
              </Link>
            </div>
          </div>
        )}

        {/* Stats row */}
        <div className="grid grid-cols-3 gap-3">
          {[
            { label: 'Static + Functions', count: stats.staticCount, icon: '⚡' },
            { label: 'SSR Apps', count: stats.ssrCount, icon: '▲' },
            { label: 'Docker Apps', count: stats.dockerCount, icon: '🐳' },
          ].map((s) => (
            <Card key={s.label} className="electron-card rounded-xl shadow-none">
              <CardContent className="py-4 flex items-center gap-3">
                <span className="text-2xl">{s.icon}</span>
                <div>
                  <p className="text-2xl font-bold text-gray-900 leading-none">{s.count}</p>
                  <p className="text-xs text-gray-500 mt-0.5">{s.label}</p>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>

        {/* Quick setup guide */}
        <Card className="electron-card rounded-xl shadow-none">
          <CardHeader className="pb-3">
            <CardTitle className="text-base">How to get started</CardTitle>
            <CardDescription>Four steps to deploy your first app</CardDescription>
          </CardHeader>
          <CardContent>
            <ol className="grid md:grid-cols-2 gap-3">
              {[
                { n: 1, title: 'Start the server', body: <>Run <code className="bg-gray-100 px-1 rounded text-xs">./scripts/dev-up.sh</code> to launch the UI + API.</> },
                { n: 2, title: 'Create a project', body: 'Click "+ New Project" and choose your deployment type and use case.' },
                { n: 3, title: 'Connect your repo', body: 'Enter your repository URL, branch, and build command.' },
                { n: 4, title: 'Deploy & monitor', body: 'Use Nodes to add servers, Team to invite collaborators.' },
              ].map(({ n, title, body }) => (
                <li key={n} className="flex gap-3 electron-card-solid rounded-md px-4 py-3">
                  <span className="w-6 h-6 rounded-full bg-gray-900 text-white text-xs flex items-center justify-center shrink-0 mt-0.5">{n}</span>
                  <div>
                    <p className="text-sm font-medium text-gray-800">{title}</p>
                    <p className="text-xs text-gray-500 mt-0.5">{body}</p>
                  </div>
                </li>
              ))}
            </ol>
          </CardContent>
        </Card>

        {/* Projects list */}
        <Card className="electron-card rounded-xl shadow-none">
          <CardHeader className="pb-3 flex flex-row items-center justify-between">
            <div>
              <CardTitle className="text-base">Your Projects</CardTitle>
              <CardDescription>
                {loading ? 'Loading projects…' : projects.length === 0 ? 'No projects yet' : `${projects.length} project${projects.length !== 1 ? 's' : ''} · ${dataSource === 'server' ? 'live data' : 'local cache'}`}
              </CardDescription>
            </div>
            {projects.length > 0 && (
              <Link to="/setup">
                <Button className="electron-accent-bg rounded-md text-xs">+ New Project</Button>
              </Link>
            )}
          </CardHeader>
          <CardContent>
            {!loading && projects.length === 0 && (
              <div className="text-center py-10 border border-dashed border-gray-200">
                <p className="text-3xl mb-2">📦</p>
                <p className="text-sm font-medium text-gray-600">No projects yet</p>
                <p className="text-xs text-gray-400 mt-1">Create a project using the Setup Wizard to get started.</p>
                <Link to="/setup">
                  <Button className="mt-4 electron-accent-bg rounded-md text-sm">Start Setup Wizard →</Button>
                </Link>
              </div>
            )}

            <div className="space-y-2">
              {projects.map((project) => {
                const meta = USE_CASE_META[project.use_case];
                return (
                  <div key={project.id} className="electron-card-solid rounded-md px-4 py-3 flex items-center justify-between gap-4">
                    <div className="flex items-center gap-3 min-w-0">
                      <span className="text-xl">{meta.icon}</span>
                      <div className="min-w-0">
                        <p className="text-sm font-semibold text-gray-900 truncate">{project.name}</p>
                        <div className="flex items-center gap-2 mt-0.5 flex-wrap">
                          <span className={`text-xs px-2 py-0.5 border rounded-full ${meta.color}`}>{meta.label}</span>
                          <span className="text-xs text-gray-400">{project.deployment_model === 'self_hosted' ? 'Self-hosted' : 'SaaS'}</span>
                          <span className="text-xs font-mono text-gray-400">{project.repo_branch}</span>
                        </div>
                      </div>
                    </div>

                    <div className="flex items-center gap-2 shrink-0">
                      {project.repo_url && (
                        <a href={project.repo_url} target="_blank" rel="noreferrer"
                          className="text-xs text-gray-500 hover:text-gray-700 underline">
                          Repo ↗
                        </a>
                      )}
                      {confirmDelete === project.id ? (
                        <div className="flex items-center gap-1">
                          <span className="text-xs text-gray-500">Delete?</span>
                          <Button
                            variant="outline"
                            className="rounded-md border-red-300 text-red-600 text-xs px-2 py-1 h-auto hover:bg-red-50"
                            onClick={() => void deleteProject(project.id)}
                          >
                            Yes
                          </Button>
                          <Button
                            variant="outline"
                            className="rounded-md border-gray-300 text-xs px-2 py-1 h-auto"
                            onClick={() => setConfirmDelete(null)}
                          >
                            No
                          </Button>
                        </div>
                      ) : (
                        <Button
                          variant="outline"
                          className="rounded-md border-gray-300 text-gray-500 text-xs hover:border-red-300 hover:text-red-600"
                          onClick={() => setConfirmDelete(project.id)}
                        >
                          Delete
                        </Button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </CardContent>
        </Card>
      </main>
    </div>
  );
};

export default Dashboard;
