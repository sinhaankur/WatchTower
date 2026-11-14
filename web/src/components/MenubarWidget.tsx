/**
 * MenubarWidget — a Tailscale-menu-style status popover for the top bar.
 *
 * Mirrors the structure of Tailscale's macOS menubar menu, which is a great
 * bar for "is everything connected?" at a glance:
 *
 *   ┌──────────────────────────────┐
 *   │ WatchTower            [ ON ] │  ← hero: one toggle + the state word
 *   │ Connected                    │
 *   ├──────────────────────────────┤
 *   │ 👤 you@github               ›│  ← identity (who)
 *   │ This Device: host (100.x.y.z)│  ← this machine + tailnet IP (mono)
 *   ├──────────────────────────────┤
 *   │ ● Tailscale        Connected │  ← the dependencies WatchTower stands on
 *   │ ● Container runtime  Podman  │     (network + container engine — detected,
 *   │                                    never hardcoded; Docker is equal-footing)
 *   ├──────────────────────────────┤
 *   │ Network Devices  (3)        ›│  ← grouped nav, quiet rows + chevrons
 *   │ Settings…                   ›│
 *   │ Version 1.2.3 available   ⤓  │  ← update as a row, not a nag
 *   └──────────────────────────────┘
 *
 * Honesty note: WatchTower is NOT Tailscale and NOT Podman — it's the layer on
 * top of them. The "dependencies" section makes that relationship visible. The
 * container-runtime row reports whichever engine is live (Podman OR Docker);
 * pods are a Podman-only *feature* used for managed DBs and deliberately live on
 * the Containers page, not here.
 *
 * Design tokens follow web/src/theme/TAILSCALE_DESIGN_SPEC.md: hairline dividers,
 * near-zero shadow, soft radius, green used as rare punctuation.
 */

import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  Wifi,
  WifiOff,
  Boxes,
  ChevronRight,
  Monitor,
  Settings as SettingsIcon,
  Download,
  Copy,
  Check,
  Loader2,
  Cpu,
  MemoryStick,
} from 'lucide-react';
import {
  useMe,
  useRemoteAccessState,
  useEnableRemoteAccess,
  useDisableRemoteAccess,
  useRemoteAccessDefaultPort,
  usePairingToken,
  useTailnetDevices,
  usePodmanStatus,
  useUpdateCheck,
  useSystemMetrics,
} from '@/hooks/queries';

/**
 * Inside the Electron tray popover, in-app links must open the MAIN window and
 * dismiss the popover (like Tailscale's dropdown items) — navigating inside the
 * tiny popover window would be wrong. `trayNavigate` is exposed by preload only
 * in that window. Everywhere else (browser chip), fall back to react-router.
 */
type TrayAPI = { trayNavigate?: (hash: string) => void };
function trayApi(): TrayAPI | undefined {
  if (typeof window === 'undefined') return undefined;
  const api = (window as unknown as { electronAPI?: TrayAPI }).electronAPI;
  return api && typeof api.trayNavigate === 'function' ? api : undefined;
}

/** A link that routes correctly whether it's in the tray popover or the SPA. */
function NavTo({
  to,
  onClose,
  className,
  title,
  children,
}: {
  to: string;
  onClose?: () => void;
  className?: string;
  title?: string;
  children: React.ReactNode;
}) {
  const api = trayApi();
  if (api) {
    return (
      <button
        type="button"
        title={title}
        onClick={() => api.trayNavigate!(to)}
        className={`w-full text-left ${className ?? ''}`}
      >
        {children}
      </button>
    );
  }
  return (
    <Link to={to} title={title} onClick={onClose} className={className}>
      {children}
    </Link>
  );
}

export default function MenubarWidget({ onClose }: { onClose: () => void }) {
  const panelRef = useRef<HTMLDivElement>(null);

  // Dismiss on Escape or outside click — behaves like a native menu.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    const onDown = (e: MouseEvent) => {
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) onClose();
    };
    document.addEventListener('keydown', onKey);
    // defer so the opening click doesn't immediately close it
    const t = window.setTimeout(() => document.addEventListener('mousedown', onDown), 0);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('mousedown', onDown);
      window.clearTimeout(t);
    };
  }, [onClose]);

  return (
    <div
      ref={panelRef}
      role="menu"
      aria-label="WatchTower status"
      className="w-80 rounded-2xl border bg-popover text-popover-foreground overflow-hidden"
      style={{ borderColor: 'hsl(var(--border))', boxShadow: 'var(--shadow-hover)' }}
    >
      <Hero />
      <Divider />
      <Identity onClose={onClose} />
      <ThisDevice />
      <Divider />
      <Dependencies onClose={onClose} />
      <Divider />
      <Nav onClose={onClose} />
      <Divider />
      <AppFootprint onClose={onClose} />
    </div>
  );
}

/* ---------------------------------------------------------- app footprint */

/**
 * The appliance's live resource cost — RAM + this app's CPU share. Answers the
 * "how much does it use?" question right where the user is checking status,
 * reinforcing the "lightweight, runs on a PC you already own" product story.
 * Quiet by design: a single muted row, no bars.
 */
function AppFootprint({ onClose }: { onClose?: () => void }) {
  const { data } = useSystemMetrics();
  if (!data) return null;

  const rss = data.process?.rss_mb;
  const cpu = data.process?.cpu_percent;

  return (
    <NavTo
      to="/settings"
      onClose={onClose}
      className="flex items-center gap-3 px-4 py-2 hover:bg-muted/60 transition-colors"
      title="View full system resource usage in Settings"
    >
      <span className="flex items-center gap-1 text-[11px] text-muted-foreground">
        <MemoryStick size={12} />
        {rss != null ? fmtMb(rss) : '—'}
      </span>
      <span className="flex items-center gap-1 text-[11px] text-muted-foreground">
        <Cpu size={12} />
        {cpu != null ? `${cpu.toFixed(1)}%` : '—'}
      </span>
      <span className="ml-auto text-[10px] uppercase tracking-wide text-muted-foreground/70">
        this app
      </span>
    </NavTo>
  );
}

function fmtMb(mb: number): string {
  if (mb >= 1024) return `${(mb / 1024).toFixed(1)} GB`;
  return `${Math.round(mb)} MB`;
}

/* ----------------------------------------------------------------- hero */

function Hero() {
  const { tailscale, installed, ready, sharing } = useRemoteAccessState();
  const { data: portInfo } = useRemoteAccessDefaultPort();
  const enable = useEnableRemoteAccess('tailscale');
  const disable = useDisableRemoteAccess('tailscale');
  const busy = enable.isPending || disable.isPending;

  // The toggle can only act once Tailscale is installed AND the daemon is ready.
  const canToggle = installed && ready && !!tailscale;
  const on = sharing;

  const state = sharing
    ? 'Connected'
    : !installed
      ? 'Tailscale not installed'
      : !ready
        ? 'Tailscale not connected'
        : 'Off';

  const toggle = () => {
    if (!canToggle || busy) return;
    if (on) disable.mutate();
    else enable.mutate({ port: portInfo?.port ?? 8000 });
  };

  return (
    <div className="px-4 pt-4 pb-3">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          {/* Headline whispers (light weight) per the spec. */}
          <p className="text-base font-normal text-foreground leading-tight">WatchTower</p>
          <p
            className={`text-xs mt-0.5 flex items-center gap-1.5 ${
              sharing ? 'text-emerald-500 dark:text-emerald-400' : 'text-muted-foreground'
            }`}
          >
            <span
              className={`inline-block w-1.5 h-1.5 rounded-full ${
                sharing ? 'bg-emerald-500' : 'bg-muted-foreground/40'
              }`}
            />
            {state}
          </p>
        </div>

        <Toggle on={on} disabled={!canToggle || busy} busy={busy} onClick={toggle} />
      </div>

      {sharing && tailscale?.url && <SharingUrl url={tailscale.url} />}

      {!canToggle && (
        <NavTo
          to="/remote-access"
          className="mt-2.5 inline-flex items-center gap-1 text-xs font-medium text-accent hover:underline"
        >
          {installed ? 'Finish Tailscale setup' : 'Set up remote access'}
          <ChevronRight size={12} />
        </NavTo>
      )}
    </div>
  );
}

function Toggle({
  on,
  disabled,
  busy,
  onClick,
}: {
  on: boolean;
  disabled: boolean;
  busy: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={on ? 'Turn off remote access' : 'Turn on remote access'}
      disabled={disabled}
      onClick={onClick}
      className={`relative shrink-0 h-7 w-12 rounded-full transition-colors disabled:opacity-40 disabled:cursor-not-allowed focus:outline-none focus:ring-2 focus:ring-accent/40 ${
        on ? 'bg-emerald-500' : 'bg-muted-foreground/30'
      }`}
    >
      <span
        className={`absolute top-0.5 left-0.5 h-6 w-6 rounded-full bg-white shadow-sm transition-transform flex items-center justify-center ${
          on ? 'translate-x-5' : 'translate-x-0'
        }`}
      >
        {busy && <Loader2 size={13} className="animate-spin text-muted-foreground" />}
      </span>
    </button>
  );
}

function SharingUrl({ url }: { url: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard blocked — ignore */
    }
  };
  return (
    <div className="mt-2.5 flex items-center gap-2 rounded-lg border border-emerald-500/25 bg-emerald-500/[0.07] px-2.5 py-1.5">
      <code className="flex-1 min-w-0 truncate font-mono text-[11px] text-emerald-700 dark:text-emerald-300">
        {url}
      </code>
      <button
        type="button"
        onClick={copy}
        title="Copy URL"
        className="shrink-0 text-emerald-700 dark:text-emerald-300 hover:opacity-80"
      >
        {copied ? <Check size={13} /> : <Copy size={13} />}
      </button>
    </div>
  );
}

/* ------------------------------------------------------------- identity */

function Identity({ onClose }: { onClose?: () => void }) {
  const { data: me } = useMe();
  const initial = (me?.name ?? me?.email ?? '?').slice(0, 1).toUpperCase();
  const label = me?.name ?? me?.email ?? 'Not signed in';
  const sub = me?.org_name ?? (me?.is_github_authenticated ? 'GitHub' : 'Local admin');

  return (
    <NavTo
      to="/account"
      onClose={onClose}
      className="flex items-center gap-2.5 px-4 py-2.5 hover:bg-muted/60 transition-colors"
    >
      {me?.avatar_url ? (
        <img src={me.avatar_url} alt="" className="w-7 h-7 rounded-full border border-border shrink-0" />
      ) : (
        <span className="w-7 h-7 rounded-full bg-muted text-muted-foreground text-xs font-semibold flex items-center justify-center shrink-0 uppercase">
          {initial}
        </span>
      )}
      <div className="min-w-0 flex-1">
        <p className="text-xs font-medium text-foreground truncate">{label}</p>
        <p className="text-[11px] text-muted-foreground truncate">{sub}</p>
      </div>
      <ChevronRight size={14} className="text-muted-foreground shrink-0" />
    </NavTo>
  );
}

/** The friendly device name — Tailscale's MagicDNS label (the first segment of
 *  `<name>.<tailnet>.ts.net`), falling back to the OS hostname. We prefer the
 *  app/device NAME over the raw IP; the IP is an implementation detail. */
function deviceNameFromUrl(url: string | null): string | null {
  if (!url) return null;
  try {
    const host = new URL(url).hostname; // e.g. ankursinhas-macbook-pro-1.tail2d11a0.ts.net
    const label = host.split('.')[0];
    return label || null;
  } catch {
    return null;
  }
}

function ThisDevice() {
  const { data: token } = usePairingToken();
  const { url } = useRemoteAccessState();

  // Name first (from the tailnet URL), host only if it's a real name (not the
  // IP the backend substitutes when Tailscale is up).
  const ip = token?.tailscale_ip ?? null;
  const rawHost = token?.host ?? null;
  const hostIsName = !!rawHost && rawHost !== ip;
  const name = deviceNameFromUrl(url) ?? (hostIsName ? rawHost : null);

  if (!name && !ip) return null;

  return (
    <div className="flex items-center gap-2.5 px-4 pb-2.5 pt-0.5">
      <Monitor size={14} className="text-muted-foreground shrink-0" />
      <p className="text-[11px] text-muted-foreground truncate">
        This device
        {name ? (
          <span className="text-foreground/80"> · {name}</span>
        ) : (
          ip && <span className="font-mono text-foreground/80"> · {ip}</span>
        )}
      </p>
    </div>
  );
}

/* --------------------------------------------------------- dependencies */

/**
 * The layers WatchTower sits on. Deliberately named generically — the container
 * row reports Podman OR Docker, whichever is detected. This is where the
 * "WatchTower is a layer on top, not the thing itself" story is made visible.
 */
function Dependencies({ onClose }: { onClose?: () => void }) {
  const { installed, ready, sharing } = useRemoteAccessState();
  const { data: runtime } = usePodmanStatus();

  const tailscaleOk = installed && ready;
  const tailscaleText = sharing
    ? 'Sharing'
    : tailscaleOk
      ? 'Connected'
      : installed
        ? 'Not connected'
        : 'Not installed';

  // Name the real engine. `binary` is the resolved path/name (e.g. "podman",
  // "docker", or a full path) — show just the engine word, capitalized.
  const engine = runtimeEngineName(runtime?.binary);
  const runtimeOk = !!runtime?.available && !!runtime?.connected;
  const runtimeText = runtime?.available
    ? runtime?.connected
      ? engine
        ? `${engine}${runtime.version ? ` ${runtime.version}` : ''}`
        : 'Connected'
      : 'Not connected'
    : 'Not installed';

  return (
    <div className="py-1">
      <DepRow
        icon={tailscaleOk ? <Wifi size={14} /> : <WifiOff size={14} />}
        label="Tailscale"
        value={tailscaleText}
        ok={tailscaleOk}
        to="/remote-access"
        onClose={onClose}
      />
      <DepRow
        icon={<Boxes size={14} />}
        label="Container runtime"
        value={runtimeText}
        ok={runtimeOk}
        to="/local-containers"
        onClose={onClose}
      />
    </div>
  );
}

/** "/usr/local/bin/podman" → "Podman"; "docker" → "Docker"; null → null. */
function runtimeEngineName(binary: string | null | undefined): string | null {
  if (!binary) return null;
  const base = binary.split('/').pop() ?? binary;
  if (base.includes('podman')) return 'Podman';
  if (base.includes('docker')) return 'Docker';
  return base.charAt(0).toUpperCase() + base.slice(1);
}

function DepRow({
  icon,
  label,
  value,
  ok,
  to,
  onClose,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  ok: boolean;
  to: string;
  onClose?: () => void;
}) {
  return (
    <NavTo
      to={to}
      onClose={onClose}
      className="flex items-center gap-2.5 px-4 py-1.5 hover:bg-muted/60 transition-colors"
    >
      <span className={`shrink-0 ${ok ? 'text-emerald-500 dark:text-emerald-400' : 'text-muted-foreground'}`}>
        {icon}
      </span>
      <span className="text-xs font-medium text-foreground flex-1 min-w-0 truncate">{label}</span>
      <span className={`text-[11px] shrink-0 ${ok ? 'text-emerald-500 dark:text-emerald-400' : 'text-muted-foreground'}`}>
        {value}
      </span>
    </NavTo>
  );
}

/* -------------------------------------------------------------- nav rows */

function Nav({ onClose }: { onClose: () => void }) {
  const { data: devices } = useTailnetDevices();
  const peerCount = devices?.peers?.length ?? 0;
  const { data: update } = useUpdateCheck();

  return (
    <div className="py-1">
      <NavRow to="/remote-access" onClose={onClose} count={peerCount || undefined}>
        Network Devices
      </NavRow>
      <NavRow to="/settings" onClose={onClose} icon={<SettingsIcon size={14} />}>
        Settings
      </NavRow>

      {update?.has_update && update.release_url && (
        <a
          href={update.release_url}
          target="_blank"
          rel="noopener noreferrer"
          onClick={onClose}
          className="flex items-center gap-2.5 px-4 py-2 hover:bg-muted/60 transition-colors"
        >
          <Download size={14} className="text-accent shrink-0" />
          <span className="text-xs font-medium text-foreground flex-1 min-w-0 truncate">
            Version {update.latest} available
          </span>
          <ChevronRight size={14} className="text-muted-foreground shrink-0" />
        </a>
      )}

      {!update?.has_update && update?.current && (
        <p className="px-4 py-2 text-[11px] text-muted-foreground">
          WatchTower {update.current} · up to date
        </p>
      )}
    </div>
  );
}

function NavRow({
  to,
  onClose,
  children,
  count,
  icon,
}: {
  to: string;
  onClose: () => void;
  children: React.ReactNode;
  count?: number;
  icon?: React.ReactNode;
}) {
  return (
    <NavTo
      to={to}
      onClose={onClose}
      className="flex items-center gap-2.5 px-4 py-2 hover:bg-muted/60 transition-colors"
    >
      {icon ? (
        <span className="text-muted-foreground shrink-0">{icon}</span>
      ) : (
        <span className="w-3.5 shrink-0" />
      )}
      <span className="text-xs font-medium text-foreground flex-1 min-w-0 truncate">{children}</span>
      {count != null && (
        <span className="text-[11px] text-muted-foreground tabular-nums">{count}</span>
      )}
      <ChevronRight size={14} className="text-muted-foreground shrink-0" />
    </NavTo>
  );
}

/* --------------------------------------------------------------- shared */

function Divider() {
  return <div className="border-t" style={{ borderColor: 'hsl(var(--border-soft))' }} />;
}
