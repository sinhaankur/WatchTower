/**
 * NetworkMap — the Servers page's "what is my network?" picture.
 *
 * Renders the user's real machines as a topology: this PC (the
 * WatchTower control plane) on the left, every registered node on the
 * right, one dashed encrypted link each. The point is explanation, not
 * decoration — a newcomer should look at this and understand "my
 * laptop drives these machines, privately" without reading docs.
 *
 * Pure SVG, no graph library: the layout is a fixed hub-and-spoke
 * (this PC → nodes), which is the actual shape of a WatchTower
 * deployment today. If true node-to-node meshing lands later, this is
 * the component to grow.
 */

type MapNode = {
  id: string;
  name: string;
  host: string;
  is_primary: boolean;
  status: 'healthy' | 'unhealthy' | 'offline' | 'maintenance';
};

const STATUS_FILL: Record<MapNode['status'], string> = {
  healthy: '#10b981',
  unhealthy: '#ef4444',
  offline: '#94a3b8',
  maintenance: '#f59e0b',
};

// Tailscale hosts are recognizable by their CGNAT range / MagicDNS
// suffix; everything else is plain SSH. Both are encrypted — the label
// just tells the user which transport they're on.
function transportLabel(host: string): string {
  return /^100\.|\.ts\.net$/i.test(host) ? 'tailscale' : 'ssh';
}

const MAX_SHOWN = 6;

export default function NetworkMap({ nodes }: { nodes: MapNode[] }) {
  const shown = nodes.slice(0, MAX_SHOWN);
  const extra = nodes.length - shown.length;

  const ROW_H = 66;
  const listH = Math.max(1, shown.length + (extra > 0 ? 1 : 0)) * ROW_H;
  const height = Math.max(170, listH + 40);
  const hubY = height / 2;
  const startY = (height - listH) / 2 + ROW_H / 2;

  return (
    <section className="rounded-xl border border-border bg-card px-5 py-4 mb-5">
      <div className="flex items-baseline justify-between gap-3 flex-wrap">
        <h2 className="text-sm font-semibold text-slate-900">Your network</h2>
        <p className="text-[11px] text-slate-500">
          Dashed lines are encrypted connections from this PC. Nothing here is public unless you publish it.
        </p>
      </div>

      <svg
        viewBox={`0 0 720 ${height}`}
        role="img"
        aria-label={`Network map: this PC connected to ${nodes.length} server${nodes.length === 1 ? '' : 's'}`}
        className="w-full h-auto mt-2"
        style={{ fontFamily: 'inherit' }}
      >
        {/* links first, under the boxes */}
        {shown.map((n, i) => {
          const y = startY + i * ROW_H;
          return (
            <path
              key={`l-${n.id}`}
              d={`M 212 ${hubY} C 320 ${hubY}, 330 ${y}, 438 ${y}`}
              fill="none"
              stroke={n.status === 'offline' ? '#cbd5e1' : '#d9b229'}
              strokeWidth="2"
              strokeDasharray="6 5"
            />
          );
        })}
        {shown.map((n, i) => {
          const y = startY + i * ROW_H;
          return (
            <text key={`t-${n.id}`} x="325" y={(hubY + y) / 2 - 6} fontSize="9.5" fill="#8a7a2e" textAnchor="middle" fontFamily="ui-monospace, monospace">
              {transportLabel(n.host)}
            </text>
          );
        })}

        {/* hub: this PC */}
        <rect x="36" y={hubY - 38} width="176" height="76" rx="12" fill="#fde68a" stroke="#0f172a" strokeWidth="2.5" />
        <text x="124" y={hubY - 10} fontSize="14" fontWeight="800" fill="#0f172a" textAnchor="middle">This PC</text>
        <text x="124" y={hubY + 8} fontSize="10.5" fill="#7a5b00" textAnchor="middle">runs WatchTower</text>
        <text x="124" y={hubY + 24} fontSize="10.5" fontWeight="700" fill="#b91c1c" textAnchor="middle">builds + deploys from here</text>

        {/* nodes */}
        {shown.map((n, i) => {
          const y = startY + i * ROW_H;
          return (
            <g key={n.id}>
              <rect x="438" y={y - 27} width="246" height="54" rx="11" fill="#ffffff" stroke="#e5e0d3" strokeWidth="1.5" />
              <circle cx="458" cy={y} r="5" fill={STATUS_FILL[n.status]} />
              <text x="472" y={y - 3} fontSize="12.5" fontWeight="700" fill="#0f172a">
                {n.name.length > 22 ? n.name.slice(0, 21) + '…' : n.name}
                {n.is_primary ? '  ★' : ''}
              </text>
              <text x="472" y={y + 14} fontSize="10" fill="#5c6472" fontFamily="ui-monospace, monospace">
                {n.host.length > 30 ? n.host.slice(0, 29) + '…' : n.host}
              </text>
            </g>
          );
        })}
        {extra > 0 && (
          <text x="560" y={startY + shown.length * ROW_H} fontSize="11" fill="#5c6472" textAnchor="middle">
            + {extra} more server{extra === 1 ? '' : 's'} below
          </text>
        )}
      </svg>

      <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-[10px] text-slate-500">
        <span className="inline-flex items-center gap-1.5"><span className="w-2 h-2 rounded-full bg-emerald-500 inline-block" /> healthy</span>
        <span className="inline-flex items-center gap-1.5"><span className="w-2 h-2 rounded-full bg-red-500 inline-block" /> unhealthy</span>
        <span className="inline-flex items-center gap-1.5"><span className="w-2 h-2 rounded-full bg-slate-400 inline-block" /> offline</span>
        <span className="inline-flex items-center gap-1.5"><span className="w-2 h-2 rounded-full bg-amber-500 inline-block" /> maintenance</span>
        <span className="inline-flex items-center gap-1.5">★ primary</span>
      </div>
    </section>
  );
}
