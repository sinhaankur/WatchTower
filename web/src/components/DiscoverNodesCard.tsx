import { useState } from 'react';
import {
  useDiscoverNodes,
  useControlPlane,
  usePairControlPlane,
  useUnpairControlPlane,
} from '@/hooks/queries';

/**
 * Lists machines on this Tailnet as one-click deploy-target candidates, and
 * surfaces control-plane HA pairing: when a discovered peer is itself running
 * WatchTower, offers "Set up as standby" (detect-and-suggest — the operator
 * approves; nothing replicates silently).
 *
 * "Add" pre-fills the add-server form (via onPick) for non-WatchTower peers.
 */
export default function DiscoverNodesCard({
  onPick,
}: {
  onPick: (host: string, name: string) => void;
}) {
  const { data, isLoading } = useDiscoverNodes();
  const { data: cp } = useControlPlane();
  const pair = usePairControlPlane();
  const unpair = useUnpairControlPlane();
  const [pairError, setPairError] = useState<string | null>(null);

  const peers = data?.peers ?? [];
  if (isLoading || peers.length === 0) return null;

  const setStandby = (host: string, name: string) => {
    setPairError(null);
    // This node becomes PRIMARY; the discovered peer is its standby. (The peer
    // would mark itself standby pointing back here in a follow-up step.)
    pair.mutate(
      { role: 'primary', peer_host: host, peer_name: name },
      {
        onError: (err) => {
          const detail = (err as { response?: { data?: { detail?: string } } })?.response?.data?.detail;
          setPairError(typeof detail === 'string' ? detail : 'Could not set up the standby.');
        },
      },
    );
  };

  return (
    <div className="rounded-lg border border-border bg-card p-5 shadow-retro">
      <div className="flex items-center justify-between gap-3 mb-1">
        <h2 className="text-sm font-semibold text-foreground">Found on your network</h2>
        <span className="text-[11px] text-muted-foreground">via Tailscale</span>
      </div>
      <p className="text-xs text-muted-foreground mb-3">
        Machines on your Tailnet you can add as deploy targets.
      </p>

      {/* Control-plane HA status banner */}
      {cp && cp.role !== 'standalone' && (
        <div className="mb-3 flex items-center gap-2 rounded-md border border-border-soft bg-surface-soft px-3 py-2 text-xs">
          <span className="inline-flex items-center gap-1.5 font-medium text-foreground">
            <span className="inline-block w-1.5 h-1.5 rounded-full bg-primary" />
            This node is {cp.role}
          </span>
          {cp.peer_name && <span className="text-muted-foreground">· paired with {cp.peer_name}</span>}
          <button
            type="button"
            onClick={() => unpair.mutate()}
            disabled={unpair.isPending}
            className="ml-auto text-muted-foreground hover:text-foreground underline disabled:opacity-50"
          >
            Unpair
          </button>
        </div>
      )}
      {pairError && <p className="mb-2 text-[11px] text-red-600">{pairError}</p>}

      <div className="space-y-1.5">
        {peers.map((p) => {
          const isPairedPeer = cp?.peer_host === (p.dns_name || p.ip) || cp?.peer_host === p.ip;
          return (
            <div key={p.ip} className="flex items-center gap-2 text-xs">
              <span className={`inline-block w-1.5 h-1.5 rounded-full shrink-0 ${p.online ? 'bg-emerald-500' : 'bg-slate-400'}`} />
              <span className="font-medium text-foreground truncate">{p.hostname}</span>
              <span className="text-muted-foreground font-mono">{p.ip}</span>
              {p.runs_watchtower && (
                <span className="text-[10px] font-medium text-primary px-1 py-0.5 rounded bg-primary/10 border border-primary/20">
                  WatchTower
                </span>
              )}
              {isPairedPeer ? (
                <span className="ml-auto text-[10px] font-medium text-emerald-700 shrink-0">Standby</span>
              ) : p.runs_watchtower ? (
                <button
                  type="button"
                  onClick={() => setStandby(p.dns_name || p.ip, p.hostname)}
                  disabled={!p.online || pair.isPending || cp?.role !== 'standalone'}
                  title={cp?.role !== 'standalone' ? 'Already paired — unpair first' : 'Pair this peer as a standby control plane'}
                  className="ml-auto px-2 py-0.5 rounded border border-primary bg-primary/5 text-primary hover:bg-primary/10 transition-colors disabled:opacity-50 shrink-0"
                >
                  {pair.isPending ? 'Pairing…' : 'Set up as standby'}
                </button>
              ) : p.already_added ? (
                <span className="ml-auto text-[10px] font-medium text-emerald-700 shrink-0">Added</span>
              ) : (
                <button
                  type="button"
                  onClick={() => onPick(p.dns_name || p.ip, p.hostname)}
                  disabled={!p.online}
                  title={p.online ? 'Pre-fill the add-server form for this machine' : 'Peer is offline'}
                  className="ml-auto px-2 py-0.5 rounded border border-border bg-card text-foreground hover:bg-muted transition-colors disabled:opacity-50 shrink-0"
                >
                  Add
                </button>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
