import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import apiClient from '@/lib/api';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
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
    if (step === 1) {
      return Boolean(data.deployment_model);
    }
    if (step === 2) {
      return Boolean(data.use_case);
    }
    if (step === 3) {
      return data.repo_url.trim().length > 0 && data.build_command.trim().length > 0;
    }
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

    const next = [item, ...existing];
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  };

  const createProject = async () => {
    setSubmitting(true);

    const payload = {
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
    };

    saveLocalProject();

    try {
      await apiClient.post('/setup/wizard/complete', payload);
    } catch {
      // Local-first flow: dashboard still works if backend auth is not fully configured.
    }

    setSubmitting(false);
    navigate('/');
  };

  return (
    <div className="min-h-screen bg-white">
      <div className="max-w-3xl mx-auto px-6 py-10">
        <div className="text-center mb-10">
          <h1 className="text-3xl font-semibold text-gray-900 tracking-wide">WatchTower Setup</h1>
          <p className="text-sm text-gray-500 mt-2">Step-by-step project installation and configuration.</p>
        </div>

        <div className="flex justify-between mb-8">
          {[1, 2, 3, 4].map((idx) => (
            <div key={idx} className="flex items-center">
              <div
                className={`w-10 h-10 rounded-full flex items-center justify-center font-bold ${
                  idx <= step ? 'bg-gray-900 text-white' : 'bg-gray-100 text-gray-500'
                }`}
              >
                {idx}
              </div>
              {idx < 4 && <div className="w-12 h-px mx-2 bg-gray-200" />}
            </div>
          ))}
        </div>

        <div className="flex justify-between mb-8">
          {[1, 2, 3, 4].map((idx) => (
            <div
              key={idx}
              className={`h-2 flex-1 mr-2 last:mr-0 ${idx <= step ? 'bg-gray-900' : 'bg-gray-200'}`}
            />
          ))}
        </div>

        {step === 1 && (
          <Card className="rounded-none border-gray-200 shadow-none">
            <CardHeader>
              <CardTitle>Choose Deployment Model</CardTitle>
              <CardDescription>How do you want to deploy?</CardDescription>
            </CardHeader>
            <CardContent>
              <div className="space-y-4">
                <label className="flex gap-3 items-center border border-gray-200 p-4 cursor-pointer">
                  <input
                    type="radio"
                    name="deployment_model"
                    checked={data.deployment_model === 'self_hosted'}
                    onChange={() => setField('deployment_model', 'self_hosted')}
                  />
                  <div>
                    <p className="font-semibold text-sm">Self-Hosted</p>
                    <p className="text-xs text-gray-500">Run WatchTower on your infrastructure.</p>
                  </div>
                </label>
                <label className="flex gap-3 items-center border border-gray-200 p-4 cursor-pointer">
                  <input
                    type="radio"
                    name="deployment_model"
                    checked={data.deployment_model === 'saas'}
                    onChange={() => setField('deployment_model', 'saas')}
                  />
                  <div>
                    <p className="font-semibold text-sm">SaaS</p>
                    <p className="text-xs text-gray-500">Use cloud-managed infrastructure.</p>
                  </div>
                </label>
              </div>
              <Button
                type="button"
                className="w-full mt-6 bg-gray-900 text-white hover:bg-gray-800 rounded-none"
                disabled={!canContinue}
                onClick={() => setStep(2)}
              >
                Continue
              </Button>
            </CardContent>
          </Card>
        )}

        {step === 2 && (
          <Card className="rounded-none border-gray-200 shadow-none">
            <CardHeader>
              <CardTitle>Choose Use Case</CardTitle>
              <CardDescription>What kind of app are you deploying?</CardDescription>
            </CardHeader>
            <CardContent>
              <div className="space-y-4">
                <label className="flex gap-3 items-center border border-gray-200 p-4 cursor-pointer">
                  <input
                    type="radio"
                    name="use_case"
                    checked={data.use_case === 'netlify_like'}
                    onChange={() => setField('use_case', 'netlify_like')}
                  />
                  <div>
                    <p className="font-semibold text-sm">Static + Functions</p>
                    <p className="text-xs text-gray-500">Netlify-like workflows.</p>
                  </div>
                </label>
                <label className="flex gap-3 items-center border border-gray-200 p-4 cursor-pointer">
                  <input
                    type="radio"
                    name="use_case"
                    checked={data.use_case === 'vercel_like'}
                    onChange={() => setField('use_case', 'vercel_like')}
                  />
                  <div>
                    <p className="font-semibold text-sm">SSR Application</p>
                    <p className="text-xs text-gray-500">Vercel-like previews and runtime behavior.</p>
                  </div>
                </label>
                <label className="flex gap-3 items-center border border-gray-200 p-4 cursor-pointer">
                  <input
                    type="radio"
                    name="use_case"
                    checked={data.use_case === 'docker_platform'}
                    onChange={() => setField('use_case', 'docker_platform')}
                  />
                  <div>
                    <p className="font-semibold text-sm">Docker Platform</p>
                    <p className="text-xs text-gray-500">Containerized app deployment.</p>
                  </div>
                </label>
              </div>
              <div className="flex gap-3 mt-6">
                <Button
                  type="button"
                  variant="outline"
                  className="flex-1 rounded-none border-gray-300"
                  onClick={() => setStep(1)}
                >
                  Back
                </Button>
                <Button
                  type="button"
                  className="flex-1 bg-gray-900 text-white hover:bg-gray-800 rounded-none"
                  disabled={!canContinue}
                  onClick={() => setStep(3)}
                >
                  Continue
                </Button>
              </div>
            </CardContent>
          </Card>
        )}

        {step === 3 && (
          <Card className="rounded-none border-gray-200 shadow-none">
            <CardHeader>
              <CardTitle>Connect Repository</CardTitle>
              <CardDescription>Repository and build settings.</CardDescription>
            </CardHeader>
            <CardContent>
              <div className="space-y-5">
                <div>
                  <Label htmlFor="repo_url">Repository URL</Label>
                  <Input
                    id="repo_url"
                    value={data.repo_url}
                    onChange={(e) => setField('repo_url', e.target.value)}
                    className="mt-2 rounded-none border-gray-300"
                    placeholder="https://github.com/owner/repo"
                  />
                </div>
                <div>
                  <Label htmlFor="repo_branch">Branch</Label>
                  <Input
                    id="repo_branch"
                    value={data.repo_branch}
                    onChange={(e) => setField('repo_branch', e.target.value)}
                    className="mt-2 rounded-none border-gray-300"
                  />
                </div>
                <div>
                  <Label htmlFor="build_command">Build Command</Label>
                  <Input
                    id="build_command"
                    value={data.build_command}
                    onChange={(e) => setField('build_command', e.target.value)}
                    className="mt-2 rounded-none border-gray-300"
                  />
                </div>
              </div>
              <div className="flex gap-3 mt-6">
                <Button
                  type="button"
                  variant="outline"
                  className="flex-1 rounded-none border-gray-300"
                  onClick={() => setStep(2)}
                >
                  Back
                </Button>
                <Button
                  type="button"
                  className="flex-1 bg-gray-900 text-white hover:bg-gray-800 rounded-none"
                  disabled={!canContinue}
                  onClick={() => setStep(4)}
                >
                  Continue
                </Button>
              </div>
            </CardContent>
          </Card>
        )}

        {step === 4 && (
          <Card className="rounded-none border-gray-200 shadow-none">
            <CardHeader>
              <CardTitle>Finalize Configuration</CardTitle>
              <CardDescription>Last step before creating your project.</CardDescription>
            </CardHeader>
            <CardContent>
              <div className="space-y-5">
                <div>
                  <Label htmlFor="project_name">Project Name</Label>
                  <Input
                    id="project_name"
                    value={data.project_name}
                    onChange={(e) => setField('project_name', e.target.value)}
                    className="mt-2 rounded-none border-gray-300"
                    placeholder="my-web-app"
                  />
                </div>

                {data.use_case === 'netlify_like' && (
                  <>
                    <div>
                      <Label htmlFor="output_dir">Output Directory</Label>
                      <Input
                        id="output_dir"
                        value={data.output_dir}
                        onChange={(e) => setField('output_dir', e.target.value)}
                        className="mt-2 rounded-none border-gray-300"
                      />
                    </div>
                    <div>
                      <Label htmlFor="functions_dir">Functions Directory</Label>
                      <Input
                        id="functions_dir"
                        value={data.functions_dir}
                        onChange={(e) => setField('functions_dir', e.target.value)}
                        className="mt-2 rounded-none border-gray-300"
                      />
                    </div>
                    <label className="flex items-center gap-2 text-sm text-gray-700">
                      <input
                        type="checkbox"
                        checked={data.enable_functions}
                        onChange={(e) => setField('enable_functions', e.target.checked)}
                      />
                      Enable functions
                    </label>
                  </>
                )}

                {data.use_case === 'vercel_like' && (
                  <>
                    <div>
                      <Label htmlFor="framework">Framework</Label>
                      <Input
                        id="framework"
                        value={data.framework}
                        onChange={(e) => setField('framework', e.target.value)}
                        className="mt-2 rounded-none border-gray-300"
                      />
                    </div>
                    <label className="flex items-center gap-2 text-sm text-gray-700">
                      <input
                        type="checkbox"
                        checked={data.enable_preview_deployments}
                        onChange={(e) => setField('enable_preview_deployments', e.target.checked)}
                      />
                      Enable preview deployments
                    </label>
                  </>
                )}

                {data.use_case === 'docker_platform' && (
                  <>
                    <div>
                      <Label htmlFor="dockerfile_path">Dockerfile Path</Label>
                      <Input
                        id="dockerfile_path"
                        value={data.dockerfile_path}
                        onChange={(e) => setField('dockerfile_path', e.target.value)}
                        className="mt-2 rounded-none border-gray-300"
                      />
                    </div>
                    <div>
                      <Label htmlFor="exposed_port">Exposed Port</Label>
                      <Input
                        id="exposed_port"
                        type="number"
                        value={data.exposed_port}
                        onChange={(e) => setField('exposed_port', Number(e.target.value || 3000))}
                        className="mt-2 rounded-none border-gray-300"
                      />
                    </div>
                    <div>
                      <Label htmlFor="target_nodes">Target Nodes</Label>
                      <Input
                        id="target_nodes"
                        value={data.target_nodes}
                        onChange={(e) => setField('target_nodes', e.target.value)}
                        className="mt-2 rounded-none border-gray-300"
                        placeholder="primary-node,edge-node-2"
                      />
                    </div>
                  </>
                )}

                <div>
                  <Label htmlFor="custom_domain">Custom Domain (optional)</Label>
                  <Input
                    id="custom_domain"
                    value={data.custom_domain}
                    onChange={(e) => setField('custom_domain', e.target.value)}
                    className="mt-2 rounded-none border-gray-300"
                    placeholder="app.example.com"
                  />
                </div>
              </div>

              <div className="flex gap-3 mt-6">
                <Button
                  type="button"
                  variant="outline"
                  className="flex-1 rounded-none border-gray-300"
                  onClick={() => setStep(3)}
                >
                  Back
                </Button>
                <Button
                  type="button"
                  className="flex-1 bg-gray-900 text-white hover:bg-gray-800 rounded-none"
                  disabled={!canContinue || submitting}
                  onClick={createProject}
                >
                  {submitting ? 'Creating...' : 'Create Project'}
                </Button>
              </div>
            </CardContent>
          </Card>
        )}
      </div>
    </div>
  );
};

export default SetupWizard;
