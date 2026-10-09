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
import { ExternalLink, Activity, Monitor, RefreshCw, CheckCircle2, XCircle } from 'lucide-react';
import { RemoteAccessDiagram } from '@/components/SectionDiagrams';
import {
  type RemoteAccessProvider,
  type TailnetPeer,
  type PeerHealth,
  useDisableRemoteAccess,
  useEnableRemoteAccess,
  useRemoteAccessDefaultPort,
  useRemoteAccessProviders,
  useTailnetDevices,
  usePeerHealth,
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
        <div className="rounded-lg border border-emerald-200 bg-emerald-500/15 px-3 py-2 space-y-2">
          <p className="text-xs uppercase tracking-wide text-emerald-500 dark:text-emerald-400 font-semibold">
            Sharing on
          </p>
          <div className="flex items-center gap-2">
            <code className="flex-1 font-mono text-xs text-emerald-900 break-all">
              {provider.url}
            </code>
            <button
              onClick={copyUrl}
              className="px-2 py-1 rounded-md border border-emerald-300 bg-card text-xs text-emerald-800 hover:bg-emerald-100 transition-colors"
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
  const peers = data?.peers ?? [];
  const managed = peers.filter((p) => p.runs_watchtower);
  const others = peers.filter((p) => !p.runs_watchtower);

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
            <DeviceRow key={peer.ip} peer={peer} />
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
    </section>
  );
}

function DeviceRow({ peer }: { peer: TailnetPeer }) {
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
          <a
            href={peer.watchtower_url}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-accent text-accent-foreground text-xs font-medium hover:bg-accent/90 transition-colors"
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
