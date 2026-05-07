import { useEffect, useMemo, useState, useRef } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import apiClient from '@/lib/api';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

// Where the user's deployment will run. Step 1 of the wizard asks this
// directly; the rest of the flow adapts (skipping server registration
// for `this_machine`, surfacing the existing SSH form for `remote_ssh`,
// showing cloud-setup commands for `cloud_setup`).
//
// Maps onto deployment_model='self_hosted' for all three (the user owns
// the runtime in every case — there is no managed SaaS path today),
// but the UX is dramatically different between them.
type DeploymentTarget = 'this_machine' | 'remote_ssh' | 'cloud_setup';

type WizardData = {
  source_type: 'github' | 'local_folder';
  deployment_model: 'self_hosted' | 'saas';
  deployment_target: DeploymentTarget;
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
  // Persisted so the dashboard can render "Deploys to: this machine"
  // alongside the project, and the CTA after creation can be specific.
  deployment_target?: DeploymentTarget;
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
  const [browserPickedFolderName, setBrowserPickedFolderName] = useState('');
  const [ghAuthReady, setGhAuthReady] = useState({ loaded: false, oauth: false, device: false });
  const [deviceConnect, setDeviceConnect] = useState({
    open: false,
    userCode: '',
    verificationUri: '',
    verificationUriComplete: '',
    deviceCode: '',
    polling: false,
    error: '',
  });
  // Port suggestion from /api/runtime/recommend-port. `null` while loading,
  // a number when fetched, `'error'` if the endpoint failed (we don't want
  // to silently fall back to "3000" the way the legacy code did — better
  // to tell the user we couldn't pick).
  const [recommendedPort, setRecommendedPort] = useState<number | null | 'error'>(null);
  const [portEditOpen, setPortEditOpen] = useState(false);
  const navigate = useNavigate();
  const folderInputRef = useRef<HTMLInputElement>(null);
  const hasElectronFolderPicker = Boolean((window as unknown as { electronAPI?: { selectFolder?: unknown } }).electronAPI?.selectFolder);

  const loadAuthStatus = async () => {
    try {
      const res = await apiClient.get('/auth/status');
      const payload = res.data as {
        oauth?: { github_configured?: boolean };
        device_flow?: { github_configured?: boolean };
      };
      setGhAuthReady({
        loaded: true,
        oauth: Boolean(payload?.oauth?.github_configured),
        device: Boolean(payload?.device_flow?.github_configured),
      });
    } catch {
      setGhAuthReady({ loaded: true, oauth: false, device: false });
    }
  };

  // Check if any deployment nodes exist so we can warn before wasting the user's time
  useEffect(() => {
    const checkNodes = async () => {
      try {
        await loadAuthStatus();
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
        setGhAuthReady({ loaded: true, oauth: false, device: false });
        setHasNodes(null); // unknown — don't block
      }
    };
    void checkNodes();
  }, []);

  // Fetch a recommended port up-front so the wizard can show "we'll use
  // port X" instead of demanding the user pick one. Surface failure
  // explicitly — silent fallback to 3000 is the same UX trap that
  // detect-framework had.
  useEffect(() => {
    const fetchPort = async () => {
      try {
        const res = await apiClient.get('/runtime/recommend-port');
        const port = (res.data as { port?: number })?.port;
        if (typeof port === 'number') {
          setRecommendedPort(port);
          // Wire into the form fields the user might submit. Don't
          // overwrite if the user already typed something.
          setData((prev) => {
            const launchUrlIsDefault = prev.launch_url === 'http://localhost:3000' || prev.launch_url === '';
            return {
              ...prev,
              exposed_port: prev.exposed_port === 3000 ? port : prev.exposed_port,
              launch_url: launchUrlIsDefault ? `http://localhost:${port}` : prev.launch_url,
            };
          });
        } else {
          setRecommendedPort('error');
        }
      } catch {
        setRecommendedPort('error');
      }
    };
    void fetchPort();
  }, []);

  // Auto-open repo picker when returning from GitHub OAuth
  useEffect(() => {
    if (searchParams.get('github_picker') === '1' && ghConnected) {
      setStep(3);
      setGhPickerOpen(true);
    }
  }, [searchParams, ghConnected]);

  // (Auto-open repo picker effect lives after `data` is declared below.)
  const [autoOpened, setAutoOpened] = useState(false);

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
      setGhPickerError('');
      try {
        // Determine if we're fetching user repos or org repos
        const isUser = ghOrgs.find(o => o.login === selectedGHOrg)?.type === 'user';
        const params: Record<string, string> = {};
        if (!isUser) params['org'] = selectedGHOrg;
        const res = await apiClient.get('/github/user/repos', { params });
        setGhRepos(res.data as GHRepo[]);
      } catch (e: any) {
        setGhRepos([]);
        setGhPickerError(e?.response?.data?.detail || 'Could not load repositories for this account.');
      } finally {
        setGhPickerLoading(false);
      }
    };
    void fetchRepos();
  }, [selectedGHOrg, ghPickerOpen]); // eslint-disable-line react-hooks/exhaustive-deps

  const pollDeviceConnect = async (deviceCode: string, intervalSeconds: number) => {
    try {
      const res = await apiClient.post('/github/device/connect/poll', { device_code: deviceCode });
      const status = (res.data as { status?: string; interval?: number })?.status;

      if (status === 'success') {
        setGhConnected(true);
        setDeviceConnect((prev) => ({
          ...prev,
          open: false,
          polling: false,
          error: '',
        }));
        setGhPickerOpen(true);
        setGhPickerError('');
        return;
      }

      if (status === 'authorization_pending' || status === 'slow_down') {
        const nextInterval = Math.max(
          Number((res.data as { interval?: number })?.interval ?? intervalSeconds),
          2,
        );
        window.setTimeout(() => {
          void pollDeviceConnect(deviceCode, nextInterval);
        }, nextInterval * 1000);
        return;
      }

      if (status === 'access_denied') {
        setDeviceConnect((prev) => ({
          ...prev,
          polling: false,
          error: 'GitHub authorization was cancelled. Try again.',
        }));
        return;
      }

      if (status === 'expired_token') {
        setDeviceConnect((prev) => ({
          ...prev,
          polling: false,
          error: 'Device code expired. Start connect again.',
        }));
      }
    } catch {
      setDeviceConnect((prev) => ({
        ...prev,
        polling: false,
        error: 'Could not complete GitHub device authorization.',
      }));
    }
  };

  const startDeviceConnect = async (effectiveOrgId: string) => {
    try {
      const res = await apiClient.post('/github/device/connect/start', { org_id: effectiveOrgId });
      const payload = res.data as {
        device_code?: string;
        user_code?: string;
        verification_uri?: string;
        verification_uri_complete?: string;
        interval?: number;
      };
      const deviceCode = payload.device_code || '';
      const interval = Math.max(Number(payload.interval ?? 5), 2);
      if (!deviceCode) {
        setGhPickerError('GitHub device connect did not return a device code.');
        return;
      }

      setDeviceConnect({
        open: true,
        userCode: payload.user_code || '',
        verificationUri: payload.verification_uri || 'https://github.com/login/device',
        verificationUriComplete: payload.verification_uri_complete || '',
        deviceCode,
        polling: true,
        error: '',
      });

      void pollDeviceConnect(deviceCode, interval);
    } catch {
      setGhPickerError('Could not start GitHub device authorization.');
    }
  };

  const openGitHubPicker = async () => {
    const isLoggedIn = Boolean(localStorage.getItem('authToken'));
    if (!isLoggedIn) {
      navigate('/login?next=/setup');
      return;
    }

    // Re-check active GitHub connection on demand (state can be stale after OAuth return).
    try {
      const orgsResp = await apiClient.get('/github/user/orgs');
      const orgs = orgsResp.data as GHOrg[];
      if (orgs.length > 0) {
        setGhConnected(true);
        setGhOrgs(orgs);
        if (!selectedGHOrg) setSelectedGHOrg(orgs[0].login);
        setGhPickerOpen(true);
        setGhPickerError('');
        return;
      }
    } catch {
      // Fall through to OAuth connect path.
      setGhConnected(false);
    }

    if (!ghConnected) {
      if (!ghAuthReady.loaded) {
        await loadAuthStatus();
      }
      // Need to connect GitHub with repo scope
      let effectiveOrgId = orgId;
      if (!effectiveOrgId) {
        try {
          const ctxRes = await apiClient.get('/context');
          effectiveOrgId = (ctxRes.data as any)?.organization?.id || null;
          setOrgId(effectiveOrgId);
        } catch {
          effectiveOrgId = null;
        }
      }
      if (!effectiveOrgId) { setGhPickerError('Organization context not loaded. Refresh and try again.'); return; }
      if (ghAuthReady.oauth) {
        try {
          const redirectUri = `${window.location.origin}/oauth/github/callback`;
          const res = await apiClient.get('/github/oauth/start', {
            params: { org_id: effectiveOrgId, redirect_uri: redirectUri, next_path: '/setup?github_picker=1' },
          });
          const url = (res.data as any)?.authorize_url;
          if (url) { window.location.href = url; }
        } catch {
          setGhPickerError('Could not start GitHub authorization. Check OAuth configuration in settings.');
        }
        return;
      }

      if (ghAuthReady.device) {
        await startDeviceConnect(effectiveOrgId);
        return;
      }

      setGhPickerError('GitHub connection is not configured on this server. Add OAuth credentials in Integrations, or paste a repository URL manually.');
      return;
    }
    setGhPickerOpen(true);
    setGhPickerError('');
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
    // Default to "this machine" — matches what most first-time users
    // actually have (one Linux laptop, want to try it out), and
    // doesn't require any additional setup. Users who need a real
    // production target can pick the other two in Step 1.
    deployment_target: 'this_machine',
    use_case: 'vercel_like',
    repo_url: '',
    local_folder_path: '',
    repo_branch: 'main',
    build_command: 'npm install && npm run build',
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

  // Auto-open the repo picker as soon as the user selects "GitHub
  // Repository" (which is the default source_type). Previously this
  // was hidden behind a separate "Browse GitHub Repos" click — a
  // redundant gate that made every new project a multi-step dance.
  // Only auto-opens once per page lifetime (autoOpened gate) so
  // closing the picker doesn't immediately reopen it.
  useEffect(() => {
    if (
      data.source_type === 'github' &&
      ghConnected &&
      !ghPickerOpen &&
      !autoOpened &&
      !data.repo_url
    ) {
      setGhPickerOpen(true);
      setAutoOpened(true);
    }
  }, [data.source_type, ghConnected, ghPickerOpen, autoOpened, data.repo_url]);

  const activateQuickMode = () => {
    setQuickMode(true);
    setStep(3);
  };

  const canContinue = useMemo(() => {
    const hasAbsoluteLikePath = (value: string) =>
      value.startsWith('/') || value.includes('\\') || /^[a-zA-Z]:\\/.test(value);

    if (quickMode) {
      // In quick mode, only need repo URL and project name
      return data.repo_url.trim().length > 0 && data.project_name.trim().length > 0;
    }
    if (step === 1) return Boolean(data.deployment_target);
    if (step === 2) return Boolean(data.use_case);
    if (step === 3) {
      if (data.source_type === 'github') {
        return data.repo_url.trim().length > 0 && data.build_command.trim().length > 0;
      }
      // Browser folder picker can't return a true absolute local filesystem
      // path; require a path-looking value before allowing Continue.
      return data.local_folder_path.trim().length > 0 && hasAbsoluteLikePath(data.local_folder_path.trim());
    }
    return data.project_name.trim().length > 0;
  }, [data, step, quickMode]);

  const setField = <K extends keyof WizardData>(key: K, value: WizardData[K]) => {
    setData((prev) => ({ ...prev, [key]: value }));
  };

  const nextSteps = useMemo(() => {
    const steps: string[] = [];

    if (data.deployment_target === 'this_machine') {
      steps.push('Your project deploys to this machine via Podman — no server registration needed. After deploy, the URL is http://127.0.0.1:<port>.');
    } else if (data.deployment_target === 'remote_ssh') {
      steps.push('Add at least one server in the Servers tab before your first deployment.');
    } else {
      steps.push('Spin up a Linux box (Oracle Cloud Free Tier, Hetzner, etc.), then add it as a Remote SSH server.');
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
      deployment_target: data.deployment_target,
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
    let initialDeployQueued = false;
    try {
      const effectiveRepoUrl = data.source_type === 'github'
        ? data.repo_url
        : `local://${data.local_folder_path}`;
      const effectiveBranch = data.source_type === 'github' ? data.repo_branch : 'local';
      const effectiveBuildCommand = data.source_type === 'github'
        ? data.build_command
        : (data.build_command || 'npm run dev');

      const createdProjectResp = await apiClient.post('/setup/wizard/complete', {
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
        // Persist the suggested (or user-edited) port on Project so the
        // local-podman runner can read it as the source of truth.
        recommended_port: data.exposed_port,
      });

      // Queue an initial deployment for GitHub projects so the repository
      // is cloned/downloaded immediately after setup.
      if (data.source_type === 'github') {
        try {
          const createdProject = createdProjectResp.data as { id?: string };
          if (createdProject?.id) {
            await apiClient.post(`/projects/${createdProject.id}/deployments`, {
              branch: effectiveBranch,
              commit_sha: 'setup-initial-deploy',
            });
            initialDeployQueued = true;
          }
        } catch {
          // Non-fatal: project creation succeeded; user can deploy manually.
        }
      }
    } catch {
      // Local-first mode keeps setup usable while backend is unavailable.
    }
    setSubmitting(false);

    // Target-aware landing: pick the page the user is most likely to need
    // next, instead of dropping them on the dashboard for everyone.
    //   this_machine → dashboard with a "click Deploy" hint (no extra
    //                   setup; they're ready to deploy right now)
    //   remote_ssh   → dashboard (the existing flow — they may have
    //                   already added a node, or they'll add one next)
    //   cloud_setup  → /servers (they need to register the box they're
    //                   about to provision; sending them there directly
    //                   skips a "where do I add the server?" hunt)
    if (data.deployment_target === 'cloud_setup') {
      navigate('/servers');
    } else {
      // Pass the target through router state so Dashboard can render a
      // one-time "Project created — click Deploy" hint specific to it.
      navigate('/', {
        state: {
          just_created: data.project_name,
          target: data.deployment_target,
          source_type: data.source_type,
          initial_deploy_queued: initialDeployQueued,
        },
      });
    }
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
              <h2 className="text-lg font-semibold text-slate-900">Where will your app run?</h2>
              <p className="text-sm text-slate-600 mb-4">
                Pick the deployment target that fits. You can change this later, and you
                can mix targets across projects.
              </p>

              <div className="space-y-3">
                {/* Option 1: This machine — recommended default for trying things out */}
                <label className={`block border rounded-lg p-4 cursor-pointer transition ${
                  data.deployment_target === 'this_machine'
                    ? 'border-emerald-400 bg-emerald-50'
                    : 'border-slate-200 bg-white hover:border-emerald-300'
                }`}>
                  <div className="flex gap-3 items-start">
                    <input
                      type="radio"
                      name="deployment_target"
                      className="mt-1"
                      checked={data.deployment_target === 'this_machine'}
                      onChange={() => setField('deployment_target', 'this_machine')}
                    />
                    <div className="flex-1">
                      <div className="flex items-center gap-2">
                        <p className="font-semibold text-sm text-slate-900">This machine (Podman)</p>
                        <span className="text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded bg-emerald-200 text-emerald-900 font-bold">
                          Recommended for trying it out
                        </span>
                      </div>
                      <p className="text-xs text-slate-700 mt-1">
                        WatchTower builds your project with Nixpacks and runs it in a container on this Linux machine.
                        URL is <code className="font-mono bg-white border border-slate-200 px-1 rounded">http://127.0.0.1:&lt;port&gt;</code> — only you can access it.
                      </p>
                      <ul className="text-[11px] text-slate-600 mt-2 space-y-0.5">
                        <li>✅ No external infrastructure, no signup</li>
                        <li>✅ Closes the autonomous-ops loop locally (build → diagnose → auto-fix)</li>
                        <li>⚠ Only running while your machine is on (laptop sleep / reboot pauses the deploy)</li>
                      </ul>
                    </div>
                  </div>
                </label>

                {/* Option 2: Remote SSH server */}
                <label className={`block border rounded-lg p-4 cursor-pointer transition ${
                  data.deployment_target === 'remote_ssh'
                    ? 'border-blue-400 bg-blue-50'
                    : 'border-slate-200 bg-white hover:border-blue-300'
                }`}>
                  <div className="flex gap-3 items-start">
                    <input
                      type="radio"
                      name="deployment_target"
                      className="mt-1"
                      checked={data.deployment_target === 'remote_ssh'}
                      onChange={() => setField('deployment_target', 'remote_ssh')}
                    />
                    <div className="flex-1">
                      <p className="font-semibold text-sm text-slate-900">A remote SSH server I already have</p>
                      <p className="text-xs text-slate-700 mt-1">
                        WatchTower deploys via rsync + a remote reload command. Works for any Linux box you can
                        SSH into — VPS, home Pi over Tailscale, friend's box.
                      </p>
                      <ul className="text-[11px] text-slate-600 mt-2 space-y-0.5">
                        <li>✅ 24/7 deploy if the box is up 24/7</li>
                        <li>✅ Public URL if the box is publicly addressable</li>
                        <li>⚙ Needs SSH key + reload command (we'll guide you)</li>
                      </ul>
                      {data.deployment_target === 'remote_ssh' && hasNodes === false && (
                        <div className="mt-3 rounded border border-amber-300 bg-amber-50 px-3 py-2 text-xs">
                          <p className="text-amber-900">No servers added yet — you'll add one in the Servers tab after creating this project, or click below to do it now.</p>
                          <Link to="/servers" className="inline-block mt-1 text-amber-900 underline">
                            → Add a server now
                          </Link>
                        </div>
                      )}
                    </div>
                  </div>
                </label>

                {/* Option 3: I need a hosting target */}
                <label className={`block border rounded-lg p-4 cursor-pointer transition ${
                  data.deployment_target === 'cloud_setup'
                    ? 'border-violet-400 bg-violet-50'
                    : 'border-slate-200 bg-white hover:border-violet-300'
                }`}>
                  <div className="flex gap-3 items-start">
                    <input
                      type="radio"
                      name="deployment_target"
                      className="mt-1"
                      checked={data.deployment_target === 'cloud_setup'}
                      onChange={() => setField('deployment_target', 'cloud_setup')}
                    />
                    <div className="flex-1">
                      <p className="font-semibold text-sm text-slate-900">I need a server (help me pick one)</p>
                      <p className="text-xs text-slate-700 mt-1">
                        WatchTower itself doesn't host servers. Pick a cheap or free cloud Linux box, then come back
                        and choose <em>"A remote SSH server I already have"</em> with its IP.
                      </p>
                      {data.deployment_target === 'cloud_setup' && (
                        <div className="mt-3 space-y-2">
                          <p className="text-[11px] font-semibold text-slate-800 uppercase tracking-wide">Cheapest viable options</p>
                          <div className="grid sm:grid-cols-2 gap-2">
                            <a
                              href="https://www.oracle.com/cloud/free/"
                              target="_blank"
                              rel="noopener noreferrer"
                              className="block rounded border border-slate-300 bg-white hover:border-slate-500 p-2.5 text-xs"
                            >
                              <p className="font-semibold text-slate-900">Oracle Cloud Always Free</p>
                              <p className="text-slate-600 mt-0.5">$0 forever · 4 ARM cores · 24 GB RAM · public IP</p>
                            </a>
                            <a
                              href="https://www.hetzner.com/cloud/"
                              target="_blank"
                              rel="noopener noreferrer"
                              className="block rounded border border-slate-300 bg-white hover:border-slate-500 p-2.5 text-xs"
                            >
                              <p className="font-semibold text-slate-900">Hetzner CAX11</p>
                              <p className="text-slate-600 mt-0.5">~$4.59/mo · 2 ARM · 4 GB RAM · billed hourly</p>
                            </a>
                            <a
                              href="https://www.digitalocean.com/pricing/droplets"
                              target="_blank"
                              rel="noopener noreferrer"
                              className="block rounded border border-slate-300 bg-white hover:border-slate-500 p-2.5 text-xs"
                            >
                              <p className="font-semibold text-slate-900">DigitalOcean</p>
                              <p className="text-slate-600 mt-0.5">$4–6/mo · 1 vCPU · 1 GB RAM · public IP</p>
                            </a>
                            <a
                              href="https://tailscale.com/"
                              target="_blank"
                              rel="noopener noreferrer"
                              className="block rounded border border-slate-300 bg-white hover:border-slate-500 p-2.5 text-xs"
                            >
                              <p className="font-semibold text-slate-900">Tailscale + this machine</p>
                              <p className="text-slate-600 mt-0.5">Free · this machine, accessible privately from anywhere</p>
                            </a>
                          </div>
                          <p className="text-[11px] text-slate-600 mt-1">
                            After you have a Linux box: install Podman, ensure SSH access works,
                            then come back here and switch to <em>"A remote SSH server I already have."</em>
                          </p>
                        </div>
                      )}
                    </div>
                  </div>
                </label>
              </div>
              <div className="mt-6 flex justify-end gap-2">
                {data.deployment_target === 'cloud_setup' && (
                  <Link to="/" className="text-sm">
                    <Button variant="outline" className="electron-button rounded-md">
                      Save and come back later
                    </Button>
                  </Link>
                )}
                <Button onClick={() => setStep(2)} disabled={!canContinue} className="electron-accent-bg rounded-md">
                  Continue
                </Button>
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
                        {ghConnected
                          ? 'Browse GitHub Repositories'
                          : ghAuthReady.device
                            ? 'Connect GitHub (Device Code)'
                            : 'Connect GitHub for Repo Access'}
                      </button>
                    </div>
                    <Input id="repo_url" value={data.repo_url} onChange={(e) => setField('repo_url', e.target.value)} className="mt-1.5 rounded-md border-border bg-white" placeholder="https://github.com/owner/repo" />
                    <p className="text-[11px] text-slate-600">
                      Choosing a repo here fills URL and branch. WatchTower clones/downloads the repository when the first deployment is queued.
                    </p>

                    {deviceConnect.open && (
                      <div className="mt-3 border border-indigo-200 rounded-lg bg-indigo-50 p-4 space-y-2">
                        <p className="text-sm font-semibold text-indigo-900">Authorize GitHub Connection</p>
                        <p className="text-xs text-indigo-800">
                          Open GitHub, enter this code, then return here. We will continue automatically once authorized.
                        </p>
                        <div className="flex items-center gap-2">
                          <code className="px-2 py-1 rounded bg-white border border-indigo-200 text-indigo-900 font-semibold tracking-wider">
                            {deviceConnect.userCode || '---'}
                          </code>
                          <a
                            href={deviceConnect.verificationUriComplete || deviceConnect.verificationUri}
                            target="_blank"
                            rel="noreferrer"
                            className="text-xs underline text-indigo-700 hover:text-indigo-900"
                          >
                            Open GitHub Verification
                          </a>
                        </div>
                        {deviceConnect.polling && (
                          <p className="text-xs text-indigo-700 animate-pulse">Waiting for GitHub authorization…</p>
                        )}
                        {deviceConnect.error && (
                          <p className="text-xs text-red-700 bg-red-50 border border-red-200 rounded px-2 py-1">{deviceConnect.error}</p>
                        )}
                      </div>
                    )}

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
                    <div className="mt-1.5 flex gap-2">
                      <Input
                        id="local_folder_path"
                        value={data.local_folder_path}
                        onChange={(e) => setField('local_folder_path', e.target.value)}
                        className="flex-1 rounded-md border-border bg-white"
                        placeholder="/home/you/my-app"
                      />
                      {/* Hidden file input for browser-based folder selection */}
                      <input
                        ref={folderInputRef}
                        type="file"
                        multiple
                        style={{ display: 'none' }}
                        {...({ webkitdirectory: true } as any)}
                        onChange={(e) => {
                          // Extract folder path from first file's path (browser mode)
                          if (e.target.files && e.target.files.length > 0) {
                            const file = e.target.files[0];
                            const webkitRelativePath = (file as any).webkitRelativePath;
                            if (webkitRelativePath) {
                              // Extract the root folder from the path (first segment)
                              const folderName = webkitRelativePath.split('/')[0];
                              // Browser APIs do not expose absolute local paths; this
                              // is a convenience hint only. User must type full path.
                              setField('local_folder_path', folderName || 'selected-folder');
                              setBrowserPickedFolderName(folderName || 'selected-folder');
                            }
                          }
                        }}
                      />
                      <button
                        type="button"
                        onClick={async () => {
                          // Try Electron API first (desktop mode)
                          const electron = (window as unknown as { electronAPI?: { selectFolder?: (opts: { defaultPath?: string }) => Promise<{ ok: boolean; path?: string }> } }).electronAPI;
                          if (electron?.selectFolder) {
                            const result = await electron.selectFolder({
                              defaultPath: data.local_folder_path || undefined,
                            });
                            if (result?.ok && result.path) {
                              setField('local_folder_path', result.path);
                              setBrowserPickedFolderName('');
                            }
                          } else {
                            // Fallback to browser file picker (web mode)
                            folderInputRef.current?.click();
                          }
                        }}
                        className="px-3 py-2 text-sm rounded-md border border-slate-300 bg-white hover:bg-slate-50 text-slate-700 font-medium whitespace-nowrap"
                      >
                        Browse…
                      </button>
                    </div>
                    {!hasElectronFolderPicker && browserPickedFolderName && (
                      <p className="text-xs text-amber-700 mt-1">
                        Browser security only shared the folder name ({browserPickedFolderName}). Please replace it with the full absolute path before continuing.
                      </p>
                    )}
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
                    <Input id="build_command" value={data.build_command} onChange={(e) => setField('build_command', e.target.value)} className="mt-1.5 rounded-md border-border bg-white" placeholder={data.source_type === 'github' ? 'npm install && npm run build' : 'npm run dev'} />
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

                {/* Universal port suggestion. The wizard previously hid
                    the port input inside a docker-only card, so non-docker
                    projects never saw a recommendation at all. Now it's
                    always visible: shows "We'll use port X" prominently,
                    with Edit to override. Surfaces failure explicitly
                    instead of silently falling back to 3000. */}
                <Card className="electron-card-solid rounded-md shadow-none">
                  <CardContent className="py-4 space-y-3">
                    <p className="text-xs font-medium uppercase tracking-wide electron-accent">Port</p>
                    {recommendedPort === null ? (
                      <p className="text-sm text-slate-600">Picking a free port…</p>
                    ) : recommendedPort === 'error' ? (
                      <div className="flex items-center gap-3">
                        <p className="text-sm text-amber-800">
                          Couldn't auto-pick a port (no free port in 3000-3999, or the API is unreachable).
                        </p>
                        <Input
                          id="exposed_port_fallback"
                          type="number"
                          value={data.exposed_port}
                          onChange={(e) => setField('exposed_port', Number(e.target.value || 3000))}
                          className="w-24 rounded-md border-border bg-white"
                        />
                      </div>
                    ) : portEditOpen ? (
                      <div className="flex items-center gap-3">
                        <Label htmlFor="exposed_port" className="text-sm">Use port</Label>
                        <Input
                          id="exposed_port"
                          type="number"
                          value={data.exposed_port}
                          onChange={(e) => setField('exposed_port', Number(e.target.value || 3000))}
                          className="w-24 rounded-md border-border bg-white"
                        />
                        <button
                          type="button"
                          onClick={() => setPortEditOpen(false)}
                          className="text-xs text-slate-600 hover:text-slate-900 underline"
                        >
                          Done
                        </button>
                      </div>
                    ) : (
                      <div className="flex items-center gap-3">
                        <p className="text-sm text-slate-700">
                          We'll deploy on <span className="font-mono font-semibold text-slate-900">port {data.exposed_port}</span>{' '}
                          <span className="text-slate-500">(free, picked from 3000-3999)</span>
                        </p>
                        <button
                          type="button"
                          onClick={() => setPortEditOpen(true)}
                          className="text-xs text-slate-600 hover:text-slate-900 underline"
                        >
                          Edit
                        </button>
                      </div>
                    )}
                  </CardContent>
                </Card>

                {data.use_case === 'docker_platform' && (
                  <Card className="electron-card-solid rounded-md shadow-none">
                    <CardContent className="py-4 space-y-3">
                      <p className="text-xs font-medium uppercase tracking-wide electron-accent">Container Runtime</p>
                      <div>
                        <Label htmlFor="dockerfile_path">Dockerfile Path</Label>
                        <Input id="dockerfile_path" value={data.dockerfile_path} onChange={(e) => setField('dockerfile_path', e.target.value)} className="mt-1.5 rounded-md border-border bg-white" />
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
