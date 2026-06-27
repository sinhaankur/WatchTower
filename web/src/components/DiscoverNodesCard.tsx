import { useDiscoverNodes } from '@/hooks/queries';

/**
 * Lists machines on this Tailnet as one-click deploy-target candidates.
 * "Add" pre-fills the add-server form (via onPick) with the peer's host + name;
 * the user then fills in SSH details and saves. Renders nothing when there are
 * no peers (Tailscale absent or a solo tailnet) so it stays out of the way.
 */
export default function DiscoverNodesCard({
  onPick,
}: {
  onPick: (host: string, name: string) => void;
}) {
  const { data, isLoading } = useDiscoverNodes();
  const peers = data?.peers ?? [];

  if (isLoading || peers.length === 0) return null;

  return (
    <div className="rounded-lg border border-border bg-card p-5 shadow-retro">
      <div className="flex items-center justify-between gap-3 mb-1">
        <h2 className="text-sm font-semibold text-foreground">Found on your network</h2>
        <span className="text-[11px] text-muted-foreground">via Tailscale</span>
      </div>
      <p className="text-xs text-muted-foreground mb-3">
        Machines on your Tailnet you can add as deploy targets.
      </p>
      <div className="space-y-1.5">
        {peers.map((p) => (
          <div key={p.ip} className="flex items-center gap-2 text-xs">
            <span className={`inline-block w-1.5 h-1.5 rounded-full shrink-0 ${p.online ? 'bg-emerald-500' : 'bg-slate-400'}`} />
            <span className="font-medium text-foreground truncate">{p.hostname}</span>
            <span className="text-muted-foreground font-mono">{p.ip}</span>
            {p.os && <span className="text-muted-foreground">· {p.os}</span>}
            {p.already_added ? (
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
        ))}
      </div>
    </div>
  );
}
