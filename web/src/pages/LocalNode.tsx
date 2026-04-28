/**
 * LocalNode — "Use this PC as a deployment server"
 *
 * Guides the user through:
 *  1. Choosing a resource profile (Light / Standard / Full)
 *  2. Optionally customising the deploy path
 *  3. Registering localhost as an OrgNode via POST /orgs/{id}/nodes
 *  4. Showing the one-liner that installs & starts the background agent
 */

import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import apiClient from '@/lib/api';
import { trackEvent } from '@/lib/analytics';

/* ------------------------------------------------------------------ types */

type Profile = {
  id: 'light' | 'standard' | 'full';
  label: string;
  icon: string;
  desc: string;
  concurrency: number;
  cpu: string;
  ram: string;
};

type OsType = 'linux' | 'macos' | 'windows';

/* ------------------------------------------------------------------ data */

const PROFILES: Profile[] = [
  {
    id: 'light',
    label: 'Light',
    icon: '🌱',
    desc: 'Ideal for laptops or machines you also use for other work. Runs 1 deployment at a time.',
    concurrency: 1,
    cpu: '≤ 1 core',
    ram: '≤ 512 MB',
  },
  {
    id: 'standard',
    label: 'Standard',
    icon: '⚙️',
    desc: 'Good balance for a dedicated workstation or home server. 2 concurrent deployments.',
    concurrency: 2,
    cpu: '≤ 2 cores',
    ram: '≤ 1 GB',
  },
  {
    id: 'full',
    label: 'Full Power',
    icon: '🚀',
    desc: 'Use everything available. Best for dedicated build machines. 4 concurrent deployments.',
    concurrency: 4,
    cpu: 'Unrestricted',
    ram: 'Unrestricted',
  },
];

function detectOs(): OsType {
  const ua = navigator.userAgent.toLowerCase();
  if (ua.includes('win')) return 'windows';
  if (ua.includes('mac')) return 'macos';
  return 'linux';
}

function installCmd(os: OsType, deployPath: string): string {
  const escaped = deployPath.replace(/"/g, '\\"');
  if (os === 'windows') {
    return `# Run in PowerShell as Administrator\n$env:WT_DEPLOY_PATH="${escaped}"\nSet-Service -Name WatchTowerAgent -StartupType Automatic\nStart-Service WatchTowerAgent`;
  }
  if (os === 'macos') {
    return `# Run in Terminal\nexport WT_DEPLOY_PATH="${escaped}"\ncurl -fsSL https://get.watchtower.sh | bash -s -- --mode agent --path "${escaped}"`;
  }
  return `# Run in a terminal (copies a systemd unit)\nexport WT_DEPLOY_PATH="${escaped}"\ncurl -fsSL https://get.watchtower.sh | bash -s -- --mode agent --path "${escaped}"`;
}

/* ------------------------------------------------------------------ component */

export default function LocalNode() {
  

  const [orgId, setOrgId] = useState('');
  const [profile, setProfile] = useState<Profile>(PROFILES[1]);
  const [deployPath, setDeployPath] = useState('/opt/watchtower/agent');
  const [nodeName, setNodeName] = useState('');
  const [os, setOs] = useState<OsType>('linux');
  const [autoRegister, setAutoRegister] = useState(false);

  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [nodeId, setNodeId] = useState('');
  const [copied, setCopied] = useState(false);

  // Custom reload command + key path (when the user has tweaked the
  // suggested defaults from the backend probe).
  const [reloadCommand, setReloadCommand] = useState('');
  const [sshKeyPath, setSshKeyPath] = useState('~/.ssh/id_rsa');
  const [autoDetectedProfile, setAutoDetectedProfile] = useState<string | null>(null);

  /* detect OS, then ask the backend to fully pre-fill from the local probe */
  useEffect(() => {
    const detected = detectOs();
    setOs(detected);
    // Ahead-of-API client-side fallbacks so the form isn't blank if the
    // probe is slow.
    if (detected === 'windows') setDeployPath('C:\\WatchTower\\agent');
    if (detected === 'macos') setDeployPath('/usr/local/var/watchtower/agent');
    setNodeName(`${window.location.hostname || 'this-pc'}-local`);

    // Server-side probe — knows what's actually installed (Podman / Docker /
    // systemd) and picks a profile from real CPU + RAM. Falls back to the
    // client defaults silently on error.
    (async () => {
      try {
        const r = await apiClient.get('/runtime/local-node/suggest-config');
        const cfg = r.data as {
          node_name: string; deploy_path: string; reload_command: string;
          ssh_key_path: string; profile_id: 'light' | 'standard' | 'full';
          max_concurrent_deployments: number;
          detected: { podman_installed: boolean; docker_installed: boolean; cpus: number; ram_gb: number };
        };
        if (cfg.node_name) setNodeName(cfg.node_name);
        if (cfg.deploy_path) setDeployPath(cfg.deploy_path);
        if (cfg.reload_command) setReloadCommand(cfg.reload_command);
        if (cfg.ssh_key_path) setSshKeyPath(cfg.ssh_key_path);
        const matched = PROFILES.find((p) => p.id === cfg.profile_id);
        if (matched) {
          setProfile(matched);
          setAutoDetectedProfile(matched.label);
        }
      } catch {
        /* keep client-side fallbacks */
      }
    })();
  }, []);

  /* load org ID */
  useEffect(() => {
    const load = async () => {
      try {
        const r = await apiClient.get('/context');
        setOrgId((r.data as any)?.organization?.id ?? '');
      } catch { /* ignore */ }
    };
    void load();
  }, []);

  const registerNode = async () => {
    if (!orgId) {
      setError('Cannot determine your organisation. Make sure you are signed in.');
      return;
    }
    setSubmitting(true);
    setError('');
    try {
      // Check for existing local node to avoid duplicates
      const existing = await apiClient.get(`/orgs/${orgId}/nodes`);
      const nodes: Array<{ id: string; host: string }> = (existing.data as any[]) ?? [];
      const localNode = nodes.find((n) => n.host === '127.0.0.1' || n.host === 'localhost');
      if (localNode) {
        setNodeId(localNode.id);
        setStep(3);
        return;
      }

      const payload = {
        name: nodeName || 'local-pc',
        host: '127.0.0.1',
        user: os === 'windows' ? 'SYSTEM' : 'watchtower',
        port: 22,
        remote_path: deployPath,
        ssh_key_path: sshKeyPath || (os === 'windows' ? 'none' : '~/.ssh/id_rsa'),
        reload_command: reloadCommand || (
          os === 'windows'
            ? 'Restart-Service WatchTowerAgent'
            : 'sudo systemctl restart watchtower-agent'
        ),
        is_primary: true,
        max_concurrent_deployments: profile.concurrency,
      };
      const r = await apiClient.post(`/orgs/${orgId}/nodes`, payload);
      setNodeId((r.data as any)?.id ?? '');
      trackEvent('local_node_registered', { profile: profile.id, os });
      setStep(3);
    } catch (err: any) {
      const detail = err?.response?.data?.detail ?? 'Could not register node. Check API connectivity.';
      setError(detail);
    } finally {
      setSubmitting(false);
    }
  };

  const copyCmd = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch { /* ignore */ }
  };

  const cmd = installCmd(os, deployPath);

  return (
    <div className="flex-1 overflow-auto bg-transparent">
      {/* Header */}
      <header
        className="px-4 sm:px-6 lg:px-8 py-4 flex items-center justify-between border-b sticky top-0 z-10 backdrop-blur-sm"
        style={{ borderColor: 'hsl(214 32% 88%)', background: 'rgba(248,251,255,0.9)' }}
      >
        <div>
          <h1 className="text-lg font-semibold text-slate-900">Use This PC as a Server</h1>
          <p className="text-xs text-slate-600 mt-0.5 hidden sm:block">
            Register your machine as a local deployment node in the background
          </p>
        </div>
        <Link
          to="/servers"
          className="px-3 py-1.5 rounded-lg border border-border text-xs text-slate-700 hover:bg-slate-100 transition-colors"
        >
          ← Back to Servers
        </Link>
      </header>

      <main className="px-4 sm:px-6 lg:px-8 py-6 max-w-2xl mx-auto space-y-5 fade-in-up">

        {/* Step progress */}
        <div className="flex items-center gap-0 px-1">
          {(['Choose profile', 'Confirm setup', 'Install agent'] as const).map((label, i) => {
            const idx = (i + 1) as 1 | 2 | 3;
            const done = idx < step;
            const active = idx === step;
            return (
              <div key={idx} className="flex items-center flex-1 last:flex-none">
                <div className="flex items-center gap-1.5">
                  <span className={`w-6 h-6 rounded-full flex items-center justify-center text-[11px] font-semibold border transition-colors ${
                    done    ? 'bg-red-700 text-white border-red-700' :
                    active  ? 'bg-white text-red-700 border-red-400' :
                              'bg-white text-slate-400 border-slate-300'
                  }`}>
                    {done ? '✓' : idx}
                  </span>
                  <span className={`text-xs hidden sm:block ${active ? 'text-slate-900 font-medium' : 'text-slate-400'}`}>{label}</span>
                </div>
                {i < 2 && <div className={`flex-1 h-px mx-2 transition-colors ${done ? 'bg-red-300' : 'bg-slate-200'}`} />}
              </div>
            );
          })}
        </div>

        {/* ── STEP 1: Choose profile ───────────────────────────── */}
        {step === 1 && (
          <div className="rounded-xl border border-border bg-card p-6 space-y-4">
            <div>
              <h2 className="text-base font-semibold text-slate-900">How much of this PC do you want to use?</h2>
              <p className="text-xs text-slate-600 mt-1">
                WatchTower will run as a background service. Pick the resource profile that fits your machine.
              </p>
            </div>

            <div className="space-y-2">
              {PROFILES.map((p) => (
                <label
                  key={p.id}
                  className={`flex gap-4 items-start border rounded-lg p-4 cursor-pointer transition-colors ${
                    profile.id === p.id
                      ? 'border-red-300 bg-red-50'
                      : 'border-border bg-white hover:border-red-200'
                  }`}
                >
                  <input
                    type="radio"
                    name="profile"
                    className="mt-1"
                    checked={profile.id === p.id}
                    onChange={() => setProfile(p)}
                  />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-lg">{p.icon}</span>
                      <span className="font-semibold text-sm text-slate-900">{p.label}</span>
                      <span className="text-[11px] text-slate-500 ml-auto">{p.concurrency} concurrent job{p.concurrency > 1 ? 's' : ''}</span>
                    </div>
                    <p className="text-xs text-slate-600 mt-1">{p.desc}</p>
                    <div className="flex gap-4 mt-2 text-[11px] text-slate-500">
                      <span>CPU: <b>{p.cpu}</b></span>
                      <span>RAM: <b>{p.ram}</b></span>
                    </div>
                  </div>
                </label>
              ))}
            </div>

            {/* OS hint */}
            <div className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-600">
              Detected OS: <strong>{os === 'linux' ? 'Linux' : os === 'macos' ? 'macOS' : 'Windows'}</strong>.
              The install command and service runner will be tailored accordingly.{' '}
              {os !== 'linux' && (
                <button
                  onClick={() => setOs('linux')}
                  className="text-red-700 underline"
                >
                  Switch to Linux
                </button>
              )}
            </div>

            <div className="flex justify-between items-center">
              <div className="flex items-center gap-2">
                <input
                  type="checkbox"
                  id="auto-register"
                  checked={autoRegister}
                  onChange={(e) => setAutoRegister(e.target.checked)}
                  className="w-4 h-4 rounded border-border"
                />
                <label htmlFor="auto-register" className="text-xs text-slate-600 cursor-pointer">
                  Skip confirmation — register immediately
                </label>
              </div>
              <button
                onClick={() => autoRegister ? void registerNode() : setStep(2)}
                className="px-5 py-2 rounded-lg bg-red-700 hover:bg-red-800 text-white text-sm font-medium border border-slate-800 shadow-[2px_2px_0_0_#1f2937] transition-colors"
              >
                {autoRegister ? 'Register Now →' : 'Continue →'}
              </button>
            </div>
          </div>
        )}

        {/* ── STEP 2: Confirm setup ────────────────────────────── */}
        {step === 2 && (
          <div className="rounded-xl border border-border bg-card p-6 space-y-5">
            <div>
              <h2 className="text-base font-semibold text-slate-900">Confirm configuration</h2>
              <p className="text-xs text-slate-600 mt-1">
                This machine will be registered as <code className="font-mono bg-slate-100 px-1 rounded">127.0.0.1</code> in your organisation.
              </p>
            </div>

            {/* Node name */}
            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1" htmlFor="nodeName">
                Node display name
              </label>
              <input
                id="nodeName"
                className="w-full rounded-lg border border-border bg-white px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-red-300"
                value={nodeName}
                onChange={(e) => setNodeName(e.target.value)}
                placeholder="my-laptop"
              />
            </div>

            {/* Deploy path */}
            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1" htmlFor="deployPath">
                Deployment working directory
              </label>
              <input
                id="deployPath"
                className="w-full rounded-lg border border-border bg-white px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-red-300"
                value={deployPath}
                onChange={(e) => setDeployPath(e.target.value)}
                placeholder="/opt/watchtower/agent"
              />
              <p className="text-xs text-slate-500 mt-1">
                WatchTower will check out and build apps in this folder. It must be writable by the agent user.
              </p>
            </div>

            {/* Summary card */}
            <div className="rounded-lg border border-slate-200 bg-slate-50 px-4 py-3 text-xs space-y-1">
              <div className="flex justify-between"><span className="text-slate-500">Host</span><span className="font-mono text-slate-800">127.0.0.1</span></div>
              <div className="flex justify-between"><span className="text-slate-500">Profile</span><span className="text-slate-800">{profile.icon} {profile.label} ({profile.concurrency} job{profile.concurrency > 1 ? 's' : ''})</span></div>
              <div className="flex justify-between"><span className="text-slate-500">Deploy path</span><span className="font-mono text-slate-800 truncate ml-4">{deployPath}</span></div>
              <div className="flex justify-between"><span className="text-slate-500">OS</span><span className="text-slate-800">{os}</span></div>
            </div>

            {error && (
              <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
                {error}
              </div>
            )}

            <div className="flex justify-between">
              <button
                onClick={() => { setError(''); setStep(1); }}
                className="px-4 py-2 rounded-lg border border-border text-sm text-slate-700 hover:bg-slate-100 transition-colors"
              >
                ← Back
              </button>
              <button
                onClick={() => void registerNode()}
                disabled={submitting || !nodeName.trim() || !deployPath.trim()}
                className="px-5 py-2 rounded-lg bg-red-700 hover:bg-red-800 text-white text-sm font-medium border border-slate-800 shadow-[2px_2px_0_0_#1f2937] transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {submitting ? (
                  <span className="inline-flex items-center gap-1.5">
                    <span className="inline-block w-3 h-3 border-2 border-white/40 border-t-white rounded-full animate-spin" />
                    Registering…
                  </span>
                ) : 'Register & Continue →'}
              </button>
            </div>
          </div>
        )}

        {/* ── STEP 3: Install agent ────────────────────────────── */}
        {step === 3 && (
          <div className="rounded-xl border border-border bg-card p-6 space-y-5">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-full bg-emerald-100 border border-emerald-300 flex items-center justify-center text-lg">✓</div>
              <div>
                <h2 className="text-base font-semibold text-slate-900">Node registered!</h2>
                <p className="text-xs text-slate-600">Now start the background agent on this machine.</p>
              </div>
            </div>

            {/* OS tabs */}
            <div className="flex gap-1 border-b border-border pb-2">
              {(['linux', 'macos', 'windows'] as OsType[]).map((o) => (
                <button
                  key={o}
                  onClick={() => setOs(o)}
                  className={`px-3 py-1 rounded-t text-xs font-medium transition-colors ${
                    os === o ? 'bg-red-700 text-white' : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
                  }`}
                >
                  {o === 'linux' ? '🐧 Linux' : o === 'macos' ? '🍎 macOS' : '🪟 Windows'}
                </button>
              ))}
            </div>

            {/* Install command */}
            <div>
              <p className="text-xs font-medium text-slate-700 mb-2">
                Run this command on <strong>this machine</strong> to install and start the WatchTower agent as a background service:
              </p>
              <div className="relative rounded-lg border border-slate-300 bg-slate-950 px-4 py-3 pr-16 font-mono text-xs text-emerald-300 whitespace-pre-wrap overflow-x-auto">
                {cmd}
                <button
                  onClick={() => void copyCmd(cmd)}
                  className="absolute top-2 right-2 px-2 py-1 rounded bg-slate-700 hover:bg-slate-600 text-slate-200 text-[10px] transition-colors"
                >
                  {copied ? '✓ Copied' : 'Copy'}
                </button>
              </div>
              <p className="text-[11px] text-slate-500 mt-2">
                The agent runs as a systemd (Linux), launchd (macOS) or Windows Service — it starts automatically on boot.
              </p>
            </div>

            {/* What happens next */}
            <div className="rounded-lg border border-slate-200 bg-slate-50 px-4 py-3 text-xs space-y-2">
              <p className="font-medium text-slate-800">What happens next</p>
              <ol className="space-y-1 list-decimal list-inside text-slate-600">
                <li>The install script creates a <code className="font-mono bg-white border px-1 rounded">watchtower-agent</code> system user</li>
                <li>It registers a background service and starts it immediately</li>
                <li>The agent polls the WatchTower API and picks up deployments automatically</li>
                <li>Health metrics (CPU / RAM / disk) will appear on the Servers page</li>
              </ol>
            </div>

            {nodeId && (
              <div className="text-[11px] text-slate-500 font-mono">
                Node ID: {nodeId}
              </div>
            )}

            <div className="flex gap-3">
              <Link
                to="/servers"
                className="flex-1 text-center px-4 py-2 rounded-lg border border-border text-sm text-slate-700 hover:bg-slate-100 transition-colors"
              >
                ← View Servers
              </Link>
              <Link
                to="/setup"
                className="flex-1 text-center px-4 py-2 rounded-lg bg-red-700 hover:bg-red-800 text-white text-sm font-medium border border-slate-800 shadow-[2px_2px_0_0_#1f2937] transition-colors"
              >
                Deploy an App →
              </Link>
            </div>
          </div>
        )}

        {/* Info box — always visible */}
        <div className="rounded-xl border border-blue-100 bg-blue-50 px-5 py-4 text-xs text-blue-800 space-y-1">
          <p className="font-semibold">How does this work?</p>
          <p>
            WatchTower installs a lightweight agent process that runs in the background on your PC.
            It watches for new deployments triggered from this dashboard and handles cloning, building,
            and serving your apps — all locally. Your machine stays the server.
          </p>
          <p className="mt-1">
            Your PC must be reachable from the WatchTower API (typically always true when running locally).
            You can pause or remove the node any time from the <Link to="/servers" className="underline">Servers</Link> page.
          </p>
        </div>
      </main>
    </div>
  );
}
