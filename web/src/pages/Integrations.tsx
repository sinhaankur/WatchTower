/**
 * Integrations — shows live status of Docker, Podman, Coolify, Tailscale,
 * Cloudflare and Nginx, plus the Podman auto-restart watchdog toggle.
 * Includes start / stop / restart / enable / disable controls for each service.
 */

import { useEffect, useState, useCallback } from 'react';
import apiClient from '@/lib/api';

// ─── types ────────────────────────────────────────────────────────────────────

type PodmanStatus = {
  installed: boolean;
  version: string | null;
  running_containers: number;
  sample_containers: Array<{ name: string; image: string; state: string }>;
};

type DockerStatus = {
  installed: boolean;
  version: string | null;
  daemon_available: boolean;
  running_containers: number;
  sample_containers: Array<{ name: string; image: string; state: string }>;
};

type TailscaleStatus = {
  installed: boolean;
  version: string | null;
  connected: boolean;
  ip: string | null;
  hostname: string | null;
};

type CloudflaredStatus = {
  installed: boolean;
  version: string | null;
  authenticated: boolean;
  tunnels: Array<{ id: string; name: string; status: string }>;
  auth_hint?: string;
};

type CoolifyStatus = {
  installed: boolean;
  version: string | null;
  source?: string;
};

type NginxStatus = {
  installed: boolean;
  version: string | null;
  running: boolean;
  config_test_ok: boolean;
  config_test_output?: string;
};

type IntegrationsPayload = {
  podman: PodmanStatus;
  docker: DockerStatus;
  coolify: CoolifyStatus;
  tailscale: TailscaleStatus;
  cloudflared: CloudflaredStatus;
  nginx: NginxStatus;
};

type WatchdogStatus = {
  service: string;
  active: boolean;
  enabled: boolean;
  state: string;
};

type InstallCommands = {
  os: string;
  commands: Record<string, string[]>;
};

// ─── helpers ──────────────────────────────────────────────────────────────────

function Dot({ ok }: { ok: boolean }) {
  return (
    <span
      className={`inline-block w-2 h-2 rounded-full shrink-0 ${
        ok ? 'bg-emerald-500 status-pulse' : 'bg-slate-400'
      }`}
    />
  );
}

function Badge({ ok, label }: { ok: boolean; label?: string }) {
  const text = label ?? (ok ? 'Connected' : 'Not detected');
  const cls = ok
    ? 'bg-emerald-50 text-emerald-700 border-emerald-200'
    : 'bg-slate-100 text-slate-500 border-slate-200';
  return (
    <span className={`text-[11px] px-2 py-0.5 rounded-full border font-medium ${cls}`}>
      {text}
    </span>
  );
}

function InstallBlock({ cmds }: { cmds: string[] }) {
  const [copied, setCopied] = useState(false);
  const text = cmds.join('\n');
  const copy = async () => {
    await navigator.clipboard.writeText(text).catch(() => {});
    setCopied(true);
    setTimeout(() => setCopied(false), 1800);
  };
  return (
    <div className="mt-3 rounded-lg bg-slate-900 p-3 text-xs font-mono text-slate-200 relative">
      {cmds.map((c, i) => (
        <div key={i} className="leading-relaxed">{c}</div>
      ))}
      <button
        onClick={() => void copy()}
        className="absolute top-2 right-2 text-[10px] px-2 py-0.5 rounded bg-slate-700 hover:bg-slate-600 text-slate-300 transition-colors"
      >
        {copied ? 'Copied!' : 'Copy'}
      </button>
    </div>
  );
}

// ─── Service controls ─────────────────────────────────────────────────────────

type Action = 'start' | 'stop' | 'restart' | 'enable' | 'disable';

type ControlsProps = {
  service: string;
  running: boolean;
  /** systemd enabled state; undefined means the service doesn't support enable/disable */
  enabled?: boolean;
  /** Actions the service supports */
  supportedActions: Action[];
  onDone?: () => void;
};

function ServiceControls({ service, running, enabled, supportedActions, onDone }: ControlsProps) {
  const [busy, setBusy] = useState<Action | null>(null);
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);

  const flashMsg = (kind: 'ok' | 'err', text: string) => {
    setMsg({ kind, text });
    setTimeout(() => setMsg(null), 4000);
  };

  const doAction = async (action: Action) => {
    setBusy(action);
    try {
      const r = await apiClient.post(`/runtime/services/${service}/control`, { action });
      const resp = r.data as { message: string };
      flashMsg('ok', resp.message);
      onDone?.();
    } catch (err: any) {
      const detail = err?.response?.data?.detail;
      flashMsg('err', typeof detail === 'string' ? detail : `Failed to ${action} ${service}.`);
    } finally {
      setBusy(null);
    }
  };

  const has = (a: Action) => supportedActions.includes(a);

  return (
    <div className="mt-3 flex flex-col gap-2">
      <div className="flex flex-wrap gap-1.5">
        {/* Start / Stop toggle */}
        {has('start') && !running && (
          <button
            onClick={() => void doAction('start')}
            disabled={busy !== null}
            className="px-3 py-1 text-xs font-medium rounded-lg bg-emerald-600 text-white hover:bg-emerald-700 disabled:opacity-50 transition-colors"
          >
            {busy === 'start' ? '…' : '▶ Start'}
          </button>
        )}
        {has('stop') && running && (
          <button
            onClick={() => void doAction('stop')}
            disabled={busy !== null}
            className="px-3 py-1 text-xs font-medium rounded-lg bg-slate-700 text-white hover:bg-slate-800 disabled:opacity-50 transition-colors"
          >
            {busy === 'stop' ? '…' : '⏹ Stop'}
          </button>
        )}
        {/* Restart */}
        {has('restart') && running && (
          <button
            onClick={() => void doAction('restart')}
            disabled={busy !== null}
            className="px-3 py-1 text-xs font-medium rounded-lg border border-slate-300 text-slate-700 hover:bg-slate-100 disabled:opacity-50 transition-colors"
          >
            {busy === 'restart' ? '…' : '↺ Restart'}
          </button>
        )}
        {/* Enable / Disable (boot persistence) */}
        {has('enable') && enabled === false && (
          <button
            onClick={() => void doAction('enable')}
            disabled={busy !== null}
            className="px-3 py-1 text-xs font-medium rounded-lg border border-blue-300 text-blue-700 hover:bg-blue-50 disabled:opacity-50 transition-colors"
            title="Enable auto-start on boot"
          >
            {busy === 'enable' ? '…' : '🔒 Enable on boot'}
          </button>
        )}
        {has('disable') && enabled === true && (
          <button
            onClick={() => void doAction('disable')}
            disabled={busy !== null}
            className="px-3 py-1 text-xs font-medium rounded-lg border border-amber-300 text-amber-700 hover:bg-amber-50 disabled:opacity-50 transition-colors"
            title="Disable auto-start on boot"
          >
            {busy === 'disable' ? '…' : '🔓 Disable on boot'}
          </button>
        )}
      </div>
      {msg && (
        <p className={`text-xs font-medium ${msg.kind === 'ok' ? 'text-emerald-700' : 'text-red-600'}`}>
          {msg.kind === 'ok' ? '✓' : '✗'} {msg.text}
        </p>
      )}
    </div>
  );
}

// ─── Integration card ─────────────────────────────────────────────────────────

type CardProps = {
  icon: string;
  name: string;
  category: string;
  description: string;
  connected: boolean;
  badgeLabel?: string;
  version?: string | null;
  detail?: string | null;
  installCmds?: string[];
  extra?: React.ReactNode;
};

function IntegrationCard({
  icon, name, category, description, connected, badgeLabel, version, detail, installCmds, extra,
}: CardProps) {
  const [showInstall, setShowInstall] = useState(false);

  return (
    <div className={`p-4 rounded-xl border transition-all ${
      connected
        ? 'border-emerald-200 bg-emerald-50/30 hover:border-emerald-300'
        : 'border-border bg-card hover:border-red-300 hover:bg-red-50/20'
    }`}>
      <div className="flex items-start gap-3">
        <div className={`w-10 h-10 rounded-xl flex items-center justify-center text-xl shrink-0 border ${
          connected ? 'bg-emerald-50 border-emerald-200' : 'bg-slate-50 border-border'
        }`}>
          {icon}
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <Dot ok={connected} />
            <p className="text-sm font-semibold text-slate-900">{name}</p>
            <Badge ok={connected} label={badgeLabel} />
            <span className="text-[10px] text-slate-400 bg-slate-100 px-1.5 py-0.5 rounded border border-border">
              {category}
            </span>
          </div>
          <p className="text-xs text-slate-600 mt-1">{description}</p>
          {version && (
            <p className="text-[11px] text-slate-500 mt-0.5 font-mono">{version}</p>
          )}
          {detail && (
            <p className="text-[11px] text-slate-600 mt-0.5">{detail}</p>
          )}
          {extra}
          {!connected && installCmds && installCmds.length > 0 && (
            <div className="mt-2">
              <button
                onClick={() => setShowInstall((v) => !v)}
                className="text-xs text-red-700 hover:text-red-800 font-medium transition-colors"
              >
                {showInstall ? '▲ Hide install steps' : '▼ Show install steps'}
              </button>
              {showInstall && <InstallBlock cmds={installCmds} />}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── Watchdog card ────────────────────────────────────────────────────────────

function WatchdogCard({ podmanInstalled }: { podmanInstalled: boolean }) {
  const [watchdog, setWatchdog] = useState<WatchdogStatus | null>(null);
  const [loading, setLoading] = useState(false);
  const [toggling, setToggling] = useState(false);
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await apiClient.get('/runtime/podman/watchdog');
      setWatchdog(r.data as WatchdogStatus);
    } catch { /* non-fatal */ }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const showMsg = (kind: 'ok' | 'err', text: string) => {
    setMsg({ kind, text });
    setTimeout(() => setMsg((c) => (c?.text === text ? null : c)), 4000);
  };

  const toggle = async () => {
    if (!watchdog) return;
    setToggling(true);
    try {
      const endpoint = watchdog.enabled
        ? '/runtime/podman/watchdog/disable'
        : '/runtime/podman/watchdog/enable';
      const r = await apiClient.post(endpoint);
      const resp = r.data as { watchdog: WatchdogStatus; message: string };
      setWatchdog(resp.watchdog);
      showMsg('ok', resp.message);
    } catch (err: any) {
      const detail = err?.response?.data?.detail ?? 'Failed to toggle watchdog.';
      showMsg('err', typeof detail === 'string' ? detail : JSON.stringify(detail));
    } finally {
      setToggling(false);
    }
  };

  const enabled = watchdog?.enabled ?? false;
  const active = watchdog?.active ?? false;

  return (
    <div className={`rounded-xl border p-5 transition-all ${
      enabled
        ? 'border-emerald-300 bg-emerald-50/40'
        : 'border-amber-200 bg-amber-50/30'
    }`}>
      <div className="flex items-start justify-between gap-4">
        <div className="flex items-start gap-3 min-w-0 flex-1">
          <div className={`w-10 h-10 rounded-xl flex items-center justify-center text-xl shrink-0 border ${
            enabled ? 'bg-emerald-50 border-emerald-200' : 'bg-amber-50 border-amber-200'
          }`}>
            🛡️
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 flex-wrap">
              <Dot ok={enabled && active} />
              <p className="text-sm font-semibold text-slate-900">Podman Auto-Restart Watchdog</p>
              {loading ? (
                <span className="text-[11px] text-slate-400">checking…</span>
              ) : (
                <Badge
                  ok={enabled}
                  label={enabled ? (active ? 'Active' : 'Enabled (inactive)') : 'Disabled'}
                />
              )}
            </div>
            <p className="text-xs text-slate-600 mt-1">
              Automatically restarts Podman containers on PC reboot or crash.
              Containers must be started with <code className="font-mono bg-slate-100 px-1 rounded">--restart=always</code>.
            </p>
            <p className="text-xs text-slate-500 mt-1">
              Service: <code className="font-mono">{watchdog?.service ?? 'podman-restart.service'}</code>
              {watchdog && (
                <span className="ml-2 text-slate-400">— {watchdog.state}</span>
              )}
            </p>
            {!podmanInstalled && (
              <p className="text-xs text-amber-700 mt-1">⚠ Podman not detected. Install Podman first.</p>
            )}
            {msg && (
              <p className={`text-xs mt-2 font-medium ${msg.kind === 'ok' ? 'text-emerald-700' : 'text-red-600'}`}>
                {msg.text}
              </p>
            )}
          </div>
        </div>
        <div className="shrink-0">
          <button
            onClick={() => void toggle()}
            disabled={toggling || loading || !podmanInstalled}
            className={`relative inline-flex items-center h-6 w-11 rounded-full border-2 transition-colors duration-200 focus:outline-none disabled:opacity-40 ${
              enabled ? 'bg-emerald-500 border-emerald-600' : 'bg-slate-200 border-slate-300'
            }`}
            title={enabled ? 'Disable watchdog' : 'Enable watchdog'}
            aria-label={enabled ? 'Disable Podman watchdog' : 'Enable Podman watchdog'}
          >
            <span
              className={`inline-block w-4 h-4 bg-white rounded-full shadow-sm transform transition-transform duration-200 ${
                enabled ? 'translate-x-5' : 'translate-x-0.5'
              }`}
            />
          </button>
        </div>
      </div>

      {enabled && (
        <div className="mt-3 pt-3 border-t border-emerald-200">
          <p className="text-xs text-emerald-700 font-medium">
            ✓ Watchdog is active — Podman will auto-restart your containers after any reboot or crash.
          </p>
          <p className="text-[11px] text-slate-500 mt-1">
            To restart all containers now: <code className="font-mono bg-slate-100 px-1 rounded">sudo systemctl start podman-restart.service</code>
          </p>
        </div>
      )}

      {!enabled && (
        <div className="mt-3 pt-3 border-t border-amber-200">
          <p className="text-xs text-amber-700">
            Without the watchdog, your containers will stay offline after a reboot until you manually start them.
          </p>
        </div>
      )}
    </div>
  );
}

// ─── Main page ────────────────────────────────────────────────────────────────

const Integrations = () => {
  const [data, setData] = useState<IntegrationsPayload | null>(null);
  const [installCmds, setInstallCmds] = useState<InstallCommands | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const [statusRes, cmdsRes] = await Promise.allSettled([
        apiClient.get('/runtime/integrations/status'),
        apiClient.get('/runtime/integrations/install-commands'),
      ]);
      if (statusRes.status === 'fulfilled') {
        setData(statusRes.value.data as IntegrationsPayload);
      }
      if (cmdsRes.status === 'fulfilled') {
        setInstallCmds(cmdsRes.value.data as InstallCommands);
      }
      if (statusRes.status === 'rejected') {
        setError('Could not load integration status. Is the API reachable?');
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const podman = data?.podman;
  const docker = data?.docker;
  const tailscale = data?.tailscale;
  const cloudflared = data?.cloudflared;
  const coolify = data?.coolify;
  const nginx = data?.nginx;
  const cmds = installCmds?.commands ?? {};

  const connectedCount = [
    podman?.installed,
    docker?.daemon_available,
    tailscale?.connected,
    cloudflared?.authenticated,
    coolify?.installed,
    nginx?.running,
  ].filter(Boolean).length;

  return (
    <div className="flex-1 overflow-auto bg-slate-50">
      <header
        className="px-4 sm:px-6 lg:px-8 py-4 flex items-center justify-between border-b sticky top-0 z-10 backdrop-blur-sm"
        style={{ borderColor: 'hsl(var(--border-soft))', background: 'hsl(var(--surface-soft) / 0.9)' }}
      >
        <div>
          <h1 className="text-lg font-semibold text-slate-900">Integrations</h1>
          <p className="text-xs text-slate-600 mt-0.5">
            {loading
              ? 'Checking connections…'
              : `${connectedCount} of 6 connected`}
          </p>
        </div>
        <button
          onClick={() => void load()}
          disabled={loading}
          className="px-3 py-1.5 rounded-lg border border-border text-xs text-slate-700 hover:bg-slate-100 transition-colors disabled:opacity-50"
        >
          {loading ? '…' : '↻ Refresh'}
        </button>
      </header>

      <main className="px-4 sm:px-6 lg:px-8 py-6 space-y-6 max-w-5xl mx-auto w-full">
        {error && (
          <div className="rounded-xl border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-700">
            ⚠ {error}
          </div>
        )}

        {/* Health bar */}
        {!loading && data && (
          <div className="flex items-center gap-2 flex-wrap">
            {[
              { label: 'Podman', ok: podman?.installed ?? false },
              { label: 'Docker', ok: docker?.daemon_available ?? false },
              { label: 'Tailscale', ok: tailscale?.connected ?? false },
              { label: 'Cloudflare', ok: cloudflared?.authenticated ?? false },
              { label: 'Coolify', ok: coolify?.installed ?? false },
              { label: 'Nginx', ok: nginx?.running ?? false },
            ].map(({ label, ok }) => (
              <span
                key={label}
                className={`flex items-center gap-1.5 text-xs px-2.5 py-1 rounded-full border font-medium ${
                  ok
                    ? 'bg-emerald-50 text-emerald-700 border-emerald-200'
                    : 'bg-slate-100 text-slate-500 border-slate-200'
                }`}
              >
                <span className={`w-1.5 h-1.5 rounded-full ${ok ? 'bg-emerald-500' : 'bg-slate-400'}`} />
                {label}
              </span>
            ))}
          </div>
        )}

        {/* Podman watchdog — primary feature */}
        <section>
          <h2 className="text-sm font-semibold text-slate-900 mb-3">Auto-Restart Watchdog</h2>
          <WatchdogCard podmanInstalled={podman?.installed ?? false} />
        </section>

        {/* Integration cards */}
        <section>
          <h2 className="text-sm font-semibold text-slate-900 mb-3">Container Runtimes</h2>
          <div className="space-y-3">
            <IntegrationCard
              icon="🦭"
              name="Podman"
              category="Containers"
              description="Daemonless container engine. WatchTower deploys apps as Podman containers. The watchdog above ensures containers survive reboots."
              connected={podman?.installed ?? false}
              badgeLabel={podman?.installed ? `${podman.running_containers} running` : 'Not installed'}
              version={podman?.version ?? null}
              detail={
                podman?.sample_containers.length
                  ? `Containers: ${podman.sample_containers.map((c) => c.name).join(', ')}`
                  : undefined
              }
              installCmds={cmds['podman']}
              extra={podman?.installed ? (
                <ServiceControls
                  service="podman"
                  running={podman.running_containers > 0}
                  supportedActions={['start', 'stop', 'restart', 'enable', 'disable']}
                  onDone={() => void load()}
                />
              ) : undefined}
            />
            <IntegrationCard
              icon="🐳"
              name="Docker"
              category="Containers"
              description="Docker container runtime. Can be used alongside Podman. Daemon must be running for deployments."
              connected={docker?.daemon_available ?? false}
              badgeLabel={
                docker?.installed
                  ? docker.daemon_available
                    ? `Daemon up · ${docker.running_containers} running`
                    : 'Installed (daemon down)'
                  : 'Not installed'
              }
              version={docker?.version ?? null}
              detail={
                docker?.sample_containers.length
                  ? `Containers: ${docker.sample_containers.map((c) => c.name).join(', ')}`
                  : undefined
              }
              installCmds={cmds['docker']}
              extra={docker?.installed ? (
                <ServiceControls
                  service="docker"
                  running={docker.daemon_available}
                  supportedActions={['start', 'stop', 'restart', 'enable', 'disable']}
                  onDone={() => void load()}
                />
              ) : undefined}
            />
          </div>
        </section>

        <section>
          <h2 className="text-sm font-semibold text-slate-900 mb-3">Networking & Proxy</h2>
          <div className="space-y-3">
            <IntegrationCard
              icon="🌐"
              name="Tailscale"
              category="VPN / Mesh"
              description="Zero-config VPN mesh. Connects your machines securely without opening firewall ports. WatchTower nodes use Tailscale IPs for safe SSH access."
              connected={tailscale?.connected ?? false}
              badgeLabel={
                tailscale?.connected
                  ? `Connected · ${tailscale.ip}`
                  : tailscale?.installed
                    ? 'Installed (not connected)'
                    : 'Not installed'
              }
              version={tailscale?.version ?? null}
              detail={tailscale?.hostname ? `Hostname: ${tailscale.hostname}` : null}
              installCmds={cmds['tailscale']}
              extra={tailscale?.installed ? (
                <ServiceControls
                  service="tailscale"
                  running={tailscale.connected}
                  supportedActions={['start', 'stop', 'enable', 'disable']}
                  onDone={() => void load()}
                />
              ) : undefined}
            />
            <IntegrationCard
              icon="☁️"
              name="Cloudflare Tunnel"
              category="Tunnel / CDN"
              description="Expose local services to the internet without opening firewall ports. Routes traffic through Cloudflare's network for DDoS protection and SSL."
              connected={cloudflared?.authenticated ?? false}
              badgeLabel={
                cloudflared?.authenticated
                  ? `${cloudflared.tunnels.length} tunnel${cloudflared.tunnels.length !== 1 ? 's' : ''}`
                  : cloudflared?.installed
                    ? 'Installed (not authenticated)'
                    : 'Not installed'
              }
              version={cloudflared?.version ?? null}
              detail={
                cloudflared?.tunnels.length
                  ? `Tunnels: ${cloudflared.tunnels.map((t) => t.name).join(', ')}`
                  : cloudflared?.auth_hint
                    ? cloudflared.auth_hint
                    : null
              }
              installCmds={cmds['cloudflared']}
              extra={cloudflared?.installed ? (
                <ServiceControls
                  service="cloudflared"
                  running={cloudflared.authenticated}
                  supportedActions={['start', 'stop', 'restart', 'enable', 'disable']}
                  onDone={() => void load()}
                />
              ) : undefined}
            />
            <IntegrationCard
              icon="🔀"
              name="Nginx"
              category="Reverse Proxy"
              description="High-performance web server and reverse proxy. Routes HTTP/HTTPS traffic to your containers and handles SSL termination."
              connected={nginx?.running ?? false}
              badgeLabel={
                nginx?.installed
                  ? nginx.running
                    ? 'Running'
                    : 'Installed (stopped)'
                  : 'Not installed'
              }
              version={nginx?.version ?? null}
              detail={
                nginx?.installed
                  ? nginx.config_test_ok
                    ? 'Config test: OK'
                    : `Config issue: ${nginx.config_test_output ?? 'unknown'}`
                  : null
              }
              installCmds={cmds['nginx']}
              extra={nginx?.installed ? (
                <ServiceControls
                  service="nginx"
                  running={nginx.running}
                  supportedActions={['start', 'stop', 'restart', 'enable', 'disable']}
                  onDone={() => void load()}
                />
              ) : undefined}
            />
          </div>
        </section>

        <section>
          <h2 className="text-sm font-semibold text-slate-900 mb-3">Platform</h2>
          <div className="space-y-3">
            <IntegrationCard
              icon="❄️"
              name="Coolify"
              category="PaaS"
              description="Self-hosted PaaS alternative to Heroku/Netlify. Manages app deployments, databases, and services with a web UI. Works alongside WatchTower for full control."
              connected={coolify?.installed ?? false}
              badgeLabel={
                coolify?.installed
                  ? `Detected via ${coolify.source ?? 'unknown'}`
                  : 'Not detected'
              }
              version={coolify?.version ?? null}
              installCmds={cmds['coolify']}
              extra={coolify?.installed ? (
                <ServiceControls
                  service="coolify"
                  running={coolify.installed}
                  supportedActions={['start', 'stop', 'restart']}
                  onDone={() => void load()}
                />
              ) : undefined}
            />
          </div>
        </section>

        {/* How they work together */}
        <section className="rounded-xl border border-blue-200 bg-blue-50 p-5">
          <h2 className="text-sm font-semibold text-slate-900 mb-2">How these work together</h2>
          <div className="space-y-2">
            {[
              {
                icon: '1',
                text: 'Podman (or Docker) runs your app containers. The Watchdog ensures they restart automatically on reboot.',
              },
              {
                icon: '2',
                text: 'Nginx terminates SSL and routes traffic to the right container by hostname.',
              },
              {
                icon: '3',
                text: 'Tailscale gives all your WatchTower nodes a private IP — no firewall changes needed for SSH.',
              },
              {
                icon: '4',
                text: 'Cloudflare Tunnel exposes your app securely to the public internet without opening any ports.',
              },
              {
                icon: '5',
                text: 'Coolify provides a PaaS-style UI on top — WatchTower handles the automation and monitoring layer.',
              },
            ].map(({ icon, text }) => (
              <div key={icon} className="flex items-start gap-3 text-xs text-slate-700">
                <span className="w-5 h-5 rounded-full bg-blue-600 text-white text-[10px] font-bold flex items-center justify-center shrink-0 mt-0.5">
                  {icon}
                </span>
                {text}
              </div>
            ))}
          </div>
        </section>
      </main>
    </div>
  );
};

export default Integrations;
