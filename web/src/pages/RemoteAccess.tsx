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
import { RemoteAccessDiagram } from '@/components/SectionDiagrams';
import {
  type RemoteAccessProvider,
  useDisableRemoteAccess,
  useEnableRemoteAccess,
  useRemoteAccessDefaultPort,
  useRemoteAccessProviders,
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
          <h1 className="text-lg font-semibold text-slate-900">Remote Access</h1>
          <p className="text-xs text-slate-600 mt-0.5 hidden sm:block">
            Reach this WatchTower install from outside your network — phones, laptops, other servers.
          </p>
        </div>
        <button
          onClick={() => refetch()}
          disabled={isFetching}
          className="px-3 py-1.5 rounded-lg border border-border text-xs text-slate-700 hover:bg-slate-100 transition-colors disabled:opacity-50"
        >
          {isFetching ? 'Refreshing…' : 'Refresh'}
        </button>
      </header>

      <main className="px-4 sm:px-6 lg:px-8 py-6 max-w-2xl mx-auto space-y-5 fade-in-up">
        <RemoteAccessDiagram />
        <div className="rounded-xl border border-blue-100 bg-blue-50 px-5 py-4 text-xs text-blue-800 space-y-1">
          <p className="font-semibold">How this works</p>
          <p>
            WatchTower runs on this machine and listens on <code className="font-mono">localhost:{defaultPort}</code>.
            A remote-access provider exposes that port over a secure channel so you can use the dashboard
            from anywhere — without opening ports, port-forwarding, or running another proxy.
          </p>
        </div>

        {isLoading && (
          <div className="rounded-xl border border-border bg-card p-6 text-sm text-slate-600">
            Loading providers…
          </div>
        )}

        {error && (
          <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
            Could not load remote-access providers. Is the API reachable?
          </div>
        )}

        {providers?.map((p) => (
          <ProviderCard key={p.id} provider={p} defaultPort={defaultPort} />
        ))}

        {/* Placeholder for future providers — purely informational. */}
        <div className="rounded-xl border border-dashed border-border bg-transparent p-5 text-xs text-slate-500">
          <p className="font-semibold text-slate-600">Coming next</p>
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
            <h2 className="text-base font-semibold text-slate-900">{provider.name}</h2>
            <StatusBadge provider={provider} />
          </div>
          {provider.detail && (
            <p className="text-xs text-slate-600 mt-1">{provider.detail}</p>
          )}
        </div>
      </div>

      {provider.hint && (
        <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900">
          {provider.hint}
        </div>
      )}

      {!provider.installed && provider.install_url && (
        <a
          href={provider.install_url}
          target="_blank"
          rel="noreferrer"
          className="inline-block px-3 py-1.5 rounded-lg border border-border text-xs text-slate-700 hover:bg-slate-100 transition-colors"
        >
          Install {provider.name} →
        </a>
      )}

      {provider.sharing && provider.url && (
        <div className="rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 space-y-2">
          <p className="text-[11px] uppercase tracking-wide text-emerald-700 font-semibold">
            Sharing on
          </p>
          <div className="flex items-center gap-2">
            <code className="flex-1 font-mono text-xs text-emerald-900 break-all">
              {provider.url}
            </code>
            <button
              onClick={copyUrl}
              className="px-2 py-1 rounded-md border border-emerald-300 bg-white text-xs text-emerald-800 hover:bg-emerald-100 transition-colors"
            >
              {copied ? 'Copied' : 'Copy'}
            </button>
            <a
              href={provider.url}
              target="_blank"
              rel="noreferrer"
              className="px-2 py-1 rounded-md border border-emerald-300 bg-white text-xs text-emerald-800 hover:bg-emerald-100 transition-colors"
            >
              Open
            </a>
          </div>
        </div>
      )}

      {provider.ready && !provider.sharing && (
        <div className="flex items-center gap-3">
          <label className="text-xs text-slate-600">Local port</label>
          <input
            type="number"
            min={1}
            max={65535}
            value={port}
            onChange={(e) => setPort(Number(e.target.value) || defaultPort)}
            className="w-24 rounded-lg border border-border bg-white px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-red-300"
          />
          <span className="text-xs text-slate-500">
            (WatchTower itself is on <code className="font-mono">{defaultPort}</code>)
          </span>
        </div>
      )}

      {actionError && (
        <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700 break-all">
          {actionError}
        </div>
      )}

      <div className="flex items-center gap-2">
        {provider.ready && !provider.sharing && (
          <button
            onClick={doEnable}
            disabled={busy}
            className="px-3 py-1.5 rounded-lg bg-primary hover:bg-primary/90 text-white text-xs font-medium border border-border shadow-retro disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            {enable.isPending ? 'Enabling…' : `Enable ${provider.name}`}
          </button>
        )}
        {provider.sharing && (
          <button
            onClick={doDisable}
            disabled={busy}
            className="px-3 py-1.5 rounded-lg border border-border text-xs text-slate-700 hover:bg-slate-100 transition-colors disabled:opacity-50"
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
  let cls = 'bg-slate-100 text-slate-500 border-slate-200';
  if (provider.sharing) {
    label = 'Sharing';
    cls = 'bg-emerald-50 text-emerald-700 border-emerald-200';
  } else if (provider.ready) {
    label = 'Ready';
    cls = 'bg-blue-50 text-blue-700 border-blue-200';
  } else if (provider.installed) {
    label = 'Needs setup';
    cls = 'bg-amber-50 text-amber-800 border-amber-200';
  }
  return (
    <span className={`text-[11px] px-2 py-0.5 rounded-full border font-medium ${cls}`}>
      {label}
    </span>
  );
}
