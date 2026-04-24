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

const Dashboard = () => {
  const [projects, setProjects] = useState<LocalProject[]>(() => {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      return [];
    }

    try {
      const parsed = JSON.parse(raw) as LocalProject[];
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  });

  const stats = useMemo(() => {
    const staticCount = projects.filter((p) => p.use_case === 'netlify_like').length;
    const ssrCount = projects.filter((p) => p.use_case === 'vercel_like').length;
    const dockerCount = projects.filter((p) => p.use_case === 'docker_platform').length;
    return { staticCount, ssrCount, dockerCount };
  }, [projects]);

  const deleteProject = (id: string) => {
    const next = projects.filter((p) => p.id !== id);
    setProjects(next);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  };

  const getUseCaseLabel = (useCase: LocalProject['use_case']) => {
    if (useCase === 'netlify_like') {
      return 'Static + Functions';
    }
    if (useCase === 'vercel_like') {
      return 'SSR App';
    }
    return 'Docker App';
  };

  return (
    <div className="min-h-screen bg-white">
      <header className="border-b border-gray-100">
        <div className="max-w-5xl mx-auto px-6 py-10">
          <div className="flex justify-between items-center">
            <div>
              <h1 className="text-3xl font-semibold tracking-wide text-gray-900">WatchTower</h1>
              <p className="text-sm text-gray-500 mt-1">Simple deploy platform setup and project control.</p>
            </div>
            <div className="flex items-center gap-2">
              <Link to="/team">
                <Button variant="outline" className="rounded-none border-gray-300">Team</Button>
              </Link>
              <Link to="/nodes">
                <Button variant="outline" className="rounded-none border-gray-300">Nodes</Button>
              </Link>
              <Link to="/setup">
                <Button className="bg-gray-900 text-white hover:bg-gray-800 rounded-none">Create Project</Button>
              </Link>
            </div>
          </div>
        </div>
      </header>

      <main className="max-w-5xl mx-auto px-6 py-10 space-y-8">
        <div className="grid grid-cols-3 gap-4">
          <Card className="rounded-none border-gray-200 shadow-none">
            <CardHeader>
              <CardTitle className="text-lg">Static</CardTitle>
              <CardDescription>{stats.staticCount} project(s)</CardDescription>
            </CardHeader>
          </Card>
          <Card className="rounded-none border-gray-200 shadow-none">
            <CardHeader>
              <CardTitle className="text-lg">SSR</CardTitle>
              <CardDescription>{stats.ssrCount} project(s)</CardDescription>
            </CardHeader>
          </Card>
          <Card className="rounded-none border-gray-200 shadow-none">
            <CardHeader>
              <CardTitle className="text-lg">Docker</CardTitle>
              <CardDescription>{stats.dockerCount} project(s)</CardDescription>
            </CardHeader>
          </Card>
        </div>

        <Card className="rounded-none border-gray-200 shadow-none">
          <CardHeader>
            <CardTitle className="text-xl">Step-by-Step Install & Setup</CardTitle>
            <CardDescription>Follow these steps for first-time users.</CardDescription>
          </CardHeader>
          <CardContent>
            <ol className="grid md:grid-cols-2 gap-4 text-sm text-gray-700">
              <li className="border border-gray-200 p-4">
                <p className="font-semibold mb-1">1. Start Services</p>
                <p>Run <code>./scripts/dev-up.sh</code> to launch UI + API.</p>
              </li>
              <li className="border border-gray-200 p-4">
                <p className="font-semibold mb-1">2. Open Setup Wizard</p>
                <p>Click Create Project and choose deployment model + use case.</p>
              </li>
              <li className="border border-gray-200 p-4">
                <p className="font-semibold mb-1">3. Connect Repository</p>
                <p>Enter repository URL, branch, and build command.</p>
              </li>
              <li className="border border-gray-200 p-4">
                <p className="font-semibold mb-1">4. Manage Projects</p>
                <p>Create, review, and delete projects from this dashboard.</p>
              </li>
            </ol>
          </CardContent>
        </Card>

        <Card className="rounded-none border-gray-200 shadow-none">
          <CardHeader>
            <CardTitle className="text-xl">Project Management</CardTitle>
            <CardDescription>Manage created projects, including delete operations.</CardDescription>
          </CardHeader>
          <CardContent>
            {projects.length === 0 && (
              <div className="text-center py-8 border border-dashed border-gray-300">
                <p className="text-gray-500 mb-4">No projects yet.</p>
                <Link to="/setup">
                  <Button className="bg-gray-900 text-white hover:bg-gray-800 rounded-none">Start Setup Wizard</Button>
                </Link>
              </div>
            )}

            {projects.length > 0 && (
              <div className="space-y-3">
                {projects.map((project) => (
                  <div key={project.id} className="border border-gray-200 p-4 flex items-center justify-between gap-4">
                    <div>
                      <p className="text-sm font-semibold text-gray-900">{project.name}</p>
                      <p className="text-xs text-gray-500 mt-1">
                        {getUseCaseLabel(project.use_case)} · {project.deployment_model === 'self_hosted' ? 'Self-hosted' : 'SaaS'} · {project.repo_branch}
                      </p>
                    </div>
                    <div className="flex items-center gap-2">
                      <a href={project.repo_url} target="_blank" rel="noreferrer" className="text-xs text-gray-600 underline">
                        Repo
                      </a>
                      <Button
                        variant="outline"
                        className="rounded-none border-gray-300 text-gray-700 hover:bg-gray-50"
                        onClick={() => deleteProject(project.id)}
                      >
                        Delete
                      </Button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      </main>
    </div>
  );
};

export default Dashboard;
