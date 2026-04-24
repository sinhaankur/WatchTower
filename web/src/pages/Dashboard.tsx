import { Link } from 'react-router-dom';
import { useMemo, useState } from 'react';
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
  const [projects, setProjects] = useState<LocalProject[]>(() => {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    try {
      const parsed = JSON.parse(raw) as LocalProject[];
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  });

  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);

  const stats = useMemo(() => ({
    staticCount: projects.filter((p) => p.use_case === 'netlify_like').length,
    ssrCount:    projects.filter((p) => p.use_case === 'vercel_like').length,
    dockerCount: projects.filter((p) => p.use_case === 'docker_platform').length,
  }), [projects]);

  const deleteProject = (id: string) => {
    const next = projects.filter((p) => p.id !== id);
    setProjects(next);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    setConfirmDelete(null);
  };

  const isFirstVisit = projects.length === 0;

  return (
    <div className="min-h-screen bg-gray-50">
      <header className="bg-white border-b border-gray-100">
        <div className="max-w-5xl mx-auto px-6 py-5 flex justify-between items-center">
          <div>
            <h1 className="text-xl font-semibold text-gray-900">WatchTower</h1>
            <p className="text-xs text-gray-400 mt-0.5">Self-hosted deploy platform</p>
          </div>
          <nav className="flex items-center gap-2">
            <Link to="/team">
              <Button variant="outline" className="rounded-none border-gray-200 text-sm">👥 Team</Button>
            </Link>
            <Link to="/nodes">
              <Button variant="outline" className="rounded-none border-gray-200 text-sm">🖥 Nodes</Button>
            </Link>
            <Link to="/setup">
              <Button className="bg-gray-900 text-white hover:bg-gray-800 rounded-none text-sm">+ New Project</Button>
            </Link>
          </nav>
        </div>
      </header>

      <main className="max-w-5xl mx-auto px-6 py-8 space-y-6">

        {/* Getting started banner for first-time users */}
        {isFirstVisit && (
          <div className="border border-amber-200 bg-amber-50 px-5 py-4 flex items-start gap-3">
            <span className="text-amber-500 text-lg mt-0.5">👋</span>
            <div>
              <p className="text-sm font-medium text-amber-900">Welcome to WatchTower!</p>
              <p className="text-xs text-amber-700 mt-0.5">Get started by creating your first project. The setup wizard will guide you through every step.</p>
              <Link to="/setup">
                <Button className="mt-3 bg-gray-900 text-white hover:bg-gray-800 rounded-none text-xs">Start Setup Wizard →</Button>
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
            <Card key={s.label} className="rounded-none border-gray-200 shadow-none bg-white">
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
        <Card className="rounded-none border-gray-200 shadow-none bg-white">
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
                <li key={n} className="flex gap-3 border border-gray-100 bg-gray-50 px-4 py-3">
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
        <Card className="rounded-none border-gray-200 shadow-none bg-white">
          <CardHeader className="pb-3 flex flex-row items-center justify-between">
            <div>
              <CardTitle className="text-base">Your Projects</CardTitle>
              <CardDescription>{projects.length === 0 ? 'No projects yet' : `${projects.length} project${projects.length !== 1 ? 's' : ''}`}</CardDescription>
            </div>
            {projects.length > 0 && (
              <Link to="/setup">
                <Button className="bg-gray-900 text-white hover:bg-gray-800 rounded-none text-xs">+ New Project</Button>
              </Link>
            )}
          </CardHeader>
          <CardContent>
            {projects.length === 0 && (
              <div className="text-center py-10 border border-dashed border-gray-200">
                <p className="text-3xl mb-2">📦</p>
                <p className="text-sm font-medium text-gray-600">No projects yet</p>
                <p className="text-xs text-gray-400 mt-1">Create a project using the Setup Wizard to get started.</p>
                <Link to="/setup">
                  <Button className="mt-4 bg-gray-900 text-white hover:bg-gray-800 rounded-none text-sm">Start Setup Wizard →</Button>
                </Link>
              </div>
            )}

            <div className="space-y-2">
              {projects.map((project) => {
                const meta = USE_CASE_META[project.use_case];
                return (
                  <div key={project.id} className="border border-gray-200 bg-gray-50 px-4 py-3 flex items-center justify-between gap-4">
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
                            className="rounded-none border-red-300 text-red-600 text-xs px-2 py-1 h-auto hover:bg-red-50"
                            onClick={() => deleteProject(project.id)}
                          >
                            Yes
                          </Button>
                          <Button
                            variant="outline"
                            className="rounded-none border-gray-300 text-xs px-2 py-1 h-auto"
                            onClick={() => setConfirmDelete(null)}
                          >
                            No
                          </Button>
                        </div>
                      ) : (
                        <Button
                          variant="outline"
                          className="rounded-none border-gray-300 text-gray-500 text-xs hover:border-red-300 hover:text-red-600"
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
