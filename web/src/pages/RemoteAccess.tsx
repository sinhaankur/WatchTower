/**
 * RemoteAccess — expose WatchTower beyond this host without leaving the UI.
 *
 * Phase 1: Tailscale only. The page is provider-agnostic so Cloudflare
 * Tunnel and SSH reverse tunnels slot in as additional cards later.
 *
 * For each provider we render one of four card states:
 *   • not installed   → install link + "Refresh after install" button
 *   • not ready       → hint (e.g. "sudo tailscale up") + refresh
 *   • ready / off     → port input + Enable button
 *   • sharing         → URL + copy + Stop button
 */

import { useEffect, useState } from 'react';
import { ExternalLink, Activity, Monitor, RefreshCw, CheckCircle2, XCircle, Link2, Boxes } from 'lucide-react';
import { RemoteAccessDiagram } from '@/components/SectionDiagrams';
import {
  type RemoteAccessProvider,
  type TailnetPeer,
  type PeerHealth,
  type ManagedDevice,
  type DeviceView,
  useDisableRemoteAccess,
  useEnableRemoteAccess,
  useRemoteAccessDefaultPort,
  useRemoteAccessProviders,
  useTailnetDevices,
  usePeerHealth,
  useManagedDevices,
  usePairDevice,
  useUnpairDevice,
  useDeviceView,
} from '@/hooks/queries';

export default function RemoteAccess() {
  const { data: providers, isLoading, error, refetch, isFetching } = useRemoteAccessProviders();
  const { data: portInfo } = useRemoteAccessDefaultPort();
  const defaultPort = portInfo?.port ?? 8000;

  return (
    <div className="flex-1 overflow-auto bg-transparent">
      <header
        className="px-4 sm:px-6 lg:px-8 py-4 flex items-center justify-between border-b sticky top-0 z-10 backdrop-blur-sm"
        style={{ borderColor: 'hsl(var(--border-soft))', background: 'hsl(var(--surface-soft) / 0.9)' }}
      >
        <div>
          <h1 className="text-lg font-semibold text-foreground">Remote Access</h1>
          <p className="text-xs text-muted-foreground mt-0.5 hidden sm:block">
            Reach this WatchTower install from outside your network — phones, laptops, other servers.
          </p>
        </div>
        <button
          onClick={() => refetch()}
          disabled={isFetching}
          className="px-3 py-1.5 rounded-lg border border-border text-xs text-foreground/90 hover:bg-muted transition-colors disabled:opacity-50"
        >
          {isFetching ? 'Refreshing…' : 'Refresh'}
        </button>
      </header>

      <main className="px-4 sm:px-6 lg:px-8 py-6 max-w-2xl mx-auto space-y-5 fade-in-up">
        <RemoteAccessDiagram />
        <div className="rounded-xl border border-blue-500/20 bg-blue-500/10 px-5 py-4 text-xs text-blue-700 dark:text-blue-300 space-y-1">
          <p className="font-semibold">How this works</p>
          <p>
            WatchTower runs on this machine and listens on <code className="font-mono">localhost:{defaultPort}</code>.
            A remote-access provider exposes that port over a secure channel so you can use the dashboard
            from anywhere — without opening ports, port-forwarding, or running another proxy.
          </p>
        </div>

        {isLoading && (
          <div className="rounded-xl border border-border bg-card p-6 text-sm text-muted-foreground">
            Loading providers…
          </div>
        )}

        {error && (
          <div className="rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
            Could not load remote-access providers. Is the API reachable?
          </div>
        )}

        {providers?.map((p) => (
          <ProviderCard key={p.id} provider={p} defaultPort={defaultPort} />
        ))}

        {/* Devices on the tailnet you can open/manage — the other direction:
            not exposing THIS box, but reaching your OTHER WatchTower boxes. */}
        <TailnetDevices />

        {/* Placeholder for future providers — purely informational. */}
        <div className="rounded-xl border border-dashed border-border bg-transparent p-5 text-xs text-muted-foreground">
          <p className="font-semibold text-muted-foreground">Coming next</p>
          <p className="mt-1">
            Cloudflare Tunnel (public sharing under your own domain) and direct SSH reverse tunnels
            will appear here as additional providers.
          </p>
        </div>
      </main>
    </div>
  );
}

/* ---------------------------------------------------------------- card */

function ProviderCard({
  provider,
  defaultPort,
}: {
  provider: RemoteAccessProvider;
  defaultPort: number;
}) {
  const [port, setPort] = useState<number>(defaultPort);
  const [copied, setCopied] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  // Sync port default once we learn it from the backend probe.
  useEffect(() => {
    setPort(defaultPort);
  }, [defaultPort]);

  const enable = useEnableRemoteAccess(provider.id);
  const disable = useDisableRemoteAccess(provider.id);
  const busy = enable.isPending || disable.isPending;

  const doEnable = () => {
    setActionError(null);
    enable.mutate(
      { port },
      {
        onError: (err) => {
          const detail =
            (err as { response?: { data?: { detail?: string } } })?.response?.data?.detail;
          setActionError(typeof detail === 'string' ? detail : 'Failed to enable sharing.');
        },
      },
    );
  };

  const doDisable = () => {
    setActionError(null);
    disable.mutate(undefined, {
      onError: (err) => {
        const detail =
          (err as { response?: { data?: { detail?: string } } })?.response?.data?.detail;
        setActionError(typeof detail === 'string' ? detail : 'Failed to stop sharing.');
      },
    });
  };

  const copyUrl = async () => {
    if (!provider.url) return;
    try {
      await navigator.clipboard.writeText(provider.url);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard blocked — ignore */
    }
  };

  return (
    <div className="rounded-xl border border-border bg-card p-6 space-y-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <h2 className="text-base font-semibold text-foreground">{provider.name}</h2>
            <StatusBadge provider={provider} />
          </div>
          {provider.detail && (
            <p className="text-xs text-muted-foreground mt-1">{provider.detail}</p>
          )}
        </div>
      </div>

      {provider.hint && (
        <div className="rounded-lg border border-accent/25 bg-accent/10 px-3 py-2 text-xs text-accent">
          {provider.hint}
        </div>
      )}

      {!provider.installed && provider.install_url && (
        <a
          href={provider.install_url}
          target="_blank"
          rel="noreferrer"
          className="inline-block px-3 py-1.5 rounded-lg border border-border text-xs text-foreground/90 hover:bg-muted transition-colors"
        >
          Install {provider.name} →
        </a>
      )}

      {provider.sharing && provider.url && (
        <div className="rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 space-y-2">
          <p className="text-xs uppercase tracking-wide text-emerald-500 dark:text-emerald-400 font-semibold">
            Sharing on
          </p>
          <div className="flex items-center gap-2">
            <code className="flex-1 font-mono text-xs text-emerald-700 dark:text-emerald-300 break-all">
              {provider.url}
            </code>
            <button
              onClick={copyUrl}
              className="px-2 py-1 rounded-md border border-emerald-500/30 bg-card text-xs text-emerald-700 dark:text-emerald-300 hover:bg-emerald-500/10 transition-colors"
            >
              {copied ? 'Copied' : 'Copy'}
            </button>
            <a
              href={provider.url}
              target="_blank"
              rel="noreferrer"
              className="px-2 py-1 rounded-md border border-emerald-300 bg-card text-xs text-emerald-800 hover:bg-emerald-100 transition-colors"
            >
              Open
            </a>
          </div>
        </div>
      )}

      {provider.ready && !provider.sharing && (
        <div className="flex items-center gap-3">
          <label className="text-xs text-muted-foreground">Local port</label>
          <input
            type="number"
            min={1}
            max={65535}
            value={port}
            onChange={(e) => setPort(Number(e.target.value) || defaultPort)}
            className="w-24 rounded-lg border border-border bg-card px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-accent/50"
          />
          <span className="text-xs text-muted-foreground">
            (WatchTower itself is on <code className="font-mono">{defaultPort}</code>)
          </span>
        </div>
      )}

      {actionError && (
        <div className="rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive break-all">
          {actionError}
        </div>
      )}

      <div className="flex items-center gap-2">
        {provider.ready && !provider.sharing && (
          <button
            onClick={doEnable}
            disabled={busy}
            className="px-3 py-1.5 rounded-lg bg-primary hover:bg-primary/90 text-primary-foreground text-xs font-medium border border-border shadow-retro disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            {enable.isPending ? 'Enabling…' : `Enable ${provider.name}`}
          </button>
        )}
        {provider.sharing && (
          <button
            onClick={doDisable}
            disabled={busy}
            className="px-3 py-1.5 rounded-lg border border-border text-xs text-foreground/90 hover:bg-muted transition-colors disabled:opacity-50"
          >
            {disable.isPending ? 'Stopping…' : 'Stop sharing'}
          </button>
        )}
      </div>
    </div>
  );
}

function StatusBadge({ provider }: { provider: RemoteAccessProvider }) {
  let label = 'Not installed';
  let cls = 'bg-muted text-muted-foreground border-border';
  if (provider.sharing) {
    label = 'Sharing';
    cls = 'bg-emerald-500/15 text-emerald-500 dark:text-emerald-400 border-emerald-500/30';
  } else if (provider.ready) {
    label = 'Ready';
    cls = 'bg-blue-500/15 text-blue-500 dark:text-blue-400 border-blue-500/30';
  } else if (provider.installed) {
    label = 'Needs setup';
    cls = 'bg-accent/10 text-accent border-accent/25';
  }
  return (
    <span className={`text-xs px-2 py-0.5 rounded-full border font-medium ${cls}`}>
      {label}
    </span>
  );
}

/* ------------------------------------------------ tailnet devices (open/manage) */

/**
 * TailnetDevices — the "other direction" of remote access: the machines on
 * your Tailscale tailnet, with the ones running WatchTower openable in one
 * click over the private network. You manage each box in its own real UI —
 * nothing to keep in sync, and the tailnet is the encrypted transport.
 */
function TailnetDevices() {
  const { data, isLoading, error, refetch, isFetching } = useTailnetDevices();
  const { data: paired } = useManagedDevices();
  const [consoleDevice, setConsoleDevice] = useState<ManagedDevice | null>(null);
  const [pairing, setPairing] = useState<TailnetPeer | null>(null);
  const peers = data?.peers ?? [];
  const managed = peers.filter((p) => p.runs_watchtower);
  const others = peers.filter((p) => !p.runs_watchtower);

  // Map a peer's IP → its paired record (if we've paired it for management).
  const pairedByIp = new Map((paired ?? []).map((d) => [d.ip, d]));

  return (
    <section className="rounded-xl border border-border bg-card p-5 space-y-4">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2 min-w-0">
          <Monitor size={16} className="text-accent shrink-0" />
          <div className="min-w-0">
            <h2 className="text-base font-semibold text-foreground">Devices on your tailnet</h2>
            <p className="text-xs text-muted-foreground mt-0.5">
              Open and manage your other WatchTower machines over Tailscale.
            </p>
          </div>
        </div>
        <button
          onClick={() => refetch()}
          disabled={isFetching}
          className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border border-border text-xs text-foreground hover:border-accent/50 hover:bg-muted transition-colors disabled:opacity-50 shrink-0"
        >
          <RefreshCw size={13} className={isFetching ? 'animate-spin' : ''} />
          {isFetching ? 'Scanning…' : 'Rescan'}
        </button>
      </div>

      {isLoading && (
        <p className="text-xs text-muted-foreground">Scanning the tailnet…</p>
      )}
      {error && (
        <p className="text-xs text-muted-foreground">
          Couldn’t list tailnet devices. Make sure Tailscale is installed and connected.
        </p>
      )}
      {!isLoading && !error && peers.length === 0 && (
        <p className="text-xs text-muted-foreground">
          No other devices found on your tailnet. When another machine running WatchTower joins,
          it’ll appear here ready to open.
        </p>
      )}

      {managed.length > 0 && (
        <div className="space-y-2">
          {managed.map((peer) => (
            <DeviceRow
              key={peer.ip}
              peer={peer}
              paired={pairedByIp.get(peer.ip) ?? null}
              onPair={() => setPairing(peer)}
              onManage={(dev) => setConsoleDevice(dev)}
            />
          ))}
        </div>
      )}

      {others.length > 0 && (
        <details className="group">
          <summary className="text-xs text-muted-foreground cursor-pointer hover:text-foreground select-none">
            {others.length} other device{others.length === 1 ? '' : 's'} on this tailnet (no WatchTower)
          </summary>
          <div className="mt-2 space-y-1.5">
            {others.map((peer) => (
              <div key={peer.ip} className="flex items-center gap-2 px-3 py-2 text-xs text-muted-foreground">
                <span className={`inline-block w-1.5 h-1.5 rounded-full shrink-0 ${peer.online ? 'bg-emerald-500' : 'bg-muted-foreground/40'}`} />
                <span className="truncate text-foreground/90">{peer.hostname}</span>
                <span className="font-mono">{peer.ip}</span>
                {peer.os && <span className="ml-auto">{peer.os}</span>}
              </div>
            ))}
          </div>
        </details>
      )}

      {pairing && (
        <PairDialog peer={pairing} onClose={() => setPairing(null)} onPaired={(d) => { setPairing(null); setConsoleDevice(d); }} />
      )}
      {consoleDevice && (
        <RemoteConsole device={consoleDevice} onClose={() => setConsoleDevice(null)} />
      )}
    </section>
  );
}

function DeviceRow({
  peer,
  paired,
  onPair,
  onManage,
}: {
  peer: TailnetPeer;
  paired: ManagedDevice | null;
  onPair: () => void;
  onManage: (device: ManagedDevice) => void;
}) {
  const health = usePeerHealth();
  const [live, setLive] = useState<PeerHealth | null>(null);

  const checkHealth = () => {
    setLive(null);
    health.mutate(peer.ip, { onSuccess: setLive });
  };

  // Prefer the live probe (fresh at click) over the discovery-time snapshot.
  const reachable = live ? live.reachable : peer.reachable;
  const version = live?.version ?? peer.watchtower_version;

  return (
    <div className="rounded-lg border border-border bg-background/60 p-3">
      <div className="flex items-center gap-3">
        <span
          className={`inline-block w-2 h-2 rounded-full shrink-0 ${peer.online ? 'bg-emerald-500' : 'bg-muted-foreground/40'}`}
          title={peer.online ? 'Online' : 'Offline'}
        />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium text-foreground truncate flex items-center gap-2">
            {peer.hostname}
            <span className="inline-flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wide text-accent">
              WatchTower{version ? ` ${version}` : ''}
            </span>
          </p>
          <p className="text-xs text-muted-foreground font-mono">
            {peer.ip}
            {reachable != null && (
              <span className={`ml-2 ${reachable ? 'text-emerald-500 dark:text-emerald-400' : 'text-muted-foreground'}`}>
                · {reachable ? 'reachable' : 'unreachable'}
              </span>
            )}
          </p>
        </div>
        <div className="flex items-center gap-1.5 shrink-0">
          <button
            onClick={checkHealth}
            disabled={health.isPending}
            title="Check if this device is reachable right now"
            className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border border-border text-xs text-foreground hover:border-accent/50 hover:bg-muted transition-colors disabled:opacity-50"
          >
            {health.isPending ? (
              <Activity size={13} className="animate-pulse" />
            ) : live ? (
              live.reachable ? <CheckCircle2 size={13} className="text-emerald-500" /> : <XCircle size={13} className="text-destructive" />
            ) : (
              <Activity size={13} />
            )}
            Health
          </button>
          {paired ? (
            <button
              onClick={() => onManage(paired)}
              title="Open this device inside WatchTower"
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-accent text-accent-foreground text-xs font-medium hover:bg-accent/90 transition-colors"
            >
              <Boxes size={13} />
              Manage
            </button>
          ) : (
            <button
              onClick={onPair}
              title="Pair this device so you can manage it from here"
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-accent/40 text-accent text-xs font-medium hover:bg-accent/10 transition-colors"
            >
              <Link2 size={13} />
              Pair
            </button>
          )}
          <a
            href={peer.watchtower_url}
            target="_blank"
            rel="noopener noreferrer"
            title="Open this device's UI in a new browser tab"
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-border text-foreground text-xs font-medium hover:border-accent/50 hover:bg-muted transition-colors"
          >
            Open
            <ExternalLink size={13} />
          </a>
        </div>
      </div>
      {health.isError && (
        <p className="mt-2 text-xs text-destructive">Couldn’t reach this device to check health.</p>
      )}
    </div>
  );
}

/* ---------------------------------------------------------------- pairing + console */

function Overlay({ children, onClose }: { children: React.ReactNode; onClose: () => void }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm" onClick={onClose}>
      <div
        className="bg-card rounded-2xl border border-border shadow-xl w-full max-w-2xl mx-4 max-h-[85vh] overflow-auto"
        onClick={(e) => e.stopPropagation()}
      >
        {children}
      </div>
    </div>
  );
}

function PairDialog({
  peer,
  onClose,
  onPaired,
}: {
  peer: TailnetPeer;
  onClose: () => void;
  onPaired: (device: ManagedDevice) => void;
}) {
  const pair = usePairDevice();
  const [token, setToken] = useState('');
  const [error, setError] = useState<string | null>(null);
  const port = Number(new URL(peer.watchtower_url).port) || 8000;

  const submit = () => {
    if (!token.trim()) return setError('Paste the device’s API token.');
    setError(null);
    pair.mutate(
      { name: peer.hostname, ip: peer.ip, port, token: token.trim() },
      {
        onSuccess: onPaired,
        onError: (err) => {
          const detail = (err as { response?: { data?: { detail?: string } } })?.response?.data?.detail;
          setError(typeof detail === 'string' ? detail : 'Could not pair this device.');
        },
      },
    );
  };

  return (
    <Overlay onClose={onClose}>
      <div className="p-6">
        <h2 className="text-base font-semibold text-foreground">Pair {peer.hostname}</h2>
        <p className="text-xs text-muted-foreground mt-1">
          To manage <span className="font-mono">{peer.ip}</span> from here, paste its API token once.
          It’s stored encrypted and used to authenticate over your tailnet — nothing leaves this machine.
        </p>
        <p className="text-xs text-muted-foreground mt-2">
          On that device: open its WatchTower → Settings → copy the API token.
        </p>
        <input
          type="password"
          value={token}
          onChange={(e) => setToken(e.target.value)}
          placeholder="Paste API token"
          autoComplete="off"
          spellCheck={false}
          className="mt-4 w-full rounded-lg border border-border bg-background px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-accent/50"
        />
        {error && (
          <div className="mt-3 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive break-all">
            {error}
          </div>
        )}
        <div className="mt-5 flex items-center justify-end gap-2">
          <button
            onClick={onClose}
            disabled={pair.isPending}
            className="px-3 py-1.5 rounded-lg border border-border text-xs text-foreground/90 hover:bg-muted transition-colors disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            onClick={submit}
            disabled={pair.isPending}
            className="px-4 py-1.5 rounded-lg bg-accent text-accent-foreground text-xs font-medium hover:bg-accent/90 transition-colors disabled:opacity-50"
          >
            {pair.isPending ? 'Pairing…' : 'Pair device'}
          </button>
        </div>
      </div>
    </Overlay>
  );
}

const CONSOLE_VIEWS: { id: DeviceView; label: string }[] = [
  { id: 'projects', label: 'Projects' },
  { id: 'containers', label: 'Containers' },
  { id: 'deployments', label: 'Deployments' },
];

/**
 * RemoteConsole — the single-pane, VMware-style inline view of a paired device.
 * Read-first: it shows the remote box's projects / containers / deploys, fetched
 * through the token-authed proxy. Write actions are a deliberate follow-up.
 */
function RemoteConsole({ device, onClose }: { device: ManagedDevice; onClose: () => void }) {
  const unpair = useUnpairDevice();
  const [view, setView] = useState<DeviceView>('projects');
  const { data, isLoading, error } = useDeviceView(device.id, view, true);

  const rows = Array.isArray(data?.data) ? (data!.data as Record<string, unknown>[]) : [];
  const upstreamError = data && data.status >= 400;

  return (
    <Overlay onClose={onClose}>
      <div className="flex items-center justify-between gap-3 px-5 py-4 border-b border-border sticky top-0 bg-card">
        <div className="flex items-center gap-2 min-w-0">
          <Monitor size={16} className="text-accent shrink-0" />
          <div className="min-w-0">
            <h2 className="text-base font-semibold text-foreground truncate">{device.name}</h2>
            <p className="text-xs text-muted-foreground font-mono">{device.ip}:{device.port}</p>
          </div>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <button
            onClick={() => { if (confirm(`Unpair ${device.name}? You can re-pair it anytime.`)) unpair.mutate(device.id, { onSuccess: onClose }); }}
            className="px-2.5 py-1.5 rounded-lg border border-border text-xs text-muted-foreground hover:text-destructive hover:border-destructive/40 transition-colors"
          >
            Unpair
          </button>
          <button onClick={onClose} className="px-2.5 py-1.5 rounded-lg border border-border text-xs text-foreground hover:bg-muted transition-colors">
            Close
          </button>
        </div>
      </div>

      <div className="px-5 pt-3 flex items-center gap-1 border-b border-border">
        {CONSOLE_VIEWS.map((v) => (
          <button
            key={v.id}
            onClick={() => setView(v.id)}
            className={`px-3 py-2 text-xs font-medium border-b-2 -mb-px transition-colors ${
              view === v.id ? 'border-accent text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground'
            }`}
          >
            {v.label}
          </button>
        ))}
      </div>

      <div className="p-5 min-h-[160px]">
        {isLoading && <p className="text-xs text-muted-foreground">Loading {view} from {device.name}…</p>}
        {error && <p className="text-xs text-destructive">Couldn’t reach {device.name}. Is it online on the tailnet?</p>}
        {upstreamError && !error && (
          <p className="text-xs text-destructive">
            {device.name} returned an error ({data?.status}). The stored token may have changed — try re-pairing.
          </p>
        )}
        {!isLoading && !error && !upstreamError && rows.length === 0 && (
          <p className="text-xs text-muted-foreground">No {view} on {device.name}.</p>
        )}
        {!isLoading && !error && !upstreamError && rows.length > 0 && (
          <div className="space-y-1.5">
            {rows.map((row, i) => (
              <div key={(row.id as string) ?? i} className="flex items-center gap-3 rounded-lg border border-border bg-background/60 px-3 py-2 text-xs">
                <span className="font-medium text-foreground truncate">
                  {(row.name as string) ?? (row.id as string) ?? `item ${i + 1}`}
                </span>
                {typeof row.status === 'string' && (
                  <span className="ml-auto font-mono text-muted-foreground">{row.status}</span>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </Overlay>
  );
}
