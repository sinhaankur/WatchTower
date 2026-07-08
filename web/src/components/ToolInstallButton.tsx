import { useEffect, useRef, useState } from 'react';
import apiClient from '@/lib/api';

/**
 * One-click install button for a host tool (Podman, nginx, …).
 *
 * Self-contained: probes /runtime/tools/{tool}/install/status to learn whether
 * an unattended install is possible on this host, kicks it off, and polls until
 * it finishes. When auto-install isn't available (no Homebrew/winget/passwordless
 * sudo) it renders nothing — the page's copy-paste recipe stays the fallback.
 *
 * Calls onInstalled() on success so the parent can re-check tool status.
 */
type InstallState = 'idle' | 'running' | 'succeeded' | 'failed';

type StatusResp = {
  tool: string;
  can_install: boolean;
  reason: string | null;
  last_run: { state?: InstallState; exit_code?: number; log_tail?: string };
};

export default function ToolInstallButton({
  tool,
  onInstalled,
}: {
  tool: string;
  onInstalled?: () => void;
}) {
  const [canInstall, setCanInstall] = useState(false);
  const [reason, setReason] = useState<string | null>(null);
  const [state, setState] = useState<InstallState>('idle');
  const [error, setError] = useState<string | null>(null);
  const pollRef = useRef<number | null>(null);

  const loadStatus = async () => {
    try {
      const r = await apiClient.get<StatusResp>(`/runtime/tools/${tool}/install/status`);
      setCanInstall(r.data.can_install);
      setReason(r.data.reason);
      const s = (r.data.last_run?.state as InstallState) ?? 'idle';
      setState(s);
      if (s === 'failed' && r.data.last_run?.log_tail) {
        setError(r.data.last_run.log_tail.split('\n').slice(-3).join(' ').slice(0, 200));
      }
      return s;
    } catch {
      // No status endpoint reachable — hide the button (copy-paste fallback).
      setCanInstall(false);
      return 'idle' as InstallState;
    }
  };

  useEffect(() => {
    void loadStatus();
    return () => {
      if (pollRef.current) window.clearInterval(pollRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tool]);

  const startPolling = () => {
    if (pollRef.current) window.clearInterval(pollRef.current);
    pollRef.current = window.setInterval(async () => {
      const s = await loadStatus();
      if (s === 'succeeded' || s === 'failed') {
        if (pollRef.current) window.clearInterval(pollRef.current);
        pollRef.current = null;
        if (s === 'succeeded') onInstalled?.();
      }
    }, 2500);
  };

  const install = async () => {
    setError(null);
    setState('running');
    try {
      await apiClient.post(`/runtime/tools/${tool}/install`);
      startPolling();
    } catch (err) {
      setState('failed');
      const detail = (err as { response?: { data?: { detail?: string } } })?.response?.data?.detail;
      setError(typeof detail === 'string' ? detail : 'Could not start the install.');
    }
  };

  if (!canInstall && state === 'idle') {
    // Not auto-installable here — let the copy-paste recipe handle it.
    return reason ? (
      <span className="text-[10px] text-muted-foreground" title={reason}>manual install</span>
    ) : null;
  }

  if (state === 'succeeded') {
    return <span className="text-[11px] font-medium text-emerald-700">✓ Installed</span>;
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <button
        type="button"
        onClick={() => void install()}
        disabled={state === 'running'}
        className="px-2.5 py-1 rounded-md bg-primary hover:bg-primary/90 text-primary-foreground text-[11px] font-semibold shadow-retro disabled:opacity-60 disabled:cursor-wait"
      >
        {state === 'running' ? 'Installing…' : state === 'failed' ? 'Retry install' : 'Install'}
      </button>
      {error && <span className="text-[10px] text-red-600 max-w-[180px] text-right">{error}</span>}
    </div>
  );
}
