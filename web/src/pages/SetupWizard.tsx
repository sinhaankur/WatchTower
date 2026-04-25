import { useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import apiClient from '@/lib/api';
import { Card, CardContent } from '@/components/ui/card';
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

  const nextSteps = useMemo(() => {
    const steps: string[] = [];

    if (data.deployment_model === 'self_hosted') {
      steps.push('Add at least one Infrastructure node before your first deployment.');
    } else {
      steps.push('Confirm your SaaS limits and branch preview retention policy.');
    }

    if (data.use_case === 'netlify_like') {
      steps.push('Check static output and functions folders for build consistency.');
    } else if (data.use_case === 'vercel_like') {
      steps.push('Connect GitHub in Team for branch-based preview deployments.');
    } else {
      steps.push('Verify Dockerfile path and exposed port map correctly to container runtime.');
    }

    steps.push('Create project and trigger first deployment from Overview.');
    steps.push('Add custom domain and TLS after first healthy deploy.');
    return steps;
  }, [data.deployment_model, data.use_case]);

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
      // Local-first mode keeps setup usable while backend is unavailable.
    }
    setSubmitting(false);
    navigate('/');
  };

  return (
    <div className="min-h-screen">
      <header className="electron-card-solid electron-divider border-b">
        <div className="max-w-6xl mx-auto px-6 py-5 flex items-center justify-between">
          <div>
            <p className="text-[11px] uppercase tracking-[0.16em] electron-accent">Project Setup</p>
            <h1 className="text-lg font-semibold">Create New Project</h1>
          </div>
          <Link to="/">
            <Button variant="outline" className="electron-button rounded-md text-sm">Cancel</Button>
          </Link>
        </div>
      </header>

      <div className="max-w-6xl mx-auto px-6 py-8 grid lg:grid-cols-3 gap-6">
        <section className="lg:col-span-2 space-y-4">
          <div className="electron-card rounded-xl px-4 py-3">
            <div className="flex items-center gap-0">
              {STEP_LABELS.map((label, i) => {
                const idx = i + 1;
                const done = idx < step;
                const active = idx === step;
                return (
                  <div key={idx} className="flex items-center flex-1 last:flex-none">
                    <div className="flex items-center gap-1.5">
                      <span
                        className={`w-6 h-6 rounded-full flex items-center justify-center text-xs font-medium border ${
                          done
                            ? 'electron-accent-bg border-transparent'
                            : active
                              ? 'border-sky-300 text-sky-200'
                              : 'border-slate-600 text-slate-400'
                        }`}
                      >
                        {done ? 'OK' : idx}
                      </span>
                      <span className={`text-xs hidden sm:block ${active ? 'text-sky-100' : 'text-slate-400'}`}>{label}</span>
                    </div>
                    {i < STEP_LABELS.length - 1 && <div className={`flex-1 h-px mx-2 ${done ? 'bg-sky-300/60' : 'bg-slate-700'}`} />}
                  </div>
                );
              })}
            </div>
          </div>

          {step === 1 && (
            <div className="electron-card rounded-xl p-6">
              <h2 className="text-lg font-semibold">Where will you deploy?</h2>
              <p className="text-sm text-slate-300 mb-6">Select runtime ownership mode.</p>
              <div className="space-y-3">
                {([
                  { value: 'self_hosted', title: 'Self-Hosted', desc: 'Run WatchTower on your own servers.' },
                  { value: 'saas', title: 'SaaS', desc: 'Use managed cloud runtime.' },
                ] as const).map((opt) => (
                  <label key={opt.value} className={`flex gap-4 items-start border rounded-md p-4 cursor-pointer ${data.deployment_model === opt.value ? 'border-sky-300 bg-sky-900/20' : 'border-slate-700 bg-slate-900/30 hover:border-sky-500/40'}`}>
                    <input type="radio" name="deployment_model" className="mt-1" checked={data.deployment_model === opt.value} onChange={() => setField('deployment_model', opt.value)} />
                    <div>
                      <p className="font-medium text-sm">{opt.title}</p>
                      <p className="text-xs text-slate-300 mt-0.5">{opt.desc}</p>
                    </div>
                  </label>
                ))}
              </div>
              <div className="mt-6 flex justify-end">
                <Button onClick={() => setStep(2)} disabled={!canContinue} className="electron-accent-bg rounded-md">Continue</Button>
              </div>
            </div>
          )}

          {step === 2 && (
            <div className="electron-card rounded-xl p-6">
              <h2 className="text-lg font-semibold">Choose application type</h2>
              <p className="text-sm text-slate-300 mb-6">Pick workflow template.</p>
              <div className="space-y-3">
                {([
                  { value: 'netlify_like', title: 'Static + Functions', desc: 'Static frontend with optional API functions.' },
                  { value: 'vercel_like', title: 'SSR / Full-Stack', desc: 'Branch previews and server rendering.' },
                  { value: 'docker_platform', title: 'Docker Platform', desc: 'Containerized app runtime.' },
                ] as const).map((opt) => (
                  <label key={opt.value} className={`flex gap-4 items-start border rounded-md p-4 cursor-pointer ${data.use_case === opt.value ? 'border-sky-300 bg-sky-900/20' : 'border-slate-700 bg-slate-900/30 hover:border-sky-500/40'}`}>
                    <input type="radio" name="use_case" className="mt-1" checked={data.use_case === opt.value} onChange={() => setField('use_case', opt.value)} />
                    <div>
                      <p className="font-medium text-sm">{opt.title}</p>
                      <p className="text-xs text-slate-300 mt-0.5">{opt.desc}</p>
                    </div>
                  </label>
                ))}
              </div>
              <div className="mt-6 flex justify-between">
                <Button variant="outline" onClick={() => setStep(1)} className="electron-button rounded-md">Back</Button>
                <Button onClick={() => setStep(3)} disabled={!canContinue} className="electron-accent-bg rounded-md">Continue</Button>
              </div>
            </div>
          )}

          {step === 3 && (
            <div className="electron-card rounded-xl p-6">
              <h2 className="text-lg font-semibold">Connect repository</h2>
              <p className="text-sm text-slate-300 mb-6">Provide source and build command.</p>
              <div className="space-y-4">
                <div>
                  <Label htmlFor="repo_url">Repository URL *</Label>
                  <Input id="repo_url" value={data.repo_url} onChange={(e) => setField('repo_url', e.target.value)} className="mt-1.5 rounded-md border-slate-600 bg-slate-950/45" placeholder="https://github.com/owner/repo" />
                </div>
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <Label htmlFor="repo_branch">Branch</Label>
                    <Input id="repo_branch" value={data.repo_branch} onChange={(e) => setField('repo_branch', e.target.value)} className="mt-1.5 rounded-md border-slate-600 bg-slate-950/45" />
                  </div>
                  <div>
                    <Label htmlFor="build_command">Build Command *</Label>
                    <Input id="build_command" value={data.build_command} onChange={(e) => setField('build_command', e.target.value)} className="mt-1.5 rounded-md border-slate-600 bg-slate-950/45" />
                  </div>
                </div>
              </div>
              <div className="mt-6 flex justify-between">
                <Button variant="outline" onClick={() => setStep(2)} className="electron-button rounded-md">Back</Button>
                <Button onClick={() => setStep(4)} disabled={!canContinue} className="electron-accent-bg rounded-md">Continue</Button>
              </div>
            </div>
          )}

          {step === 4 && (
            <div className="electron-card rounded-xl p-6">
              <h2 className="text-lg font-semibold">Finalize configuration</h2>
              <p className="text-sm text-slate-300 mb-6">Set project identity and runtime options.</p>
              <div className="space-y-4">
                <div>
                  <Label htmlFor="project_name">Project Name *</Label>
                  <Input id="project_name" value={data.project_name} onChange={(e) => setField('project_name', e.target.value)} className="mt-1.5 rounded-md border-slate-600 bg-slate-950/45" placeholder="my-web-app" />
                </div>

                {data.use_case === 'netlify_like' && (
                  <Card className="electron-card-solid rounded-md shadow-none">
                    <CardContent className="py-4 space-y-3">
                      <p className="text-xs font-medium uppercase tracking-wide electron-accent">Static + Functions</p>
                      <div className="grid grid-cols-2 gap-3">
                        <div>
                          <Label htmlFor="output_dir">Output Directory</Label>
                          <Input id="output_dir" value={data.output_dir} onChange={(e) => setField('output_dir', e.target.value)} className="mt-1.5 rounded-md border-slate-600 bg-slate-950/45" />
                        </div>
                        <div>
                          <Label htmlFor="functions_dir">Functions Directory</Label>
                          <Input id="functions_dir" value={data.functions_dir} onChange={(e) => setField('functions_dir', e.target.value)} className="mt-1.5 rounded-md border-slate-600 bg-slate-950/45" />
                        </div>
                      </div>
                    </CardContent>
                  </Card>
                )}

                {data.use_case === 'vercel_like' && (
                  <Card className="electron-card-solid rounded-md shadow-none">
                    <CardContent className="py-4 space-y-3">
                      <p className="text-xs font-medium uppercase tracking-wide electron-accent">SSR Runtime</p>
                      <div>
                        <Label htmlFor="framework">Framework</Label>
                        <Input id="framework" value={data.framework} onChange={(e) => setField('framework', e.target.value)} className="mt-1.5 rounded-md border-slate-600 bg-slate-950/45" />
                      </div>
                    </CardContent>
                  </Card>
                )}

                {data.use_case === 'docker_platform' && (
                  <Card className="electron-card-solid rounded-md shadow-none">
                    <CardContent className="py-4 space-y-3">
                      <p className="text-xs font-medium uppercase tracking-wide electron-accent">Container Runtime</p>
                      <div className="grid grid-cols-2 gap-3">
                        <div>
                          <Label htmlFor="dockerfile_path">Dockerfile Path</Label>
                          <Input id="dockerfile_path" value={data.dockerfile_path} onChange={(e) => setField('dockerfile_path', e.target.value)} className="mt-1.5 rounded-md border-slate-600 bg-slate-950/45" />
                        </div>
                        <div>
                          <Label htmlFor="exposed_port">Exposed Port</Label>
                          <Input id="exposed_port" type="number" value={data.exposed_port} onChange={(e) => setField('exposed_port', Number(e.target.value || 3000))} className="mt-1.5 rounded-md border-slate-600 bg-slate-950/45" />
                        </div>
                      </div>
                    </CardContent>
                  </Card>
                )}

                <div>
                  <Label htmlFor="custom_domain">Custom Domain (optional)</Label>
                  <Input id="custom_domain" value={data.custom_domain} onChange={(e) => setField('custom_domain', e.target.value)} className="mt-1.5 rounded-md border-slate-600 bg-slate-950/45" placeholder="app.example.com" />
                </div>
              </div>

              <div className="mt-6 flex justify-between">
                <Button variant="outline" onClick={() => setStep(3)} className="electron-button rounded-md">Back</Button>
                <Button onClick={() => void createProject()} disabled={!canContinue || submitting} className="electron-accent-bg rounded-md">
                  {submitting ? 'Creating...' : 'Create Project'}
                </Button>
              </div>
            </div>
          )}
        </section>

        <aside className="space-y-4">
          <Card className="electron-card rounded-xl shadow-none">
            <CardContent className="py-4">
              <p className="text-xs font-semibold uppercase tracking-[0.16em] electron-accent">Next Steps</p>
              <ol className="mt-3 space-y-2">
                {nextSteps.map((item, idx) => (
                  <li key={item} className="flex gap-2 text-xs text-slate-300">
                    <span className="w-5 h-5 rounded-full electron-accent-bg flex items-center justify-center text-[10px] shrink-0">{idx + 1}</span>
                    <span>{item}</span>
                  </li>
                ))}
              </ol>
            </CardContent>
          </Card>

          <Card className="electron-card rounded-xl shadow-none">
            <CardContent className="py-4">
              <p className="text-xs font-semibold uppercase tracking-[0.16em] electron-accent">Current Selection</p>
              <div className="mt-2 text-xs text-slate-300 space-y-1">
                <p>Mode: <span className="text-sky-100">{data.deployment_model === 'self_hosted' ? 'Self-Hosted' : 'SaaS'}</span></p>
                <p>App Type: <span className="text-sky-100">{data.use_case}</span></p>
                <p>Branch: <span className="text-sky-100">{data.repo_branch || 'main'}</span></p>
              </div>
            </CardContent>
          </Card>
        </aside>
      </div>
    </div>
  );
};

export default SetupWizard;
