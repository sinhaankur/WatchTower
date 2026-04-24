import { useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import apiClient from '@/lib/api';
import {
  Card,
  CardContent,
} from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

type WizardData = {
  deployment_model: 'self_hosted' | 'saas';
  use_case: 'netlify_like' | 'vercel_like' | 'docker_platform';
  repo_url: string;
  repo_branch: string;
  build_command: string;
  project_name: string;
  output_dir: string;
  functions_dir: string;
  enable_functions: boolean;
  framework: string;
  enable_preview_deployments: boolean;
  dockerfile_path: string;
  exposed_port: number;
  target_nodes: string;
  custom_domain: string;
};

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

const STEP_LABELS = ['Deployment', 'App Type', 'Repository', 'Finalize'];

const SetupWizard = () => {
  const [step, setStep] = useState(1);
  const [submitting, setSubmitting] = useState(false);
  const navigate = useNavigate();

  const [data, setData] = useState<WizardData>({
    deployment_model: 'self_hosted',
    use_case: 'netlify_like',
    repo_url: '',
    repo_branch: 'main',
    build_command: 'npm ci && npm run build',
    project_name: '',
    output_dir: 'dist',
    functions_dir: 'api',
    enable_functions: false,
    framework: 'next.js',
    enable_preview_deployments: true,
    dockerfile_path: './Dockerfile',
    exposed_port: 3000,
    target_nodes: 'default',
    custom_domain: '',
  });

  const canContinue = useMemo(() => {
    if (step === 1) return Boolean(data.deployment_model);
    if (step === 2) return Boolean(data.use_case);
    if (step === 3) return data.repo_url.trim().length > 0 && data.build_command.trim().length > 0;
    return data.project_name.trim().length > 0;
  }, [data, step]);

  const setField = <K extends keyof WizardData>(key: K, value: WizardData[K]) => {
    setData((prev) => ({ ...prev, [key]: value }));
  };

  const saveLocalProject = () => {
    const existingRaw = localStorage.getItem(STORAGE_KEY);
    const existing = existingRaw ? (JSON.parse(existingRaw) as LocalProject[]) : [];
    const item: LocalProject = {
      id: crypto.randomUUID(),
      name: data.project_name,
      use_case: data.use_case,
      deployment_model: data.deployment_model,
      repo_url: data.repo_url,
      repo_branch: data.repo_branch,
      created_at: new Date().toISOString(),
    };
    localStorage.setItem(STORAGE_KEY, JSON.stringify([item, ...existing]));
  };

  const createProject = async () => {
    setSubmitting(true);
    saveLocalProject();
    try {
      await apiClient.post('/setup/wizard/complete', {
        deployment_model: data.deployment_model,
        use_case: data.use_case,
        repo_url: data.repo_url,
        repo_branch: data.repo_branch,
        build_command: data.build_command,
        project_name: data.project_name,
        output_dir: data.output_dir,
        functions_dir: data.functions_dir,
        enable_functions: data.enable_functions,
        framework: data.framework,
        enable_preview_deployments: data.enable_preview_deployments,
        dockerfile_path: data.dockerfile_path,
        exposed_port: data.exposed_port,
        target_nodes: data.target_nodes,
        custom_domain: data.custom_domain || undefined,
      });
    } catch {
      // Local-first: dashboard works even if backend isn't fully configured yet.
    }
    setSubmitting(false);
    navigate('/');
  };

  return (
    <div className="min-h-screen bg-gray-50">
      {/* Header */}
      <header className="bg-white border-b border-gray-100">
        <div className="max-w-2xl mx-auto px-6 py-5 flex items-center justify-between">
          <div>
            <h1 className="text-base font-semibold text-gray-900">New Project</h1>
            <p className="text-xs text-gray-400 mt-0.5">WatchTower Setup Wizard</p>
          </div>
          <Link to="/">
            <Button variant="outline" className="rounded-none border-gray-200 text-sm">← Cancel</Button>
          </Link>
        </div>
      </header>

      <div className="max-w-2xl mx-auto px-6 py-8">
        {/* Step progress bar */}
        <div className="mb-8">
          <div className="flex items-center gap-0">
            {STEP_LABELS.map((label, i) => {
              const idx = i + 1;
              const done = idx < step;
              const active = idx === step;
              return (
                <div key={idx} className="flex items-center flex-1 last:flex-none">
                  <div className="flex items-center gap-1.5">
                    <span className={`w-6 h-6 rounded-full flex items-center justify-center text-xs font-medium border transition-colors ${
                      done ? 'bg-gray-900 border-gray-900 text-white' :
                      active ? 'border-gray-900 text-gray-900' :
                      'border-gray-300 text-gray-400'
                    }`}>
                      {done ? '✓' : idx}
                    </span>
                    <span className={`text-xs font-medium hidden sm:block ${active ? 'text-gray-900' : done ? 'text-gray-500' : 'text-gray-300'}`}>
                      {label}
                    </span>
                  </div>
                  {i < STEP_LABELS.length - 1 && (
                    <div className={`flex-1 h-px mx-2 transition-colors ${done ? 'bg-gray-900' : 'bg-gray-200'}`} />
                  )}
                </div>
              );
            })}
          </div>
        </div>

        {/* Step 1 — Deployment Model */}
        {step === 1 && (
          <div>
            <h2 className="text-lg font-semibold text-gray-900 mb-1">Where will you deploy?</h2>
            <p className="text-sm text-gray-500 mb-6">Choose how WatchTower manages your infrastructure.</p>
            <div className="space-y-3">
              {([
                { value: 'self_hosted', title: 'Self-Hosted', desc: 'Run WatchTower on your own servers. Full control, no external dependencies.', icon: '🏠' },
                { value: 'saas', title: 'SaaS (Cloud-managed)', desc: 'Use cloud-managed infrastructure. Easier setup, handled for you.', icon: '☁️' },
              ] as const).map((opt) => (
                <label key={opt.value}
                  className={`flex gap-4 items-start border p-4 cursor-pointer transition-colors ${
                    data.deployment_model === opt.value ? 'border-gray-900 bg-gray-50' : 'border-gray-200 hover:border-gray-400'
                  }`}>
                  <input type="radio" name="deployment_model" className="mt-1"
                    checked={data.deployment_model === opt.value}
                    onChange={() => setField('deployment_model', opt.value)} />
                  <div>
                    <p className="font-medium text-sm text-gray-900">{opt.icon} {opt.title}</p>
                    <p className="text-xs text-gray-500 mt-0.5">{opt.desc}</p>
                  </div>
                </label>
              ))}
            </div>
            <div className="mt-6 flex justify-end">
              <Button onClick={() => setStep(2)} disabled={!canContinue}
                className="bg-gray-900 text-white hover:bg-gray-800 rounded-none">Continue →</Button>
            </div>
          </div>
        )}

        {/* Step 2 — Use Case */}
        {step === 2 && (
          <div>
            <h2 className="text-lg font-semibold text-gray-900 mb-1">What kind of app are you deploying?</h2>
            <p className="text-sm text-gray-500 mb-6">Pick the type that best matches your project.</p>
            <div className="space-y-3">
              {([
                { value: 'netlify_like', title: 'Static Site + Functions', desc: 'HTML/CSS/JS frontend with optional serverless API functions. Like Netlify.', icon: '⚡' },
                { value: 'vercel_like', title: 'SSR / Full-Stack App', desc: 'Server-side rendered app with preview deployments per branch. Like Vercel.', icon: '▲' },
                { value: 'docker_platform', title: 'Docker Container', desc: 'Containerized app with a Dockerfile. Any language or framework.', icon: '🐳' },
              ] as const).map((opt) => (
                <label key={opt.value}
                  className={`flex gap-4 items-start border p-4 cursor-pointer transition-colors ${
                    data.use_case === opt.value ? 'border-gray-900 bg-gray-50' : 'border-gray-200 hover:border-gray-400'
                  }`}>
                  <input type="radio" name="use_case" className="mt-1"
                    checked={data.use_case === opt.value}
                    onChange={() => setField('use_case', opt.value)} />
                  <div>
                    <p className="font-medium text-sm text-gray-900">{opt.icon} {opt.title}</p>
                    <p className="text-xs text-gray-500 mt-0.5">{opt.desc}</p>
                  </div>
                </label>
              ))}
            </div>
            <div className="mt-6 flex justify-between">
              <Button variant="outline" onClick={() => setStep(1)} className="rounded-none border-gray-300">← Back</Button>
              <Button onClick={() => setStep(3)} disabled={!canContinue}
                className="bg-gray-900 text-white hover:bg-gray-800 rounded-none">Continue →</Button>
            </div>
          </div>
        )}

        {/* Step 3 — Repository */}
        {step === 3 && (
          <div>
            <h2 className="text-lg font-semibold text-gray-900 mb-1">Connect your repository</h2>
            <p className="text-sm text-gray-500 mb-6">Where is your source code? WatchTower will pull from this repo.</p>
            <div className="space-y-4">
              <div>
                <Label htmlFor="repo_url">Repository URL <span className="text-red-400">*</span></Label>
                <Input id="repo_url" value={data.repo_url}
                  onChange={(e) => setField('repo_url', e.target.value)}
                  className="mt-1.5 rounded-none border-gray-300"
                  placeholder="https://github.com/your-org/your-repo" />
                <p className="text-xs text-gray-400 mt-1">Supports GitHub, GitLab, and Bitbucket URLs.</p>
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <Label htmlFor="repo_branch">Branch</Label>
                  <Input id="repo_branch" value={data.repo_branch}
                    onChange={(e) => setField('repo_branch', e.target.value)}
                    className="mt-1.5 rounded-none border-gray-300"
                    placeholder="main" />
                </div>
                <div>
                  <Label htmlFor="build_command">Build Command <span className="text-red-400">*</span></Label>
                  <Input id="build_command" value={data.build_command}
                    onChange={(e) => setField('build_command', e.target.value)}
                    className="mt-1.5 rounded-none border-gray-300"
                    placeholder="npm ci && npm run build" />
                </div>
              </div>
            </div>
            <div className="mt-6 flex justify-between">
              <Button variant="outline" onClick={() => setStep(2)} className="rounded-none border-gray-300">← Back</Button>
              <Button onClick={() => setStep(4)} disabled={!canContinue}
                className="bg-gray-900 text-white hover:bg-gray-800 rounded-none">Continue →</Button>
            </div>
          </div>
        )}

        {/* Step 4 — Finalize */}
        {step === 4 && (
          <div>
            <h2 className="text-lg font-semibold text-gray-900 mb-1">Final configuration</h2>
            <p className="text-sm text-gray-500 mb-6">One last step — name your project and tweak the settings for your app type.</p>

            <div className="space-y-4">
              <div>
                <Label htmlFor="project_name">Project Name <span className="text-red-400">*</span></Label>
                <Input id="project_name" value={data.project_name}
                  onChange={(e) => setField('project_name', e.target.value)}
                  className="mt-1.5 rounded-none border-gray-300"
                  placeholder="my-web-app" />
                <p className="text-xs text-gray-400 mt-1">Used to identify this project in the dashboard.</p>
              </div>

              {/* Type-specific settings inside a subtle section */}
              {data.use_case === 'netlify_like' && (
                <Card className="rounded-none border-gray-100 shadow-none bg-gray-50">
                  <CardContent className="py-4 space-y-3">
                    <p className="text-xs font-medium text-gray-600 uppercase tracking-wide">Static + Functions settings</p>
                    <div className="grid grid-cols-2 gap-3">
                      <div>
                        <Label htmlFor="output_dir">Output Directory</Label>
                        <Input id="output_dir" value={data.output_dir}
                          onChange={(e) => setField('output_dir', e.target.value)}
                          className="mt-1.5 rounded-none border-gray-300" placeholder="dist" />
                      </div>
                      <div>
                        <Label htmlFor="functions_dir">Functions Directory</Label>
                        <Input id="functions_dir" value={data.functions_dir}
                          onChange={(e) => setField('functions_dir', e.target.value)}
                          className="mt-1.5 rounded-none border-gray-300" placeholder="api" />
                      </div>
                    </div>
                    <label className="flex items-center gap-2 text-sm text-gray-700 cursor-pointer">
                      <input type="checkbox" checked={data.enable_functions}
                        onChange={(e) => setField('enable_functions', e.target.checked)} />
                      Enable serverless functions
                    </label>
                  </CardContent>
                </Card>
              )}

              {data.use_case === 'vercel_like' && (
                <Card className="rounded-none border-gray-100 shadow-none bg-gray-50">
                  <CardContent className="py-4 space-y-3">
                    <p className="text-xs font-medium text-gray-600 uppercase tracking-wide">SSR App settings</p>
                    <div>
                      <Label htmlFor="framework">Framework</Label>
                      <Input id="framework" value={data.framework}
                        onChange={(e) => setField('framework', e.target.value)}
                        className="mt-1.5 rounded-none border-gray-300" placeholder="next.js" />
                    </div>
                    <label className="flex items-center gap-2 text-sm text-gray-700 cursor-pointer">
                      <input type="checkbox" checked={data.enable_preview_deployments}
                        onChange={(e) => setField('enable_preview_deployments', e.target.checked)} />
                      Enable preview deployments per branch
                    </label>
                  </CardContent>
                </Card>
              )}

              {data.use_case === 'docker_platform' && (
                <Card className="rounded-none border-gray-100 shadow-none bg-gray-50">
                  <CardContent className="py-4 space-y-3">
                    <p className="text-xs font-medium text-gray-600 uppercase tracking-wide">Docker settings</p>
                    <div className="grid grid-cols-2 gap-3">
                      <div>
                        <Label htmlFor="dockerfile_path">Dockerfile Path</Label>
                        <Input id="dockerfile_path" value={data.dockerfile_path}
                          onChange={(e) => setField('dockerfile_path', e.target.value)}
                          className="mt-1.5 rounded-none border-gray-300" placeholder="./Dockerfile" />
                      </div>
                      <div>
                        <Label htmlFor="exposed_port">Exposed Port</Label>
                        <Input id="exposed_port" type="number" value={data.exposed_port}
                          onChange={(e) => setField('exposed_port', Number(e.target.value || 3000))}
                          className="mt-1.5 rounded-none border-gray-300" />
                      </div>
                    </div>
                    <div>
                      <Label htmlFor="target_nodes">Target Nodes</Label>
                      <Input id="target_nodes" value={data.target_nodes}
                        onChange={(e) => setField('target_nodes', e.target.value)}
                        className="mt-1.5 rounded-none border-gray-300" placeholder="default or node-1,node-2" />
                      <p className="text-xs text-gray-400 mt-1">Comma-separated node names. Use "default" for primary node.</p>
                    </div>
                  </CardContent>
                </Card>
              )}

              <div>
                <Label htmlFor="custom_domain">Custom Domain <span className="text-gray-400 font-normal">(optional)</span></Label>
                <Input id="custom_domain" value={data.custom_domain}
                  onChange={(e) => setField('custom_domain', e.target.value)}
                  className="mt-1.5 rounded-none border-gray-300" placeholder="app.example.com" />
              </div>
            </div>

            {/* Summary before submit */}
            <div className="mt-5 border border-gray-100 bg-gray-50 px-4 py-3 text-xs text-gray-500 space-y-1">
              <p className="font-medium text-gray-700 text-xs mb-1">Summary</p>
              <p>Model: <span className="text-gray-900">{data.deployment_model === 'self_hosted' ? 'Self-Hosted' : 'SaaS'}</span></p>
              <p>Type: <span className="text-gray-900">{data.use_case === 'netlify_like' ? 'Static + Functions' : data.use_case === 'vercel_like' ? 'SSR App' : 'Docker'}</span></p>
              <p>Repo: <span className="text-gray-900 font-mono">{data.repo_url || '—'}</span> on <span className="text-gray-900">{data.repo_branch}</span></p>
            </div>

            <div className="mt-6 flex justify-between">
              <Button variant="outline" onClick={() => setStep(3)} className="rounded-none border-gray-300">← Back</Button>
              <Button onClick={() => void createProject()} disabled={!canContinue || submitting}
                className="bg-gray-900 text-white hover:bg-gray-800 rounded-none">
                {submitting ? 'Creating…' : '🚀 Create Project'}
              </Button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

export default SetupWizard;
