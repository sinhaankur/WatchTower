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
  installed?: boolean;
  // Platform-aware fields (added in 1.10): when supported is false the
  // feature isn't available on this OS and the UI should render the
  // human-readable `message` instead of trying to toggle anything.
  supported?: boolean;
  platform?: 'mac' | 'linux' | 'windows';
  message?: string;
};

// Structured error payload returned by /runtime/services/{svc}/control
// when the underlying command fails. The UI uses this to offer "Copy
// command" / "Open in Terminal" buttons instead of dumping a wall of
// shell error text on the user.
type ControlErrorDetail = {
  message: string;
  command?: string;
  needs_terminal?: boolean;
  platform?: 'mac' | 'linux' | 'windows';
};

// Shared "this card is for Linux only" presentation. Used by both the
// Podman watchdog and the WatchTower auto-update daemon cards on
// Mac/Windows. We deliberately render the same icon and title so the
// section structure stays consistent — only the body changes from
// "toggle here" to "doesn't apply on your OS, here's why".
function PlatformNotApplicable({
  title,
  icon,
  status,
}: {
  title: string;
  icon: string;
  status: WatchdogStatus;
}) {
  const platformLabel = status.platform === 'mac' ? 'macOS' : status.platform === 'windows' ? 'Windows' : status.platform;
  return (
    <div className="rounded-xl border border-slate-200 bg-slate-50/40 p-5">
      <div className="flex items-start gap-3">
        <div className="w-10 h-10 rounded-xl flex items-center justify-center text-xl shrink-0 border bg-white border-slate-200 opacity-60">
          {icon}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <h3 className="text-sm font-semibold text-slate-700">{title}</h3>
            <span className="text-[10px] px-1.5 py-0.5 rounded-full border bg-slate-100 border-slate-300 text-slate-600">
              Not applicable on {platformLabel}
            </span>
          </div>
          <p className="text-xs text-slate-600 mt-1">{status.message}</p>
        </div>
      </div>
    </div>
  );
}

type WatchtowerConfig = {
  path: string;
  exists: boolean;
  interval: number;
  monitor_only: boolean;
  cleanup: boolean;
  include: string[];
  exclude: string[];
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
  // When the backend returns a structured failure that the user can
  // resolve interactively (most often "sudo: a password is required"),
  // we surface the attempted command + Copy / Open in Terminal buttons
  // instead of just dumping the raw error. The detail comes from
  // _do_service_control() in runtime.py.
  const [errorDetail, setErrorDetail] = useState<ControlErrorDetail | null>(null);
  const [copied, setCopied] = useState(false);

  const flashMsg = (kind: 'ok' | 'err', text: string) => {
    setMsg({ kind, text });
    setTimeout(() => setMsg(null), 4000);
  };

  const electronAPI: any = typeof window !== 'undefined' ? (window as any).electronAPI : null;

  const copyCommand = async () => {
    if (!errorDetail?.command) return;
    if (electronAPI?.copyText) {
      await electronAPI.copyText(errorDetail.command).catch(() => {});
    } else {
      await navigator.clipboard.writeText(errorDetail.command).catch(() => {});
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 1800);
  };

  const openInTerminal = async () => {
    if (!errorDetail?.command) return;
    // Copy the command first so the user only has to paste + Enter once
    // the terminal window opens. openTerminal() doesn't pass arguments —
    // it's an "open a fresh shell" bridge — so the clipboard is the
    // hand-off mechanism.
    await copyCommand();
    if (electronAPI?.openTerminal) {
      await electronAPI.openTerminal().catch(() => {});
    }
  };

  const doAction = async (action: Action) => {
    setBusy(action);
    setErrorDetail(null);
    try {
      const r = await apiClient.post(`/runtime/services/${service}/control`, { action });
      const resp = r.data as { message: string };
      flashMsg('ok', resp.message);
      onDone?.();
    } catch (err: any) {
      const detail = err?.response?.data?.detail;
      if (detail && typeof detail === 'object' && 'message' in detail) {
        const d = detail as ControlErrorDetail;
        setErrorDetail(d);
        flashMsg('err', d.message);
      } else {
        flashMsg('err', typeof detail === 'string' ? detail : `Failed to ${action} ${service}.`);
      }
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
      {errorDetail?.command && errorDetail.needs_terminal && (
        <div className="mt-1 rounded-lg bg-slate-900 px-3 py-2 text-[11px] font-mono text-slate-200 flex items-center gap-2 overflow-hidden">
          <span className="text-slate-500 shrink-0">$</span>
          <span className="truncate flex-1" title={errorDetail.command}>{errorDetail.command}</span>
          <button
            onClick={() => void copyCommand()}
            className="shrink-0 text-[10px] px-2 py-0.5 rounded bg-slate-700 hover:bg-slate-600 text-slate-200 transition-colors"
          >
            {copied ? 'Copied' : 'Copy'}
          </button>
          {electronAPI?.openTerminal && (
            <button
              onClick={() => void openInTerminal()}
              className="shrink-0 text-[10px] px-2 py-0.5 rounded bg-emerald-700 hover:bg-emerald-600 text-white transition-colors"
              title="Copy this command and open a Terminal window"
            >
              Open Terminal
            </button>
          )}
        </div>
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

  // Mac/Windows: the underlying systemd unit doesn't exist on this OS.
  // Render guidance instead of a useless toggle. `supported === false`
  // is set explicitly by the backend on non-Linux hosts.
  if (watchdog && watchdog.supported === false) {
    return <PlatformNotApplicable title="Podman Auto-Restart Watchdog" icon="🛡️" status={watchdog} />;
  }

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

// ─── WatchTower service card (auto-update daemon) ─────────────────────────────
// Sibling of WatchdogCard. The Podman watchdog brings containers BACK after
// reboot; this service keeps them up to DATE while running. Same UX shape.

function WatchTowerServiceCard() {
  const [status, setStatus] = useState<WatchdogStatus | null>(null);
  const [toggling, setToggling] = useState(false);
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await apiClient.get('/runtime/watchtower-service/status');
      setStatus(r.data as WatchdogStatus);
    } catch { /* non-fatal — endpoint may 503 if systemctl missing */ }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const showMsg = (kind: 'ok' | 'err', text: string) => {
    setMsg({ kind, text });
    setTimeout(() => setMsg((c) => (c?.text === text ? null : c)), 4000);
  };

  const toggle = async () => {
    if (!status) return;
    setToggling(true);
    try {
      const endpoint = status.enabled
        ? '/runtime/watchtower-service/disable'
        : '/runtime/watchtower-service/enable';
      const r = await apiClient.post(endpoint);
      const resp = r.data as { watchdog: WatchdogStatus; message: string };
      setStatus(resp.watchdog);
      showMsg('ok', resp.message);
    } catch (err: any) {
      const detail = err?.response?.data?.detail ?? 'Failed to toggle service.';
      showMsg('err', typeof detail === 'string' ? detail : JSON.stringify(detail));
    } finally {
      setToggling(false);
    }
  };

  const enabled = status?.enabled ?? false;
  const installed = status?.installed ?? false;

  // Mac/Windows: systemd doesn't exist; this card is purely a Linux-server
  // operations toggle. Show platform guidance instead of "Not installed".
  if (status && status.supported === false) {
    return <PlatformNotApplicable title="Auto-Update Daemon" icon="🛡️" status={status} />;
  }

  return (
    <div className={`rounded-xl border p-5 transition-all ${
      enabled ? 'border-emerald-300 bg-emerald-50/40' : 'border-slate-200 bg-white'
    }`}>
      <div className="flex items-start justify-between gap-4">
        <div className="flex items-start gap-3 min-w-0 flex-1">
          <div className={`w-10 h-10 rounded-xl flex items-center justify-center text-xl shrink-0 border ${
            enabled ? 'bg-emerald-50 border-emerald-200' : 'bg-slate-50 border-slate-200'
          }`}>🛡️</div>
          <div className="min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <h3 className="text-sm font-semibold text-slate-900">Auto-Update Daemon</h3>
              <span className={`text-[10px] px-1.5 py-0.5 rounded-full border ${
                enabled
                  ? 'bg-emerald-50 border-emerald-300 text-emerald-700'
                  : installed
                    ? 'bg-slate-50 border-slate-300 text-slate-600'
                    : 'bg-amber-50 border-amber-300 text-amber-800'
              }`}>
                {enabled ? 'Enabled on boot' : installed ? 'Disabled' : 'Not installed'}
              </span>
            </div>
            <p className="text-xs text-slate-600 mt-0.5">
              The <code className="font-mono bg-slate-100 px-1 rounded">watchtower.service</code> systemd unit polls running containers, pulls newer images, and restarts safely. Without it, container updates require manual <code className="font-mono bg-slate-100 px-1 rounded">watchtower update-now</code>.
            </p>
          </div>
        </div>
        {installed && (
          <button
            onClick={toggle}
            disabled={toggling}
            className={`px-3 py-1.5 rounded-lg text-xs font-medium border transition-colors shrink-0 ${
              enabled
                ? 'bg-white text-slate-700 border-slate-300 hover:bg-slate-50'
                : 'bg-emerald-700 text-white border-emerald-800 hover:bg-emerald-800'
            } disabled:opacity-50`}
          >
            {toggling ? '…' : enabled ? 'Disable' : 'Enable'}
          </button>
        )}
      </div>

      {!installed && (
        <div className="mt-3 rounded-lg bg-amber-50 border border-amber-200 px-3 py-2 text-xs text-amber-900">
          The systemd unit isn't installed. Run <code className="font-mono bg-white border border-amber-200 px-1 rounded">scripts/install-watchtower-linux-full.sh</code> once from the source tree to install <code className="font-mono">watchtower.service</code>, then come back here to enable it.
        </div>
      )}

      {msg && (
        <p className={`mt-3 text-xs ${msg.kind === 'ok' ? 'text-emerald-700' : 'text-red-700'}`}>
          {msg.text}
        </p>
      )}
    </div>
  );
}

// ─── Watchtower config card (watchtower.yml editable from UI) ─────────────────

function WatchtowerConfigCard() {
  const [cfg, setCfg] = useState<WatchtowerConfig | null>(null);
  const [draft, setDraft] = useState<WatchtowerConfig | null>(null);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  const [includeText, setIncludeText] = useState('');
  const [excludeText, setExcludeText] = useState('');

  const load = useCallback(async () => {
    try {
      const r = await apiClient.get('/runtime/watchtower/config');
      const data = r.data as WatchtowerConfig;
      setCfg(data);
      setDraft(data);
      setIncludeText((data.include ?? []).join('\n'));
      setExcludeText((data.exclude ?? []).join('\n'));
    } catch { /* non-fatal */ }
  }, []);

  useEffect(() => { void load(); }, [load]);

  if (!cfg || !draft) return null;

  const dirty =
    draft.interval !== cfg.interval ||
    draft.monitor_only !== cfg.monitor_only ||
    draft.cleanup !== cfg.cleanup ||
    includeText.trim() !== (cfg.include ?? []).join('\n').trim() ||
    excludeText.trim() !== (cfg.exclude ?? []).join('\n').trim();

  const save = async () => {
    setSaving(true);
    setMsg(null);
    try {
      const payload = {
        interval: draft.interval,
        monitor_only: draft.monitor_only,
        cleanup: draft.cleanup,
        include: includeText.split('\n').map((s) => s.trim()).filter(Boolean),
        exclude: excludeText.split('\n').map((s) => s.trim()).filter(Boolean),
      };
      const r = await apiClient.put('/runtime/watchtower/config', payload);
      const resp = r.data as { restart: string };
      const restartLabel =
        resp.restart === 'restarted' ? ' Service restarted to apply.'
          : resp.restart === 'restart_failed' ? ' Settings saved but service restart failed — restart manually.'
          : ' Service is not running; settings will apply on next start.';
      setMsg({ kind: 'ok', text: `Saved.${restartLabel}` });
      await load();
    } catch (err: any) {
      const detail = err?.response?.data?.detail ?? 'Failed to save config.';
      setMsg({ kind: 'err', text: typeof detail === 'string' ? detail : JSON.stringify(detail) });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="rounded-xl border border-slate-200 bg-white p-5">
      <div className="flex items-start justify-between gap-4 mb-4">
        <div className="min-w-0">
          <h3 className="text-sm font-semibold text-slate-900">Auto-Update Settings</h3>
          <p className="text-xs text-slate-600 mt-0.5">
            Edit <code className="font-mono bg-slate-100 px-1 rounded text-[11px]">{cfg.path}</code>.
            Changes apply immediately if the service is running.
          </p>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {/* Poll interval */}
        <div>
          <label className="text-xs font-medium text-slate-700 block mb-1">
            Poll interval (seconds)
          </label>
          <input
            type="number"
            min={30}
            max={86400}
            value={draft.interval}
            onChange={(e) => setDraft({ ...draft, interval: Number(e.target.value) })}
            className="w-full text-sm rounded-md border border-slate-300 bg-white px-2 py-1.5"
          />
          <p className="text-[11px] text-slate-500 mt-1">
            Default 300 (5 min). Lower = faster updates + more API load.
          </p>
        </div>

        {/* Toggles */}
        <div className="space-y-2">
          <label className="flex items-start gap-2 text-xs text-slate-700 cursor-pointer">
            <input
              type="checkbox"
              checked={draft.monitor_only}
              onChange={(e) => setDraft({ ...draft, monitor_only: e.target.checked })}
              className="w-3.5 h-3.5 mt-0.5 accent-slate-800"
            />
            <span>
              <span className="font-medium">Monitor-only</span>
              <span className="block text-[11px] text-slate-500">Check for updates but don't apply them. Useful for testing.</span>
            </span>
          </label>
          <label className="flex items-start gap-2 text-xs text-slate-700 cursor-pointer">
            <input
              type="checkbox"
              checked={draft.cleanup}
              onChange={(e) => setDraft({ ...draft, cleanup: e.target.checked })}
              className="w-3.5 h-3.5 mt-0.5 accent-slate-800"
            />
            <span>
              <span className="font-medium">Clean up old images</span>
              <span className="block text-[11px] text-slate-500">After a successful update, remove the previous image.</span>
            </span>
          </label>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mt-4">
        <div>
          <label className="text-xs font-medium text-slate-700 block mb-1">Include (one pattern per line)</label>
          <textarea
            rows={3}
            value={includeText}
            onChange={(e) => setIncludeText(e.target.value)}
            placeholder="(empty = all containers)&#10;web-*&#10;api-prod"
            className="w-full text-xs font-mono rounded-md border border-slate-300 bg-white px-2 py-1.5"
          />
        </div>
        <div>
          <label className="text-xs font-medium text-slate-700 block mb-1">Exclude (one pattern per line)</label>
          <textarea
            rows={3}
            value={excludeText}
            onChange={(e) => setExcludeText(e.target.value)}
            placeholder="postgres-*&#10;redis-prod"
            className="w-full text-xs font-mono rounded-md border border-slate-300 bg-white px-2 py-1.5"
          />
        </div>
      </div>

      <div className="flex items-center justify-end gap-3 mt-4">
        {msg && (
          <p className={`text-xs ${msg.kind === 'ok' ? 'text-emerald-700' : 'text-red-700'}`}>
            {msg.text}
          </p>
        )}
        <button
          onClick={() => void save()}
          disabled={!dirty || saving}
          className="px-3 py-1.5 rounded-lg text-xs font-medium border bg-slate-900 text-white border-slate-800 hover:bg-slate-800 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {saving ? 'Saving…' : 'Save settings'}
        </button>
      </div>
    </div>
  );
}

// ─── Main page ────────────────────────────────────────────────────────────────

type CloudflareCredential = {
  id: string;
  label: string | null;
  account_id: string | null;
  account_name: string | null;
  last_verified_at: string | null;
  created_at: string;
  updated_at: string;
};

function CloudflareSection() {
  const [creds, setCreds] = useState<CloudflareCredential[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [token, setToken] = useState('');
  const [label, setLabel] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [showForm, setShowForm] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const resp = await apiClient.get<CloudflareCredential[]>('/integrations/cloudflare');
      setCreds(resp.data);
    } catch {
      setCreds([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const submit = async () => {
    setError('');
    setSubmitting(true);
    try {
      await apiClient.post('/integrations/cloudflare', {
        api_token: token.trim(),
        label: label.trim() || null,
      });
      setToken('');
      setLabel('');
      setShowForm(false);
      void load();
    } catch (e) {
      const detail = (e as { response?: { data?: { detail?: string } } })?.response?.data?.detail;
      setError(detail || 'Failed to save token');
    } finally {
      setSubmitting(false);
    }
  };

  const remove = async (id: string) => {
    if (!confirm('Remove this Cloudflare connection? Any features using it will stop working.')) return;
    try {
      await apiClient.delete(`/integrations/cloudflare/${id}`);
      void load();
    } catch (e) {
      const detail = (e as { response?: { data?: { detail?: string } } })?.response?.data?.detail;
      setError(detail || 'Failed to delete');
    }
  };

  const reverify = async (id: string) => {
    try {
      await apiClient.post(`/integrations/cloudflare/${id}/verify`);
      void load();
    } catch (e) {
      const detail = (e as { response?: { data?: { detail?: string } } })?.response?.data?.detail;
      setError(detail || 'Re-verification failed');
    }
  };

  return (
    <section className="rounded-xl border border-slate-200 bg-white">
      <header className="px-5 py-4 border-b border-slate-100 flex items-center justify-between">
        <div>
          <h2 className="text-sm font-semibold text-slate-900">Cloudflare</h2>
          <p className="text-xs text-slate-600 mt-0.5">
            Connect a Cloudflare API token to manage DNS, deploy to Pages/Workers, or set up failover (HA) across nodes. Phase 1: token storage.
          </p>
        </div>
        {!showForm && (
          <button
            type="button"
            onClick={() => { setShowForm(true); setError(''); }}
            className="px-3 py-1.5 rounded-lg bg-orange-600 hover:bg-orange-700 text-white text-xs font-medium"
          >
            + Connect Cloudflare
          </button>
        )}
      </header>

      <div className="p-5 space-y-4">
        {error && (
          <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
            {error}
          </div>
        )}

        {showForm && (
          <div className="rounded-lg border border-slate-200 bg-slate-50 p-4 space-y-3">
            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">API token</label>
              <input
                type="password"
                value={token}
                onChange={(e) => setToken(e.target.value)}
                placeholder="cf_…"
                autoComplete="off"
                className="w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm focus:border-orange-600 focus:ring-1 focus:ring-orange-600 outline-none"
              />
              <p className="text-[11px] text-slate-500 mt-1">
                Create one at{' '}
                <a
                  href="https://dash.cloudflare.com/profile/api-tokens"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-orange-700 hover:underline"
                >
                  dash.cloudflare.com → API Tokens
                </a>
                . Recommended scopes: Account.Account Settings:Read, Zone.Zone:Read, Zone.DNS:Edit (Phase 2 needs DNS edit).
              </p>
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">Label (optional)</label>
              <input
                type="text"
                value={label}
                onChange={(e) => setLabel(e.target.value)}
                placeholder="Personal CF"
                maxLength={80}
                className="w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm focus:border-orange-600 focus:ring-1 focus:ring-orange-600 outline-none"
              />
            </div>
            <div className="flex gap-2 justify-end">
              <button
                type="button"
                onClick={() => { setShowForm(false); setToken(''); setLabel(''); setError(''); }}
                className="px-3 py-1.5 rounded-md border border-slate-300 text-xs text-slate-700 hover:bg-slate-100"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => void submit()}
                disabled={submitting || token.trim().length < 20}
                className="px-3 py-1.5 rounded-md bg-orange-600 hover:bg-orange-700 disabled:opacity-50 text-white text-xs font-medium"
              >
                {submitting ? 'Verifying…' : 'Verify & save'}
              </button>
            </div>
          </div>
        )}

        {loading ? (
          <p className="text-xs text-slate-500">Loading…</p>
        ) : creds && creds.length > 0 ? (
          <ul className="divide-y divide-slate-100 border border-slate-200 rounded-lg overflow-hidden">
            {creds.map((c) => (
              <li key={c.id} className="px-4 py-3 flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-sm font-medium text-slate-900 truncate">
                    {c.label || c.account_name || 'Cloudflare'}
                  </p>
                  <p className="text-[11px] text-slate-500 truncate">
                    {c.account_name && <>{c.account_name} · </>}
                    {c.account_id ? <>account <code className="font-mono">{c.account_id.slice(0, 8)}…</code></> : 'no account scope'}
                    {c.last_verified_at && <> · verified {new Date(c.last_verified_at).toLocaleString()}</>}
                  </p>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <button
                    type="button"
                    onClick={() => void reverify(c.id)}
                    className="text-[11px] text-slate-600 hover:text-slate-900 underline underline-offset-2"
                  >
                    Re-verify
                  </button>
                  <button
                    type="button"
                    onClick={() => void remove(c.id)}
                    className="text-[11px] text-red-600 hover:text-red-800 underline underline-offset-2"
                  >
                    Remove
                  </button>
                </div>
              </li>
            ))}
          </ul>
        ) : !showForm && (
          <p className="text-xs text-slate-500">
            No Cloudflare connections yet. Click <strong>Connect Cloudflare</strong> to add an API token.
          </p>
        )}
      </div>
    </section>
  );
}

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

        {/* Watchdogs + auto-update — the autonomy story */}
        <section>
          <h2 className="text-sm font-semibold text-slate-900 mb-3">Autonomous Operation</h2>
          <div className="space-y-3">
            <WatchdogCard podmanInstalled={podman?.installed ?? false} />
            <WatchTowerServiceCard />
            <WatchtowerConfigCard />
          </div>
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
                  // On Mac/Windows we read "running" from podman machine
                  // state instead — but the existing field is good enough
                  // for the start/stop button visibility heuristic.
                  running={podman.running_containers > 0}
                  // enable/disable removed in 1.10: on Mac/Windows the
                  // start/stop now drives `podman machine`, which has no
                  // boot-persistence concept. Linux still uses systemd
                  // under the hood; if you need persistence there, use
                  // the Podman watchdog card above.
                  supportedActions={['start', 'stop', 'restart']}
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

        {/* Cloud account connections — separate from local-tool detection
            since these are credential-based (API tokens), not binary
            checks. Phase 1 covers Cloudflare; Phase 2/3/4 use these
            tokens for DNS / Load Balancer / Tunnel automation. */}
        <CloudflareSection />

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
