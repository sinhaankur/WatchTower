import { useEffect, useState } from 'react';
import axios from 'axios';
import apiClient from '@/lib/api';

/**
 * Plug-and-play "Use this PC as the server" card.
 *
 * The primary use case is deploying to your own machine. That shouldn't
 * require the full remote-server flow (host, SSH user, key, reload command)
 * — WatchTower already runs here. One click registers localhost as a deploy
 * target (provider='local', no SSH). Backed by /api/this-pc/{status,use-as-server}.
 *
 * Self-contained on purpose: it probes its own status and calls onRegistered()
 * so the parent can refresh its node list without this component knowing the
 * parent's data shape.
 */
type RuntimeInfo = {
  available: boolean;
  connected: boolean;
  binary: string | null;
  version: string | null;
  hint: string | null;
};

type ThisPcStatus = {
  hostname: string;
  os: string;
  arch: string;
  registered: boolean;
  node_id: string | null;
  node_status: string | null;
  runtime: RuntimeInfo;
  ready: boolean;
};

function IconComputer() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="2" y="3" width="20" height="14" rx="2" />
      <line x1="8" y1="21" x2="16" y2="21" />
      <line x1="12" y1="17" x2="12" y2="21" />
    </svg>
  );
}

export default function UseThisPcCard({ onRegistered }: { onRegistered?: () => void }) {
  const [status, setStatus] = useState<ThisPcStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const r = await apiClient.get<ThisPcStatus>('/this-pc/status');
      setStatus(r.data);
    } catch (err) {
      // Non-fatal: the card just hides its action if it can't probe.
      const detail = axios.isAxiosError(err) ? (err.response?.data as any)?.detail : null;
      setError(typeof detail === 'string' ? detail : 'Could not check this machine.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, []);

  const register = async () => {
    setSubmitting(true);
    setError(null);
    try {
      await apiClient.post('/this-pc/use-as-server');
      await load();
      onRegistered?.();
    } catch (err) {
      const detail = axios.isAxiosError(err) ? (err.response?.data as any)?.detail : null;
      setError(typeof detail === 'string' ? detail : 'Could not register this PC.');
    } finally {
      setSubmitting(false);
    }
  };

  if (loading && !status) {
    return (
      <div className="rounded-lg border border-border bg-card p-5 shadow-retro animate-pulse">
        <div className="h-4 w-40 bg-muted rounded mb-3" />
        <div className="h-3 w-64 bg-muted rounded" />
      </div>
    );
  }

  if (!status) {
    // Couldn't probe — stay quiet rather than show a broken card.
    return null;
  }

  const { runtime } = status;
  const runtimeReady = runtime.available;

  return (
    <div className="rounded-lg border border-border bg-card p-5 shadow-retro">
      <div className="flex items-start gap-4">
        <div className="w-10 h-10 rounded-lg bg-primary/10 text-primary flex items-center justify-center shrink-0">
          <IconComputer />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <h2 className="text-sm font-semibold text-foreground">Use this PC as a server</h2>
            {status.registered && (
              <span className="text-[10px] font-semibold uppercase tracking-wide px-1.5 py-0.5 rounded-full bg-emerald-50 text-emerald-700 border border-emerald-200">
                Registered
              </span>
            )}
          </div>
          <p className="text-xs text-muted-foreground mt-1">
            Deploy to <span className="font-medium text-foreground">{status.hostname}</span>{' '}
            ({status.os} · {status.arch}) with no SSH setup — WatchTower runs the
            deploy locally.
          </p>

          {/* Runtime readiness line */}
          <div className="mt-3 flex items-center gap-2 text-xs">
            <span className={`inline-block w-2 h-2 rounded-full shrink-0 ${runtimeReady ? 'bg-emerald-500' : 'bg-amber-500'}`} />
            <span className="text-muted-foreground">
              {runtimeReady ? (
                <>Container runtime ready{runtime.version ? ` — ${runtime.version}` : ''}{runtime.connected ? '' : ' (not started)'}</>
              ) : (
                <>No container runtime detected — install Podman or Docker to deploy containers.</>
              )}
            </span>
          </div>

          {error && <p className="text-xs text-red-600 mt-2">{error}</p>}

          <div className="mt-4 flex items-center gap-2">
            {status.registered ? (
              <span className="text-xs text-muted-foreground">
                This machine is a deploy target. You can deploy projects to it from Applications.
              </span>
            ) : (
              <button
                type="button"
                onClick={() => void register()}
                disabled={submitting}
                className="px-4 py-2 rounded-md bg-primary hover:bg-primary/90 text-primary-foreground text-sm font-semibold shadow-retro transition-colors disabled:opacity-60 disabled:cursor-wait"
                title={runtimeReady ? 'Register this machine as a one-click deploy target' : 'Registers anyway; install a runtime before deploying containers'}
              >
                {submitting ? 'Setting up…' : 'Use this PC'}
              </button>
            )}
            {!runtimeReady && (
              <a
                href="https://podman.io/get-started"
                target="_blank"
                rel="noopener noreferrer"
                className="px-3 py-2 rounded-md border border-border bg-card text-foreground text-sm font-medium hover:bg-muted transition-colors"
              >
                Install Podman ↗
              </a>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
