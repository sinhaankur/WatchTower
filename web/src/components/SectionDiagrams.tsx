/**
 * Inline SVG flow diagrams that sit at the top of each new self-host
 * section (Remote Access, Managed DBs, Replicas, Backups, GitHub Pages).
 *
 * Design constraints:
 *  - Pure inline SVG. No PNG/asset pipeline; no framer-motion runtime.
 *  - Reuses the existing brand palette (slate / red / emerald / amber).
 *  - Flow lines use `anim-flow` (defined in App.css) to animate
 *    stroke-dashoffset — purely CSS, GPU-friendly, respects
 *    `prefers-reduced-motion` via the global media query.
 *  - Each diagram fixes a `viewBox` so it scales cleanly into whatever
 *    container width it lands in (typically full-card-width).
 *  - No emojis (per project conventions); icons are 1-2 path SVGs inline.
 *
 * Visual grammar (consistent across all six):
 *   - Nodes: 14px-rounded rect, 1.5px slate-300 stroke, slate-50 fill,
 *     with a small icon and one or two label lines.
 *   - Connectors: 1.5px slate-400 stroke, dashed (8 / 4), animated unless
 *     reduced-motion is set.
 *   - Accents: a single coloured fill on the "active" node to direct
 *     attention (red-50 for "your machine", emerald for "live", amber
 *     for "warm standby", violet for external).
 */

import type { ReactNode } from 'react';

// ── shared primitives ────────────────────────────────────────────────────────

type NodeProps = {
  x: number;
  y: number;
  w: number;
  h?: number;
  label: string;
  sub?: string;
  variant?: 'default' | 'accent' | 'standby' | 'success' | 'external' | 'warn';
  icon?: ReactNode;
};

const VARIANT_FILL: Record<NonNullable<NodeProps['variant']>, string> = {
  default: '#f8fafc',   // slate-50
  accent: '#fef2f2',    // red-50
  standby: '#fffbeb',   // amber-50
  success: '#ecfdf5',   // emerald-50
  external: '#f5f3ff',  // violet-50
  warn: '#fff7ed',      // orange-50
};

const VARIANT_STROKE: Record<NonNullable<NodeProps['variant']>, string> = {
  default: '#cbd5e1',   // slate-300
  accent: '#fca5a5',    // red-300
  standby: '#fcd34d',   // amber-300
  success: '#6ee7b7',   // emerald-300
  external: '#c4b5fd',  // violet-300
  warn: '#fdba74',      // orange-300
};

function Node({ x, y, w, h = 44, label, sub, variant = 'default', icon }: NodeProps) {
  const fill = VARIANT_FILL[variant];
  const stroke = VARIANT_STROKE[variant];
  const labelY = sub ? y + h / 2 - 2 : y + h / 2 + 4;
  const subY = y + h / 2 + 12;
  return (
    <g>
      <rect
        x={x} y={y} width={w} height={h} rx={10} ry={10}
        fill={fill} stroke={stroke} strokeWidth={1.5}
      />
      {icon && (
        <g transform={`translate(${x + 8}, ${y + h / 2 - 8})`}>{icon}</g>
      )}
      <text
        x={x + (icon ? 28 : w / 2)}
        y={labelY}
        textAnchor={icon ? 'start' : 'middle'}
        fontSize="11"
        fontWeight="600"
        fill="#0f172a"
        style={{ fontFamily: 'inherit' }}
      >
        {label}
      </text>
      {sub && (
        <text
          x={x + (icon ? 28 : w / 2)}
          y={subY}
          textAnchor={icon ? 'start' : 'middle'}
          fontSize="9"
          fill="#64748b"
          style={{ fontFamily: 'inherit' }}
        >
          {sub}
        </text>
      )}
    </g>
  );
}

function FlowLine({
  x1, y1, x2, y2, animated = true, label,
}: { x1: number; y1: number; x2: number; y2: number; animated?: boolean; label?: string }) {
  return (
    <g>
      <line
        x1={x1} y1={y1} x2={x2} y2={y2}
        stroke="#94a3b8" strokeWidth={1.5}
        strokeDasharray="6 4"
        className={animated ? 'anim-flow' : undefined}
      />
      {/* Chevron at the destination — small triangle pointing →.
          Placed 1px before x2 to avoid the line's own end-cap. */}
      <polygon
        points={`${x2 - 6},${y2 - 3.5} ${x2 - 6},${y2 + 3.5} ${x2 - 1},${y2}`}
        fill="#94a3b8"
      />
      {label && (
        <text
          x={(x1 + x2) / 2}
          y={y1 - 5}
          textAnchor="middle"
          fontSize="9"
          fill="#64748b"
          fontStyle="italic"
          style={{ fontFamily: 'inherit' }}
        >
          {label}
        </text>
      )}
    </g>
  );
}

// ── tiny inline icons (16x16) ─────────────────────────────────────────────────
// Each is a <g> snippet positioned by the parent's translate.

const IconWatchTower = (
  <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="#b91c1c" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
    <rect x={3} y={4} width={18} height={16} rx={2} />
    <path d="M3 9h18M12 4v16" />
  </svg>
);

const IconCloud = (
  <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="#0369a1" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
    <path d="M17 18a4 4 0 0 0 0-8 6 6 0 0 0-11.6 1.5A3.5 3.5 0 0 0 6 18h11Z" />
  </svg>
);

const IconDevice = (
  <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="#475569" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
    <rect x={4} y={2} width={16} height={20} rx={3} />
    <line x1={10} y1={18} x2={14} y2={18} />
  </svg>
);

const IconDatabase = (
  <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="#0f766e" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
    <ellipse cx={12} cy={5} rx={9} ry={3} />
    <path d="M3 5v6c0 1.66 4 3 9 3s9-1.34 9-3V5" />
    <path d="M3 11v6c0 1.66 4 3 9 3s9-1.34 9-3v-6" />
  </svg>
);

const IconVolume = (
  <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="#0369a1" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
    <rect x={3} y={4} width={18} height={16} rx={2} />
    <path d="M3 10h18" />
  </svg>
);

const IconLock = (
  <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="#6d28d9" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
    <rect x={5} y={11} width={14} height={10} rx={2} />
    <path d="M8 11V7a4 4 0 0 1 8 0v4" />
  </svg>
);

const IconFile = (
  <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="#475569" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
    <path d="M14 2v6h6" />
  </svg>
);

const IconGithub = (
  <svg width={16} height={16} viewBox="0 0 24 24" fill="#1f2937">
    <path d="M12 .5C5.65.5.5 5.65.5 12c0 5.08 3.29 9.39 7.86 10.91.58.1.79-.25.79-.56v-2c-3.2.69-3.87-1.36-3.87-1.36-.52-1.33-1.27-1.68-1.27-1.68-1.04-.71.08-.7.08-.7 1.15.08 1.76 1.18 1.76 1.18 1.02 1.75 2.69 1.25 3.34.96.1-.74.4-1.25.72-1.54-2.55-.29-5.24-1.28-5.24-5.69 0-1.26.45-2.29 1.18-3.1-.12-.29-.51-1.46.11-3.05 0 0 .97-.31 3.18 1.18a11.06 11.06 0 0 1 5.79 0c2.21-1.49 3.18-1.18 3.18-1.18.62 1.59.23 2.76.11 3.05.73.81 1.18 1.84 1.18 3.1 0 4.42-2.69 5.39-5.25 5.68.41.36.78 1.06.78 2.13v3.16c0 .31.21.66.79.55C20.21 21.39 23.5 17.08 23.5 12c0-6.35-5.15-11.5-11.5-11.5z" />
  </svg>
);

const IconGlobe = (
  <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="#15803d" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
    <circle cx={12} cy={12} r={10} />
    <line x1={2} y1={12} x2={22} y2={12} />
    <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
  </svg>
);

// ── shared wrapper ───────────────────────────────────────────────────────────
// Caption sits below the SVG, matching the existing "card with caption"
// pattern used elsewhere (e.g. RunAsContainerCard descriptive text).

function DiagramFrame({
  children, viewBox, caption, ariaLabel,
}: {
  children: ReactNode;
  viewBox: string;
  caption?: string;
  ariaLabel: string;
}) {
  return (
    <div className="rounded-xl border border-border bg-slate-50/50 px-4 py-3">
      <svg
        viewBox={viewBox}
        role="img"
        aria-label={ariaLabel}
        className="w-full h-auto max-h-[140px]"
        preserveAspectRatio="xMidYMid meet"
      >
        {children}
      </svg>
      {caption && (
        <p className="text-[11px] text-slate-500 mt-1.5 text-center">{caption}</p>
      )}
    </div>
  );
}

// ── 1. Remote Access ─────────────────────────────────────────────────────────
//   [ WatchTower (this PC) ] --→ [ Tailscale ] --→ [ Your devices ]

export function RemoteAccessDiagram() {
  return (
    <DiagramFrame
      ariaLabel="Remote Access flow: WatchTower on this PC, through Tailscale, to your other devices"
      viewBox="0 0 480 80"
      caption="Your PC's port is exposed over Tailscale to devices on your tailnet."
    >
      <Node x={10} y={18} w={130} icon={IconWatchTower}
            label="WatchTower" sub="this PC" variant="accent" />
      <FlowLine x1={142} y1={40} x2={188} y2={40} />
      <Node x={190} y={18} w={100} icon={IconCloud}
            label="Tailscale" sub="*.ts.net" variant="default" />
      <FlowLine x1={292} y1={40} x2={338} y2={40} />
      <Node x={340} y={18} w={130} icon={IconDevice}
            label="Your devices" sub="phone, laptop" variant="success" />
    </DiagramFrame>
  );
}

// ── 2. Managed Database ──────────────────────────────────────────────────────
//   [ WatchTower ] --create--> [ Podman pod ] --mounts--> [ Persistent volume ]

export function ManagedDbDiagram() {
  return (
    <DiagramFrame
      ariaLabel="WatchTower creates a Podman pod containing the database, mounting a persistent volume."
      viewBox="0 0 480 80"
      caption="WatchTower spins up a Podman pod with your chosen engine + a persistent named volume."
    >
      <Node x={10} y={18} w={110} icon={IconWatchTower}
            label="WatchTower" variant="accent" />
      <FlowLine x1={122} y1={40} x2={178} y2={40} label="create" />
      <Node x={180} y={18} w={140} icon={IconDatabase}
            label="Podman pod" sub="postgres/mysql/…" variant="success" />
      <FlowLine x1={322} y1={40} x2={368} y2={40} label="mount" />
      <Node x={370} y={18} w={100} icon={IconVolume}
            label="Volume" sub="data persists" variant="default" />
    </DiagramFrame>
  );
}

// ── 3. External Database ─────────────────────────────────────────────────────
//   [ WatchTower ] --[encrypted creds]--> [ External DB ]

export function ExternalDbDiagram() {
  return (
    <DiagramFrame
      ariaLabel="WatchTower stores encrypted credentials and connects to a database you run yourself."
      viewBox="0 0 480 80"
      caption="WatchTower stores encrypted credentials. The database runs wherever you already host it."
    >
      <Node x={10} y={18} w={110} icon={IconWatchTower}
            label="WatchTower" variant="accent" />
      <g transform="translate(140, 30)">
        <rect x={0} y={0} width={50} height={22} rx={4} fill="#f5f3ff" stroke="#c4b5fd" strokeWidth={1} />
        <g transform="translate(4, 3)">{IconLock}</g>
        <text x={26} y={15} fontSize="8" fill="#5b21b6" textAnchor="middle" style={{ fontFamily: 'inherit' }}>creds</text>
      </g>
      <FlowLine x1={196} y1={40} x2={246} y2={40} />
      <Node x={250} y={18} w={220} icon={IconCloud}
            label="External database" sub="RDS, Supabase, NAS, another PC" variant="external" />
    </DiagramFrame>
  );
}

// ── 4. Replication (HA v1) ───────────────────────────────────────────────────
//   [ Primary pod ] ==WAL stream==> [ Standby pod ]
//   The WAL line uses the slower animation to feel "data streaming."

export function ReplicationDiagram() {
  return (
    <DiagramFrame
      ariaLabel="Postgres streaming replication: WAL flows from primary pod to standby pod."
      viewBox="0 0 480 80"
      caption="The standby pod streams WAL from the primary. Click Promote to fail over manually."
    >
      <Node x={20} y={18} w={170} icon={IconDatabase}
            label="Primary pod" sub="read + write" variant="accent" />
      <g>
        {/* Two parallel flow lines to emphasise "streaming" */}
        <line x1={192} y1={36} x2={288} y2={36}
              stroke="#10b981" strokeWidth={1.5} strokeDasharray="8 4"
              className="anim-flow" />
        <line x1={192} y1={44} x2={288} y2={44}
              stroke="#10b981" strokeWidth={1.5} strokeDasharray="8 4"
              className="anim-flow-slow" />
        <polygon points={`${288 - 6},${36 - 3.5} ${288 - 6},${36 + 3.5} ${288 - 1},${36}`} fill="#10b981" />
        <polygon points={`${288 - 6},${44 - 3.5} ${288 - 6},${44 + 3.5} ${288 - 1},${44}`} fill="#10b981" />
        <text x={240} y={28} textAnchor="middle" fontSize="9" fill="#047857" fontStyle="italic" style={{ fontFamily: 'inherit' }}>
          WAL stream
        </text>
      </g>
      <Node x={290} y={18} w={170} icon={IconDatabase}
            label="Standby pod" sub="read-only, hot" variant="standby" />
    </DiagramFrame>
  );
}

// ── 5. Backup ────────────────────────────────────────────────────────────────
//   [ Postgres pod ] --pg_dump--> [ Backup file ] in ~/.watchtower/

export function BackupDiagram() {
  return (
    <DiagramFrame
      ariaLabel="Backup flow: pg_dump from the Postgres pod into a custom-format file on the host disk."
      viewBox="0 0 480 80"
      caption="pg_dump runs in a transient container, writes a .dump file under ~/.watchtower/managed_db_backups/."
    >
      <Node x={10} y={18} w={150} icon={IconDatabase}
            label="Postgres pod" sub="running primary" variant="accent" />
      <FlowLine x1={162} y1={40} x2={228} y2={40} label="pg_dump" />
      <Node x={230} y={18} w={130} icon={IconFile}
            label="dump file" sub="custom format (-Fc)" variant="success" />
      <g transform="translate(370, 18)">
        <rect x={0} y={0} width={100} height={44} rx={10} fill="#f1f5f9" stroke="#cbd5e1" strokeDasharray="3 3" strokeWidth={1.5} />
        <text x={50} y={20} textAnchor="middle" fontSize="9" fill="#64748b" style={{ fontFamily: 'inherit' }}>~/.watchtower/</text>
        <text x={50} y={32} textAnchor="middle" fontSize="9" fill="#64748b" style={{ fontFamily: 'inherit' }}>managed_db_backups/</text>
      </g>
    </DiagramFrame>
  );
}

// ── 6. GitHub Pages live URL ─────────────────────────────────────────────────
//   [ Your repo ] --build--> [ GitHub Pages ] --→ [ Public URL ]

export function GithubPagesDiagram() {
  return (
    <DiagramFrame
      ariaLabel="Project live URL flow: your GitHub repo publishes to GitHub Pages, which serves the public URL."
      viewBox="0 0 480 80"
      caption="WatchTower records where your project is publicly live — GitHub Pages, custom domain, anywhere."
    >
      <Node x={10} y={18} w={120} icon={IconGithub}
            label="Your repo" sub="GitHub" variant="default" />
      <FlowLine x1={132} y1={40} x2={188} y2={40} label="build" />
      <Node x={190} y={18} w={140} icon={IconGlobe}
            label="GitHub Pages" sub="static hosting" variant="success" />
      <FlowLine x1={332} y1={40} x2={388} y2={40} />
      <Node x={390} y={18} w={80} icon={IconDevice}
            label="Visitors" sub="public" variant="default" />
    </DiagramFrame>
  );
}
