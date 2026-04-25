import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import apiClient from '@/lib/api';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

type WizardData = {
  source_type: 'github' | 'local_folder';
  deployment_model: 'self_hosted' | 'saas';
  use_case: 'netlify_like' | 'vercel_like' | 'docker_platform';
  repo_url: string;
  local_folder_path: string;
  repo_branch: string;
  build_command: string;
  project_name: string;
  launch_url: string;
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
  source_type?: 'github' | 'local_folder';
  local_folder_path?: string;
  launch_url?: string;
  repo_url: string;
  repo_branch: string;
  created_at: string;
};

const STORAGE_KEY = 'wt_projects';
const STEP_LABELS = ['Deployment', 'App Type', 'Repository', 'Finalize'];

const SetupWizard = () => {
  const [step, setStep] = useState(1);
  const [submitting, setSubmitting] = useState(false);
  const [hasNodes, setHasNodes] = useState<boolean | null>(null);
  const [quickMode, setQuickMode] = useState(false);
  const [searchParams] = useSearchParams();

  // GitHub repo picker state
  type GHOrg = { login: string; avatar_url: string | null; type: 'user' | 'organization' };
  type GHRepo = { id: number; name: string; full_name: string; html_url: string; description: string | null; private: boolean; default_branch: string };
  const [orgId, setOrgId] = useState<string | null>(null);
  const [ghPickerOpen, setGhPickerOpen] = useState(false);
  const [ghPickerLoading, setGhPickerLoading] = useState(false);
  const [ghPickerError, setGhPickerError] = useState('');
  const [ghOrgs, setGhOrgs] = useState<GHOrg[]>([]);
  const [selectedGHOrg, setSelectedGHOrg] = useState('');
  const [ghRepos, setGhRepos] = useState<GHRepo[]>([]);
  const [repoSearch, setRepoSearch] = useState('');
  const [ghConnected, setGhConnected] = useState(false);
  const navigate = useNavigate();

  // Check if any deployment nodes exist so we can warn before wasting the user's time
  useEffect(() => {
    const checkNodes = async () => {
      try {
        const ctxRes = await apiClient.get('/context');
        const fetchedOrgId = (ctxRes.data as any)?.organization?.id;
        if (!fetchedOrgId) { setHasNodes(false); return; }
        setOrgId(fetchedOrgId);
        const nodesRes = await apiClient.get(`/orgs/${fetchedOrgId}/nodes`);
        setHasNodes(((nodesRes.data as any[]) ?? []).length > 0);
        // Check if user already has an active GitHub connection
        try {
          await apiClient.get('/github/user/orgs');
          setGhConnected(true);
        } catch {
          setGhConnected(false);
        }
      } catch {
        setHasNodes(null); // unknown — don't block
      }
    };
    void checkNodes();
  }, []);

  // Auto-open repo picker when returning from GitHub OAuth
  useEffect(() => {
    if (searchParams.get('github_picker') === '1' && ghConnected) {
      setStep(3);
      setGhPickerOpen(true);
    }
  }, [searchParams, ghConnected]);

  // Fetch repos when picker opens or org changes
  useEffect(() => {
    if (!ghPickerOpen) return;
    const fetchOrgs = async () => {
      setGhPickerLoading(true);
      setGhPickerError('');
      try {
        const res = await apiClient.get('/github/user/orgs');
        const orgs = res.data as GHOrg[];
        setGhOrgs(orgs);
        if (orgs.length > 0 && !selectedGHOrg) setSelectedGHOrg(orgs[0].login);
      } catch (e: any) {
        setGhPickerError(e?.response?.data?.detail || 'Failed to load GitHub organizations.');
      } finally {
        setGhPickerLoading(false);
      }
    };
    void fetchOrgs();
  }, [ghPickerOpen]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!ghPickerOpen || !selectedGHOrg) return;
    const fetchRepos = async () => {
      setGhPickerLoading(true);
      try {
        // Determine if we're fetching user repos or org repos
        const isUser = ghOrgs.find(o => o.login === selectedGHOrg)?.type === 'user';
        const params: Record<string, string> = {};
        if (!isUser) params['org'] = selectedGHOrg;
        const res = await apiClient.get('/github/user/repos', { params });
        setGhRepos(res.data as GHRepo[]);
      } catch {
        setGhRepos([]);
      } finally {
        setGhPickerLoading(false);
      }
    };
    void fetchRepos();
  }, [selectedGHOrg, ghPickerOpen]); // eslint-disable-line react-hooks/exhaustive-deps

  const openGitHubPicker = async () => {
    const isLoggedIn = Boolean(localStorage.getItem('authToken'));
    if (!isLoggedIn) {
      navigate('/login?next=/setup');
      return;
    }
    if (!ghConnected) {
      // Need to connect GitHub with repo scope
      if (!orgId) { setGhPickerError('Organization context not loaded. Refresh and try again.'); return; }
      try {
        const redirectUri = `${window.location.origin}/oauth/github/callback`;
        const res = await apiClient.get('/github/oauth/start', {
          params: { org_id: orgId, redirect_uri: redirectUri, next_path: '/setup?github_picker=1' },
        });
        const url = (res.data as any)?.authorize_url;
        if (url) { window.location.href = url; }
      } catch {
        setGhPickerError('Could not start GitHub authorization. Check OAuth configuration in settings.');
      }
      return;
    }
    setGhPickerOpen(true);
  };

  const selectRepo = (repo: GHRepo) => {
    setField('repo_url', repo.html_url);
    setField('repo_branch', repo.default_branch);
    if (!data.project_name) setField('project_name', repo.name);
    setGhPickerOpen(false);
  };

  const [data, setData] = useState<WizardData>({
    source_type: 'github',
    deployment_model: 'self_hosted',
    use_case: 'vercel_like',
    repo_url: '',
    local_folder_path: '',
    repo_branch: 'main',
    build_command: 'npm ci && npm run build',
    project_name: '',
    launch_url: 'http://localhost:3000',
    output_dir: 'dist',
    functions_dir: 'api',
    enable_functions: true,
    framework: 'next.js',
    enable_preview_deployments: true,
    dockerfile_path: './Dockerfile',
    exposed_port: 3000,
    target_nodes: 'default',
    custom_domain: '',
  });

  const activateQuickMode = () => {
    setQuickMode(true);
    setStep(3);
  };

  const canContinue = useMemo(() => {
    if (quickMode) {
      // In quick mode, only need repo URL and project name
      return data.repo_url.trim().length > 0 && data.project_name.trim().length > 0;
    }
    if (step === 1) return Boolean(data.deployment_model);
    if (step === 2) return Boolean(data.use_case);
    if (step === 3) {
      if (data.source_type === 'github') {
        return data.repo_url.trim().length > 0 && data.build_command.trim().length > 0;
      }
      return data.local_folder_path.trim().length > 0;
    }
    return data.project_name.trim().length > 0;
  }, [data, step, quickMode]);

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
      source_type: data.source_type,
      local_folder_path: data.local_folder_path || undefined,
      launch_url: data.launch_url || undefined,
      repo_url: data.source_type === 'github' ? data.repo_url : `local://${data.local_folder_path}`,
      repo_branch: data.source_type === 'github' ? data.repo_branch : 'local',
      created_at: new Date().toISOString(),
    };
    localStorage.setItem(STORAGE_KEY, JSON.stringify([item, ...existing]));
  };

  const createProject = async () => {
    setSubmitting(true);
    saveLocalProject();
    try {
      const effectiveRepoUrl = data.source_type === 'github'
        ? data.repo_url
        : `local://${data.local_folder_path}`;
      const effectiveBranch = data.source_type === 'github' ? data.repo_branch : 'local';
      const effectiveBuildCommand = data.source_type === 'github'
        ? data.build_command
        : (data.build_command || 'npm run dev');

      await apiClient.post('/setup/wizard/complete', {
        deployment_model: data.deployment_model,
        use_case: data.use_case,
        source_type: data.source_type,
        local_folder_path: data.source_type === 'local_folder' ? data.local_folder_path : undefined,
        launch_url: data.launch_url || undefined,
        repo_url: effectiveRepoUrl,
        repo_branch: effectiveBranch,
        build_command: effectiveBuildCommand,
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
          <div className="flex items-center gap-2">
            <Button
              type="button"
              variant="outline"
              onClick={() => (window.history.length > 1 ? navigate(-1) : navigate('/'))}
              className="electron-button rounded-md text-sm"
            >
              Back
            </Button>
            <Button
              type="button"
              variant="outline"
              onClick={() => {
                window.close();
                navigate('/');
              }}
              className="electron-button rounded-md text-sm"
            >
              Close
            </Button>
            <Link to="/">
              <Button variant="outline" className="electron-button rounded-md text-sm">Cancel</Button>
            </Link>
          </div>
        </div>
      </header>

      <div className="max-w-6xl mx-auto px-6 py-8 grid lg:grid-cols-3 gap-6">
        <section className="lg:col-span-2 space-y-4">
          {/* Quick-start prompt only on step 1 */}
          {step === 1 && !quickMode && (
            <div className="electron-card rounded-xl p-4 bg-gradient-to-r from-sky-50 to-cyan-50 border border-sky-300">
              <div className="flex items-center justify-between">
                <div>
                  <p className="font-semibold text-sky-900 text-sm">✨ Quick Start Available</p>
                  <p className="text-xs text-sky-700 mt-1">Skip form decisions — we'll use smart defaults and you just confirm the repo.</p>
                </div>
                <Button onClick={activateQuickMode} className="bg-sky-600 hover:bg-sky-700 text-white rounded-md text-sm whitespace-nowrap">Start Quick Mode →</Button>
              </div>
            </div>
          )}

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

          {step === 1 && !quickMode && (
            <div className="electron-card rounded-xl p-6">
              <h2 className="text-lg font-semibold text-slate-900">Where will you deploy?</h2>
              <p className="text-sm text-slate-600 mb-4">Select runtime ownership mode.</p>

              {/* No-nodes warning — only shown when self_hosted is selected and we know there are no nodes */}
              {hasNodes === false && data.deployment_model === 'self_hosted' && (
                <div className="mb-5 rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 text-sm">
                  <p className="font-semibold text-amber-900">⚠ No server nodes added yet</p>
                  <p className="text-amber-800 mt-1 text-xs">
                    You need at least one infrastructure node before WatchTower can deploy your app.
                    You can still create the project now, but deployments will fail until you add a server.
                  </p>
                  <Link
                    to="/servers"
                    className="inline-block mt-2 text-xs font-medium text-amber-900 underline underline-offset-2 hover:text-amber-700"
                  >
                    → Add a server node first
                  </Link>
                </div>
              )}

              <div className="space-y-3">
                {([
                  { value: 'self_hosted', title: 'Self-Hosted', desc: 'Run WatchTower on your own servers.' },
                  { value: 'saas', title: 'SaaS', desc: 'Use managed cloud runtime.' },
                ] as const).map((opt) => (
                  <label key={opt.value} className={`flex gap-4 items-start border rounded-md p-4 cursor-pointer ${data.deployment_model === opt.value ? 'border-red-300 bg-red-50' : 'border-border bg-white hover:border-red-300'}`}>
                    <input type="radio" name="deployment_model" className="mt-1" checked={data.deployment_model === opt.value} onChange={() => setField('deployment_model', opt.value)} />
                    <div>
                      <p className="font-medium text-sm">{opt.title}</p>
                      <p className="text-xs text-slate-600 mt-0.5">{opt.desc}</p>
                    </div>
                  </label>
                ))}
              </div>
              <div className="mt-6 flex justify-end">
                <Button onClick={() => setStep(2)} disabled={!canContinue} className="electron-accent-bg rounded-md">Continue</Button>
              </div>
            </div>
          )}

          {step === 2 && !quickMode && (
            <div className="electron-card rounded-xl p-6">
              <h2 className="text-lg font-semibold text-slate-900">Choose application type</h2>
              <p className="text-sm text-slate-600 mb-6">Pick workflow template.</p>
              <div className="space-y-3">
                {([
                  { value: 'netlify_like', title: 'Static + Functions', desc: 'Static frontend with optional API functions.' },
                  { value: 'vercel_like', title: 'SSR / Full-Stack', desc: 'Branch previews and server rendering.' },
                  { value: 'docker_platform', title: 'Docker Platform', desc: 'Containerized app runtime.' },
                ] as const).map((opt) => (
                  <label key={opt.value} className={`flex gap-4 items-start border rounded-md p-4 cursor-pointer ${data.use_case === opt.value ? 'border-red-300 bg-red-50' : 'border-border bg-white hover:border-red-300'}`}>
                    <input type="radio" name="use_case" className="mt-1" checked={data.use_case === opt.value} onChange={() => setField('use_case', opt.value)} />
                    <div>
                      <p className="font-medium text-sm">{opt.title}</p>
                      <p className="text-xs text-slate-600 mt-0.5">{opt.desc}</p>
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
              <div className="flex items-center justify-between mb-4">
                <div>
                  <h2 className="text-lg font-semibold text-slate-900">Connect source</h2>
                  <p className="text-sm text-slate-600 mt-1">GitHub repo or local folder. Deploy like a web app.</p>
                </div>
                {quickMode && (
                  <span className="px-2 py-1 bg-sky-100 text-sky-700 text-xs font-medium rounded-md">⚡ Quick Mode</span>
                )}
              </div>

              {/* In quick mode, simplify significantly */}
              {quickMode && (
                <div className="space-y-4 bg-sky-50 rounded-lg p-4 border border-sky-200 mb-6">
                  <div>
                    <p className="text-xs font-semibold text-sky-900 mb-2">📋 Using these presets:</p>
                    <ul className="text-xs text-sky-700 space-y-0.5 list-disc list-inside">
                      <li><strong>App type:</strong> SSR / Full-Stack (Next.js, Svelte, etc.)</li>
                      <li><strong>Deployment:</strong> Self-Hosted</li>
                      <li><strong>Branch previews:</strong> Enabled</li>
                      <li><strong>Build command:</strong> npm ci && npm run build</li>
                    </ul>
                  </div>
                  <p className="text-xs text-sky-600 italic">Just paste your GitHub repo URL and give your project a name!</p>
                </div>
              )}

              <div className="space-y-4">
                {/* Hide source type toggle in quick mode */}
                {!quickMode && (
                <div className="grid grid-cols-2 gap-2">
                  <button
                    type="button"
                    onClick={() => setField('source_type', 'github')}
                    className={`text-left px-3 py-2 border rounded-md text-sm ${data.source_type === 'github' ? 'bg-red-50 border-red-300 text-red-800 font-semibold' : 'bg-white border-border text-slate-700'}`}
                  >
                    GitHub Repository
                  </button>
                  <button
                    type="button"
                    onClick={() => setField('source_type', 'local_folder')}
                    className={`text-left px-3 py-2 border rounded-md text-sm ${data.source_type === 'local_folder' ? 'bg-red-50 border-red-300 text-red-800 font-semibold' : 'bg-white border-border text-slate-700'}`}
                  >
                    Local Folder
                  </button>
                </div>
                )}

                {data.source_type === 'github' ? (
                  <>
                    <div className="flex items-center justify-between gap-2">
                      <Label htmlFor="repo_url">Repository URL *</Label>
                      <button
                        type="button"
                        onClick={() => void openGitHubPicker()}
                        className="text-xs electron-accent underline hover:opacity-80"
                      >
                        {ghConnected ? '📂 Browse GitHub Repos' : '🔗 Sign in with GitHub'}
                      </button>
                    </div>
                    <Input id="repo_url" value={data.repo_url} onChange={(e) => setField('repo_url', e.target.value)} className="mt-1.5 rounded-md border-border bg-white" placeholder="https://github.com/owner/repo" />

                    {/* GitHub Repo Picker Panel */}
                    {ghPickerOpen && (
                      <div className="mt-3 border border-sky-200 rounded-lg bg-sky-50 p-4 space-y-3">
                        <div className="flex items-center justify-between">
                          <p className="text-sm font-semibold text-sky-900">Select a GitHub Repository</p>
                          <button type="button" onClick={() => setGhPickerOpen(false)} className="text-sky-600 hover:text-sky-800 text-xs">✕ Close</button>
                        </div>

                        {ghPickerError && (
                          <p className="text-xs text-red-700 bg-red-50 border border-red-200 rounded px-2 py-1">{ghPickerError}</p>
                        )}

                        {ghOrgs.length > 0 && (
                          <div>
                            <label className="text-xs font-medium text-sky-800 block mb-1">Organization / Account</label>
                            <select
                              value={selectedGHOrg}
                              onChange={(e) => setSelectedGHOrg(e.target.value)}
                              className="w-full rounded-md border border-sky-200 bg-white text-sm px-2 py-1.5"
                            >
                              {ghOrgs.map((o) => (
                                <option key={o.login} value={o.login}>
                                  {o.type === 'user' ? `👤 ${o.login}` : `🏢 ${o.login}`}
                                </option>
                              ))}
                            </select>
                          </div>
                        )}

                        <div>
                          <label className="text-xs font-medium text-sky-800 block mb-1">Search Repositories</label>
                          <Input
                            value={repoSearch}
                            onChange={(e) => setRepoSearch(e.target.value)}
                            placeholder="Filter by name..."
                            className="rounded-md border-sky-200 bg-white text-sm"
                          />
                        </div>

                        {ghPickerLoading && <p className="text-xs text-sky-600 animate-pulse">Loading repositories…</p>}

                        {!ghPickerLoading && ghRepos.length === 0 && !ghPickerError && (
                          <p className="text-xs text-slate-500">No repositories found for this account.</p>
                        )}

                        {!ghPickerLoading && ghRepos.length > 0 && (
                          <div className="max-h-48 overflow-y-auto rounded-md border border-sky-200 bg-white divide-y divide-sky-100">
                            {ghRepos
                              .filter((r) => !repoSearch || r.name.toLowerCase().includes(repoSearch.toLowerCase()))
                              .map((repo) => (
                                <button
                                  key={repo.id}
                                  type="button"
                                  onClick={() => selectRepo(repo)}
                                  className="w-full text-left px-3 py-2 hover:bg-sky-50 transition-colors"
                                >
                                  <div className="flex items-center gap-2">
                                    <span className="text-xs font-medium text-slate-800">{repo.name}</span>
                                    {repo.private && <span className="text-[10px] bg-amber-100 text-amber-700 px-1 rounded">private</span>}
                                  </div>
                                  {repo.description && (
                                    <p className="text-[11px] text-slate-500 truncate mt-0.5">{repo.description}</p>
                                  )}
                                </button>
                              ))}
                          </div>
                        )}
                      </div>
                    )}
                  </>
                ) : (
                  <div>
                    <Label htmlFor="local_folder_path">Local Folder Path *</Label>
                    <Input id="local_folder_path" value={data.local_folder_path} onChange={(e) => setField('local_folder_path', e.target.value)} className="mt-1.5 rounded-md border-border bg-white" placeholder="/home/you/my-app" />
                    <p className="text-xs text-slate-600 mt-1">Use an absolute path to your app folder on this machine.</p>
                  </div>
                )}

                {/* In quick mode, show project name here */}
                {quickMode && (
                  <div>
                    <Label htmlFor="project_name">Project Name *</Label>
                    <Input id="project_name" value={data.project_name} onChange={(e) => setField('project_name', e.target.value)} className="mt-1.5 rounded-md border-border bg-white" placeholder="my-web-app" />
                    <p className="text-xs text-slate-600 mt-1">A unique name for your deployment.</p>
                  </div>
                )}

                {/* Hide detailed options in quick mode */}
                {!quickMode && (
                <>
                <div>
                  <Label htmlFor="launch_url">Launch URL (optional)</Label>
                  <Input id="launch_url" value={data.launch_url} onChange={(e) => setField('launch_url', e.target.value)} className="mt-1.5 rounded-md border-border bg-white" placeholder="https://my-app.example.com or http://127.0.0.1:3000" />
                  <p className="text-xs text-slate-600 mt-1">This enables one-click Open Web from your dashboard.</p>
                </div>

                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <Label htmlFor="repo_branch">{data.source_type === 'github' ? 'Branch' : 'Branch (optional)'}</Label>
                    <Input id="repo_branch" value={data.repo_branch} onChange={(e) => setField('repo_branch', e.target.value)} className="mt-1.5 rounded-md border-border bg-white" placeholder={data.source_type === 'github' ? 'main' : 'local'} />
                  </div>
                  <div>
                    <Label htmlFor="build_command">Build/Run Command {data.source_type === 'github' ? '*' : '(optional)'}</Label>
                    <Input id="build_command" value={data.build_command} onChange={(e) => setField('build_command', e.target.value)} className="mt-1.5 rounded-md border-border bg-white" placeholder={data.source_type === 'github' ? 'npm ci && npm run build' : 'npm run dev'} />
                  </div>
                </div>
                </>
                )}
              </div>
              <div className="mt-6 flex justify-between">
                <Button variant="outline" onClick={() => {
                  if (quickMode) {
                    setQuickMode(false);
                    setStep(1);
                  } else {
                    setStep(2);
                  }
                }} className="electron-button rounded-md">Back</Button>
                <Button onClick={() => quickMode ? void createProject() : setStep(4)} disabled={!canContinue || submitting} className="electron-accent-bg rounded-md">
                  {quickMode ? (submitting ? 'Creating...' : 'Create Project') : 'Continue'}
                </Button>
              </div>
            </div>
          )}

          {/* Only show step 4 if not in quick mode */}
          {step === 4 && !quickMode && (
            <div className="electron-card rounded-xl p-6">
              <h2 className="text-lg font-semibold text-slate-900">Finalize configuration</h2>
              <p className="text-sm text-slate-600 mb-6">Set project identity and runtime options.</p>
              <div className="space-y-4">
                <div>
                  <Label htmlFor="project_name">Project Name *</Label>
                  <Input id="project_name" value={data.project_name} onChange={(e) => setField('project_name', e.target.value)} className="mt-1.5 rounded-md border-border bg-white" placeholder="my-web-app" />
                </div>

                {data.use_case === 'netlify_like' && (
                  <Card className="electron-card-solid rounded-md shadow-none">
                    <CardContent className="py-4 space-y-3">
                      <p className="text-xs font-medium uppercase tracking-wide electron-accent">Static + Functions</p>
                      <div className="grid grid-cols-2 gap-3">
                        <div>
                          <Label htmlFor="output_dir">Output Directory</Label>
                          <Input id="output_dir" value={data.output_dir} onChange={(e) => setField('output_dir', e.target.value)} className="mt-1.5 rounded-md border-border bg-white" />
                        </div>
                        <div>
                          <Label htmlFor="functions_dir">Functions Directory</Label>
                          <Input id="functions_dir" value={data.functions_dir} onChange={(e) => setField('functions_dir', e.target.value)} className="mt-1.5 rounded-md border-border bg-white" />
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
                        <Input id="framework" value={data.framework} onChange={(e) => setField('framework', e.target.value)} className="mt-1.5 rounded-md border-border bg-white" />
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
                          <Input id="dockerfile_path" value={data.dockerfile_path} onChange={(e) => setField('dockerfile_path', e.target.value)} className="mt-1.5 rounded-md border-border bg-white" />
                        </div>
                        <div>
                          <Label htmlFor="exposed_port">Exposed Port</Label>
                          <Input id="exposed_port" type="number" value={data.exposed_port} onChange={(e) => setField('exposed_port', Number(e.target.value || 3000))} className="mt-1.5 rounded-md border-border bg-white" />
                        </div>
                      </div>
                    </CardContent>
                  </Card>
                )}

                <div>
                  <Label htmlFor="custom_domain">Custom Domain (optional)</Label>
                  <Input id="custom_domain" value={data.custom_domain} onChange={(e) => setField('custom_domain', e.target.value)} className="mt-1.5 rounded-md border-border bg-white" placeholder="app.example.com" />
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
          {hasNodes === false && data.deployment_model === 'self_hosted' && (
            <Card className="rounded-xl shadow-none border-amber-300 bg-amber-50">
              <CardContent className="py-4">
                <p className="text-xs font-semibold text-amber-900 mb-1">⚠ Server node required</p>
                <p className="text-xs text-amber-800 mb-2">
                  No deployment nodes are registered. Add one in Servers before deploying.
                </p>
                <Link
                  to="/servers"
                  className="text-xs font-medium text-amber-900 underline underline-offset-2 hover:text-amber-700"
                >
                  → Go to Servers
                </Link>
              </CardContent>
            </Card>
          )}

          <Card className="electron-card rounded-xl shadow-none">
            <CardContent className="py-4">
              <p className="text-xs font-semibold uppercase tracking-[0.16em] electron-accent">Next Steps</p>
              <ol className="mt-3 space-y-2">
                {nextSteps.map((item, idx) => (
                  <li key={item} className="flex gap-2 text-xs text-slate-700">
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
              <div className="mt-2 text-xs text-slate-700 space-y-1">
                <p>Mode: <span className="text-red-700">{data.deployment_model === 'self_hosted' ? 'Self-Hosted' : 'SaaS'}</span></p>
                <p>App Type: <span className="text-red-700">{data.use_case}</span></p>
                <p>Branch: <span className="text-red-700">{data.repo_branch || 'main'}</span></p>
              </div>
            </CardContent>
          </Card>
        </aside>
      </div>
    </div>
  );
};

export default SetupWizard;
