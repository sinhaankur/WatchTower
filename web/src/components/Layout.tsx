import { ReactNode, useState, useEffect } from 'react';
import { Link, useLocation } from 'react-router-dom';
// One consistent, professional icon set (lucide) — replaces the hand-drawn
// inline SVGs so every icon shares the same weight, grid, and style.
import {
  LayoutDashboard, Globe, Server, Database, Puzzle, Settings as SettingsIcon,
  Layers, Boxes, Radio, Users, ScrollText, Plus,
} from 'lucide-react';
import BrandLogo from './BrandLogo';
import TitleBar from './TitleBar';
import { useUpdateCheck, useActiveDeploymentCount, useHealingConfig, useSelfUpdateStatus, useSelfUpdate } from '@/hooks/queries';
import { CommandPalette, openCommandPalette } from './CommandPalette';
import { UserMenu } from './UserMenu';

const UPDATE_BANNER_DISMISSED_KEY = 'watchtower:updateBannerDismissed';
const MORE_NAV_OPEN_KEY = 'watchtower:moreNavOpen';

// Detect if running inside Electron
const isElectron = typeof window !== 'undefined' && Boolean((window as any).electronAPI);

// Trigger the in-app update flow. In Electron this calls the IPC handler
// which runs electron-updater (packaged) or `run.sh update` (dev clone).
// In a plain browser there is nothing to install in-place, so we fall back
// to opening the release page in a new tab.
async function triggerUpdate(releaseUrl?: string | null): Promise<void> {
  const electron = (window as any).electronAPI;
  if (electron?.updateNow) {
    await electron.updateNow(releaseUrl ?? '');
    return;
  }
  if (releaseUrl) window.open(releaseUrl, '_blank', 'noopener,noreferrer');
}

function UpdateBanner() {
  // Banner appears once per (current,latest) pair — dismissing it stores
  // the latest version, so the same release won't nag again but a future
  // release will resurface the banner.
  const { data } = useUpdateCheck();
  const [dismissedFor, setDismissedFor] = useState<string | null>(() => {
    try { return localStorage.getItem(UPDATE_BANNER_DISMISSED_KEY); } catch { return null; }
  });
  const [updating, setUpdating] = useState(false);

  // In browser mode, find out whether this install can update itself in
  // place (a source checkout) vs. only point at the release page. The
  // desktop path uses electron-updater and ignores this. Poll once an
  // update has been kicked off so we can report progress across restarts.
  const { data: selfUpdate } = useSelfUpdateStatus({ poll: updating && !isElectron });
  const selfUpdateMut = useSelfUpdate();

  const running = selfUpdate?.last_run?.state === 'running';
  const lastState = selfUpdate?.last_run?.state;
  const canSelfUpdate = !isElectron && Boolean(selfUpdate?.can_self_update);

  // Once a server-side run resolves, drop the local spinner so the label
  // reflects the result. Effect (not render) so we don't setState mid-render.
  useEffect(() => {
    if (updating && (lastState === 'succeeded' || lastState === 'failed')) {
      setUpdating(false);
    }
  }, [updating, lastState]);

  if (!data?.has_update || dismissedFor === data.latest) return null;

  const dismiss = () => {
    if (!data.latest) return;
    try { localStorage.setItem(UPDATE_BANNER_DISMISSED_KEY, data.latest); } catch { /* ignore */ }
    setDismissedFor(data.latest);
  };

  const onUpdate = async () => {
    setUpdating(true);
    try {
      if (isElectron) {
        await triggerUpdate(data.release_url);
      } else if (canSelfUpdate) {
        // Server-side update: pull + rebuild + restart on the host. The
        // poll (enabled while `updating`) watches it through the restart.
        await selfUpdateMut.mutateAsync();
      } else {
        // No in-place path on this install — open the release page.
        await triggerUpdate(data.release_url);
        setUpdating(false);
      }
    } catch {
      setUpdating(false);
    }
  };

  let label = isElectron ? 'Update now' : canSelfUpdate ? 'Update & restart' : 'Get update';
  if (updating || running) label = 'Updating…';
  else if (lastState === 'succeeded') label = 'Updated — reload';
  else if (lastState === 'failed') label = 'Update failed — retry';

  return (
    <div className="flex items-center gap-3 px-4 py-2 bg-accent/10 border-b border-accent/25 text-accent text-xs">
      <span className="inline-flex items-center justify-center w-4 h-4 rounded-full bg-primary text-accent text-xs font-bold">!</span>
      <span className="flex-1">
        <strong>WatchTower {data.latest}</strong> is available
        {data.current && <> — you're on <span className="font-mono">{data.current}</span></>}.
        {(updating || running) && canSelfUpdate && (
          <> — pulling, rebuilding & restarting. This page reconnects automatically.</>
        )}
        {lastState === 'failed' && (
          <> — last attempt failed{typeof selfUpdate?.last_run?.exit_code === 'number' ? ` (exit ${selfUpdate.last_run.exit_code})` : ''}.</>
        )}
      </span>
      {data.release_url && (
        <a
          href={data.release_url}
          target="_blank"
          rel="noopener noreferrer"
          className="px-2 py-0.5 rounded border border-amber-700 bg-card text-accent hover:bg-amber-100 font-medium"
        >
          Release notes
        </a>
      )}
      <button
        type="button"
        onClick={() => void onUpdate()}
        disabled={updating || running}
        title={!isElectron && !canSelfUpdate && selfUpdate?.reason ? selfUpdate.reason : undefined}
        className="px-2 py-0.5 rounded border border-amber-800 bg-amber-700 hover:bg-amber-800 text-white font-semibold disabled:opacity-60 disabled:cursor-wait"
      >
        {label}
      </button>
      <button
        onClick={dismiss}
        title="Dismiss until next release"
        className="ml-1 text-accent hover:text-accent"
        aria-label="Dismiss update banner"
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
        </svg>
      </button>
    </div>
  );
}

// ── SVG icon helpers ──────────────────────────────────────────────────────────
function IconBug() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M8 2h8" />
      <path d="M9 2v2.5" />
      <path d="M15 2v2.5" />
      <rect x="7" y="4.5" width="10" height="14" rx="4" />
      <path d="M3 9h4" />
      <path d="M17 9h4" />
      <path d="M2 14h5" />
      <path d="M17 14h5" />
      <path d="M10 9h4" />
    </svg>
  );
}

// ── Navigation structure ──────────────────────────────────────────────────────
type NavItem = { path: string; label: string; Icon: typeof LayoutDashboard };

// Antenna / broadcast icon for Remote Access — communicates "expose this
// machine to the outside" without leaning on a generic globe (which we
// already use for Cloudflare in Integrations).

// Stack-of-containers icon for the "Local Containers" admin view.
// Simpler than a play-button-in-a-box — communicates "things running"
// without overlapping with the existing IconBox (Applications).

// Sidebar information architecture:
//   PRIMARY = "what am I working with?" — daily-flow surfaces in the
//   order a new user encounters them: Dashboard (status) → Applications
//   (your projects) → Servers (deployment targets) → Services
//   (catalogue of self-hostable tools, including databases).
//   SECONDARY = "configure / inspect" — admin surfaces.
//
// What was removed (still reachable via direct URL or contextual links):
//   - /databases    → folded into /services as a category filter.
//                     Previously a separate nav link for what is just
//                     "the DB subset of self-hostable services."
//   - /host-connect → folded into /integrations. Both pages dealt with
//                     the same content (Tailscale, Cloudflare, Podman
//                     install commands, domain wiring); two nav entries
//                     for one concept was confusing.
// Navigation leads with the handful of things a beginner needs, and tucks
// power-user surfaces behind a "More" disclosure so the sidebar reads as a
// short, obvious list on first run (the Conductor/Linear pattern: few items,
// one clear next action). Primary groups are always visible; ADVANCED_ITEMS
// collapse under "More ▸" until the user opts in (state persists).
//
//   MAIN  — the everyday loop: Dashboard, your Sites, servers, databases
//   MORE  — Integrations, Remote Access, Team, Audit, Containers, Templates,
//           Catalog — reachable, just not shouting on day one.
// "Report Bug" lives in the footer — it's support, not a workspace.
type NavGroup = { label: string; items: NavItem[] };

const NAV_GROUPS: NavGroup[] = [
  {
    label: 'Main',
    items: [
      { path: '/',                  label: 'Dashboard', Icon: LayoutDashboard },
      { path: '/applications',      label: 'Sites',     Icon: Globe },
      { path: '/servers',           label: 'Servers',   Icon: Server },
      { path: '/managed-databases', label: 'Databases', Icon: Database },
      { path: '/integrations',      label: 'Integrations', Icon: Puzzle },
      { path: '/settings',          label: 'Settings',  Icon: SettingsIcon },
    ],
  },
];

// Collapsed under "More ▸". Advanced / occasional surfaces — everything still
// reachable, just not in the first-run field of view.
const ADVANCED_ITEMS: NavItem[] = [
  { path: '/templates',        label: 'Templates',     Icon: Layers },
  { path: '/services',         label: 'Catalog',       Icon: Puzzle },
  { path: '/local-containers', label: 'Containers',    Icon: Boxes },
  { path: '/remote-access',    label: 'Remote Access', Icon: Radio },
  { path: '/team',             label: 'Team',          Icon: Users },
  { path: '/audit',            label: 'Audit Log',     Icon: ScrollText },
];

// A small, opinionated section header. Slate-400 + uppercase +
// letter-spaced is the classic SaaS-sidebar pattern (Linear, Vercel,
// Stripe Dashboard, GitHub) — gives navigation a clear "kinds of
// things" mental map without screaming for attention.
function NavSectionLabel({ children }: { children: ReactNode }) {
  return (
    <div className="px-3 pt-3 pb-1.5 text-xs font-semibold uppercase tracking-[0.08em] text-muted-foreground/70">
      {children}
    </div>
  );
}

// Numeric badge for nav items with live counts (e.g. running deploys
// next to "Applications"). Stays subtle on inactive rows; the active
// row inverts to a slate-700 fill against the white text so it doesn't
// vanish on the dark active background.
function NavBadge({ count, active }: { count: number; active: boolean }) {
  if (count <= 0) return null;
  const display = count > 99 ? '99+' : String(count);
  return (
    <span
      aria-label={`${count} active`}
      className={`ml-auto text-xs font-semibold tabular-nums px-1.5 py-0.5 rounded-full transition-colors ${
        active
          ? 'bg-primary/15 text-primary'
          : 'bg-muted text-muted-foreground'
      }`}
    >
      {display}
    </span>
  );
}

type NavLinkProps = {
  item: NavItem;
  pathname: string;
  onClick?: () => void;
  /** When true: render only the icon (icon-rail mode). Tooltip shows label. */
  rail?: boolean;
  /** Optional badge count rendered to the right of the label. */
  badge?: number;
};

function NavLink({ item, pathname, onClick, rail, badge }: NavLinkProps) {
  const active = item.path === '/' ? pathname === '/' : pathname.startsWith(item.path);
  // Always-on title attribute = native browser tooltip when fully expanded
  // AND when in rail mode (icon-only). Native tooltips are accessible by
  // default and don't require a portal.
  const tooltip = rail ? item.label : undefined;
  return (
    <Link
      to={item.path}
      onClick={onClick}
      title={tooltip}
      aria-label={rail ? item.label : undefined}
      className={`group flex items-center gap-2.5 rounded-md text-sm font-medium transition-colors duration-instant ${
        rail ? 'justify-center px-2 py-2' : 'px-3 py-1.5'
      } ${
        active
          ? 'bg-primary/10 text-primary'
          : 'text-muted-foreground hover:bg-muted hover:text-foreground'
      }`}
    >
      <span className={active ? 'text-primary' : 'text-muted-foreground/70 group-hover:text-foreground'}>
        <item.Icon size={16} strokeWidth={2} />
      </span>
      {!rail && (
        <>
          <span className="truncate">{item.label}</span>
          {typeof badge === 'number' && <NavBadge count={badge} active={active} />}
        </>
      )}
      {/* Rail-mode badge — small dot in the upper-right of the icon when
          there's something pending. The number is shown via the title
          tooltip so the rail stays compact. */}
      {rail && typeof badge === 'number' && badge > 0 && (
        <span
          aria-hidden="true"
          className="absolute mt-[-12px] ml-[12px] w-2 h-2 rounded-full bg-primary ring-2 ring-white"
        />
      )}
    </Link>
  );
}

// ── Layout ────────────────────────────────────────────────────────────────────
export default function Layout({ children }: { children: ReactNode }) {
  const { pathname } = useLocation();

  // Three-state sidebar: 'full' (text + icons), 'rail' (icons only,
  // ~56px wide, label as tooltip), or 'hidden' (no sidebar).
  // Persisted per-user so reopening the app respects the choice.
  const SIDEBAR_PREF_KEY = 'watchtower:sidebarMode';
  type SidebarMode = 'full' | 'rail' | 'hidden';
  const [sidebarMode, setSidebarMode] = useState<SidebarMode>(() => {
    try {
      const v = localStorage.getItem(SIDEBAR_PREF_KEY);
      return (v === 'rail' || v === 'hidden' || v === 'full') ? v : 'full';
    } catch { return 'full'; }
  });
  useEffect(() => {
    try { localStorage.setItem(SIDEBAR_PREF_KEY, sidebarMode); } catch { /* ignore */ }
  }, [sidebarMode]);
  const cycleSidebar = () => setSidebarMode((m) =>
    m === 'full' ? 'rail' : m === 'rail' ? 'hidden' : 'full'
  );

  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false);
  const { data: updateData } = useUpdateCheck();
  const versionLabel = updateData?.current ? `v${updateData.current}` : '';

  // "More" disclosure for the advanced nav items. Persist the user's choice,
  // but always force it open when the current route lives under "More" so the
  // active item is never hidden.
  const onAdvancedRoute = ADVANCED_ITEMS.some((i) => pathname.startsWith(i.path));
  const [moreOpen, setMoreOpen] = useState<boolean>(() => {
    try { return localStorage.getItem(MORE_NAV_OPEN_KEY) === '1'; } catch { return false; }
  });
  const moreExpanded = moreOpen || onAdvancedRoute;
  const toggleMore = () => setMoreOpen((v) => {
    const next = !v;
    try { localStorage.setItem(MORE_NAV_OPEN_KEY, next ? '1' : '0'); } catch { /* ignore */ }
    return next;
  });

  // Environment badge — pulled once at mount. Surfaces when this is
  // NOT a boring "desktop + production" combo so the user can tell at
  // a glance which backend / DB they're pointing at.
  const [envInfo, setEnvInfo] = useState<{ env: string; mode: string; insecure_dev_auth: boolean } | null>(null);
  useEffect(() => {
    let cancelled = false;
    void fetch('/api/runtime/environment')
      .then(r => r.ok ? r.json() : null)
      .then(d => { if (!cancelled && d) setEnvInfo({ env: d.env, mode: d.mode, insecure_dev_auth: d.insecure_dev_auth }); })
      .catch(() => { /* non-fatal — just hide the badge */ });
    return () => { cancelled = true; };
  }, []);
  const { data: activeDeploys } = useActiveDeploymentCount();
  const activeBuildCount = activeDeploys?.active ?? 0;
  // Self-heal fixes waiting for a human decision — badge Settings so
  // the intervention queue is discoverable without opening the page.
  const { data: healingConfig } = useHealingConfig();
  const pendingInterventions = healingConfig?.pending_actions ?? 0;

  // Wire badge counts per nav path. Right now we only badge
  // /applications with the active deployment count, but this is the
  // place to add more later (e.g. /audit recent events, /servers
  // unhealthy nodes).
  const navBadgeFor = (path: string): number | undefined => {
    if (path === '/applications') return activeBuildCount;
    if (path === '/settings') return pendingInterventions > 0 ? pendingInterventions : undefined;
    return undefined;
  };

  // Shared sidebar content used in both desktop sidebar and mobile drawer
  const SidebarInner = ({ onNavClick, rail }: { onNavClick?: () => void; rail?: boolean }) => (
    <>
      {!isElectron && !rail && (
        <div className="px-4 py-5 border-b" style={{ borderColor: 'hsl(var(--border-soft))' }}>
          <BrandLogo withLabel size="md" />
        </div>
      )}
      {!isElectron && rail && (
        <div className="px-3 py-4 flex items-center justify-center border-b" style={{ borderColor: 'hsl(var(--border-soft))' }}>
          <BrandLogo size="sm" />
        </div>
      )}
      {isElectron && <div className="h-3" />}

      <div className={rail ? 'px-2 pt-3 pb-2' : 'px-3 pt-3 pb-2'}>
        <Link
          to="/start"
          onClick={onNavClick}
          title={rail ? 'New site' : undefined}
          className={`flex items-center justify-center gap-2 w-full ${
            rail ? 'py-2' : 'py-1.5 px-3'
          } rounded-md bg-primary hover:bg-primary/90 transition-colors text-primary-foreground text-sm font-semibold shadow-retro`}
        >
          <Plus size={16} strokeWidth={2.5} />
          {!rail && <>New site</>}
        </Link>
      </div>

      {!rail && (
        <button
          type="button"
          onClick={openCommandPalette}
          className="mx-3 mb-2 flex items-center gap-2 px-3 py-1.5 rounded-md border border-border bg-card hover:bg-muted text-sm text-muted-foreground hover:text-foreground transition-colors"
        >
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" />
          </svg>
          <span className="flex-1 text-left">Search…</span>
          <kbd className="text-xs font-mono text-muted-foreground border border-border px-1 rounded">⌘K</kbd>
        </button>
      )}

      <nav className={`flex-1 ${rail ? 'px-1.5' : 'px-2'} pt-1 pb-2 overflow-y-auto`}>
        {NAV_GROUPS.map((group, gi) => (
          <div key={group.label}>
            {rail
              ? gi > 0 && <div className="my-2 mx-3 border-t border-border-soft" />
              : <NavSectionLabel>{group.label}</NavSectionLabel>}
            <div className="space-y-px">
              {group.items.map((item) => (
                <NavLink
                  key={item.path}
                  item={item}
                  pathname={pathname}
                  onClick={onNavClick}
                  rail={rail}
                  badge={navBadgeFor(item.path)}
                />
              ))}
            </div>
          </div>
        ))}

        {/* Advanced surfaces. In rail (icon-only) mode a disclosure makes no
            sense, so the icons show directly under a divider. In full mode
            they hide behind a "More" toggle that keeps the first-run sidebar
            short — and auto-expands when the active route lives here. */}
        {rail ? (
          <>
            <div className="my-2 mx-3 border-t border-border-soft" />
            <div className="space-y-px">
              {ADVANCED_ITEMS.map((item) => (
                <NavLink key={item.path} item={item} pathname={pathname} onClick={onNavClick} rail badge={navBadgeFor(item.path)} />
              ))}
            </div>
          </>
        ) : (
          <div>
            <button
              type="button"
              onClick={toggleMore}
              aria-expanded={moreExpanded}
              className="w-full flex items-center gap-2.5 rounded-md px-3 py-1.5 text-sm font-medium text-muted-foreground/70 hover:text-foreground transition-colors"
            >
              <svg
                width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2"
                strokeLinecap="round" strokeLinejoin="round"
                className={`transition-transform ${moreExpanded ? 'rotate-90' : ''}`}
                aria-hidden="true"
              >
                <path d="m9 18 6-6-6-6" />
              </svg>
              <span>More</span>
            </button>
            {/* Smooth height reveal via the grid-rows 0fr→1fr trick — no JS
                measuring, respects the app's calm-motion feel. Items stay
                mounted so the transition has something to animate. */}
            <div
              className={`grid transition-[grid-template-rows] duration-200 ease-out ${moreExpanded ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]'}`}
            >
              <div className="overflow-hidden">
                <div className="space-y-px pt-px">
                  {ADVANCED_ITEMS.map((item) => (
                    <NavLink key={item.path} item={item} pathname={pathname} onClick={onNavClick} rail={false} badge={navBadgeFor(item.path)} />
                  ))}
                </div>
              </div>
            </div>
          </div>
        )}
      </nav>

      {/* Rail-mode footer: avatar dropdown trigger + update dot. The
          UserMenu component handles the click-to-open menu (account
          link, sign out). */}
      {rail && (
        <div className="px-2 py-3 border-t flex flex-col items-center gap-2" style={{ borderColor: 'hsl(var(--border-soft))' }}>
          <UserMenu rail />
          {updateData?.has_update && (
            <button
              type="button"
              onClick={() => void triggerUpdate(updateData.release_url)}
              title={`Update v${updateData.latest} available — click to install`}
              aria-label={`Install update ${updateData.latest}`}
              className="w-2 h-2 rounded-full bg-primary ring-2 ring-white hover:ring-amber-200 transition"
            />
          )}
        </div>
      )}

      <div className={`px-3 py-3 border-t ${rail ? 'hidden' : ''}`} style={{ borderColor: 'hsl(var(--border-soft))' }}>
        {/* Identity dropdown — single trigger that exposes account
            settings + sign out. Replaces the old inline identity card +
            naked "Sign out" link footer. */}
        <UserMenu />
        {/* Support + feedback — open-source funding (GitHub Sponsors) and a
            bug-report link. Kept out of the primary nav (they're not
            workspaces) but easy to reach from the footer. */}
        <div className="mt-3 flex items-center gap-2">
          <a
            href="https://github.com/sponsors/sinhaankur"
            target="_blank"
            rel="noopener noreferrer"
            className="flex-1 inline-flex items-center justify-center gap-1.5 rounded-md border border-border-soft px-2 py-1.5 text-xs font-medium text-foreground hover:bg-muted transition-colors"
            title="Support WatchTower's development"
          >
            <span className="text-primary">♥</span> Support
          </a>
          <Link
            to="/report-bug"
            onClick={onNavClick}
            className="flex-1 inline-flex items-center justify-center gap-1.5 rounded-md border border-border-soft px-2 py-1.5 text-xs font-medium text-muted-foreground hover:bg-muted hover:text-foreground transition-colors [&_svg]:size-3.5"
            title="Report a bug"
          >
            <IconBug /> Report Bug
          </Link>
        </div>
        {/* Version line — quiet, single line, separates from chrome with
            a thin top border. The "update available" affordance is the
            only thing meant to draw the eye when relevant. */}
        <div className="mt-3 pt-2 px-1 border-t border-border-soft flex items-center justify-between">
          <span className="text-xs text-muted-foreground tracking-wide flex items-center gap-1.5">
            <span>WatchTower{versionLabel ? ` ${versionLabel}` : ''}</span>
            {envInfo && (envInfo.mode !== 'desktop' || envInfo.env !== 'production' || envInfo.insecure_dev_auth) && (
              <span
                className={`px-1 py-px rounded text-xs font-semibold uppercase tracking-wider ${
                  envInfo.insecure_dev_auth
                    ? 'bg-red-100 text-destructive border border-destructive/40'
                    : envInfo.env === 'production'
                      ? 'bg-muted text-muted-foreground border border-border'
                      : 'bg-amber-100 text-accent border border-amber-300'
                }`}
                title={`mode: ${envInfo.mode} · env: ${envInfo.env}${envInfo.insecure_dev_auth ? ' · INSECURE DEV AUTH' : ''}`}
              >
                {envInfo.insecure_dev_auth ? 'dev-auth' : envInfo.env === 'production' ? envInfo.mode : envInfo.env}
              </span>
            )}
          </span>
          {updateData?.has_update && (
            <button
              type="button"
              onClick={() => void triggerUpdate(updateData.release_url)}
              className="text-xs text-accent hover:text-accent font-medium inline-flex items-center gap-1"
              title={`Update to ${updateData.latest} — click to install`}
            >
              <span className="w-1.5 h-1.5 rounded-full bg-primary" />
              Update
            </button>
          )}
        </div>
      </div>
    </>
  );

  return (
    <div className="flex flex-col bg-transparent" style={{ height: '100vh', overflow: 'hidden' }}>
      {isElectron && <TitleBar />}

      {/* Mobile drawer overlay */}
      {mobileSidebarOpen && (
        <div className="lg:hidden fixed inset-0 z-40 flex">
          <div className="fixed inset-0 bg-black/40" onClick={() => setMobileSidebarOpen(false)} />
          <aside
            className="relative flex flex-col w-64 max-w-[85vw] border-r shadow-xl z-50"
            style={{ background: 'hsl(var(--sidebar))', borderColor: 'hsl(var(--border-soft))' }}
          >
            <div className="flex items-center justify-between px-4 py-3 border-b" style={{ borderColor: 'hsl(var(--border-soft))' }}>
              <BrandLogo withLabel size="md" />
              <button
                onClick={() => setMobileSidebarOpen(false)}
                className="p-1.5 rounded hover:bg-muted text-muted-foreground transition-colors"
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
                </svg>
              </button>
            </div>
            <SidebarInner onNavClick={() => setMobileSidebarOpen(false)} />
          </aside>
        </div>
      )}

      {/* Body row */}
      <div className="flex flex-1 min-h-0 overflow-hidden">
        {/* Desktop sidebar — three modes: full (224px), rail (56px,
            icons only), or hidden. Width animates via Tailwind class
            so the transition feels designed instead of janky. */}
        {sidebarMode !== 'hidden' && (
          <aside
            className={`hidden lg:flex shrink-0 flex-col border-r backdrop-blur-sm transition-[width] duration-200 ${
              sidebarMode === 'rail' ? 'w-14' : 'w-56'
            }`}
            style={{ background: 'hsl(var(--sidebar))', borderColor: 'hsl(var(--border-soft))' }}
          >
            <SidebarInner rail={sidebarMode === 'rail'} />
          </aside>
        )}

        {/* Sidebar mode-cycle toggle (full → rail → hidden → full).
            Same mechanism as before, but now three states; the icon
            rotates to communicate the next direction. */}
        <button
          title={
            sidebarMode === 'full' ? 'Collapse to icons (rail)'
              : sidebarMode === 'rail' ? 'Hide sidebar'
              : 'Show sidebar'
          }
          onClick={cycleSidebar}
          className="hidden lg:flex absolute z-10 items-center justify-center w-4 h-10 bg-muted border border-border hover:bg-secondary transition-colors text-muted-foreground"
          style={{
            left: sidebarMode === 'full' ? 224 : sidebarMode === 'rail' ? 56 : 0,
            top: '50%',
            transform: 'translateY(-50%)',
            borderRadius: '0 4px 4px 0',
          }}
        >
          <svg width="8" height="12" viewBox="0 0 8 12" fill="none" stroke="currentColor" strokeWidth="1.5">
            {sidebarMode !== 'hidden' ? (
              <><line x1="6" y1="1" x2="2" y2="6" /><line x1="2" y1="6" x2="6" y2="11" /></>
            ) : (
              <><line x1="2" y1="1" x2="6" y2="6" /><line x1="6" y1="6" x2="2" y2="11" /></>
            )}
          </svg>
        </button>

        {/* Main content */}
        <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
          {/* Mobile top bar */}
          <div
            className="lg:hidden flex items-center gap-3 px-4 py-3 border-b shrink-0"
            style={{ background: 'hsl(var(--surface-soft) / 0.95)', borderColor: 'hsl(var(--border-soft))' }}
          >
            <button
              onClick={() => setMobileSidebarOpen(true)}
              className="p-1.5 rounded hover:bg-muted text-muted-foreground transition-colors"
              aria-label="Open menu"
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <line x1="3" y1="6" x2="21" y2="6" />
                <line x1="3" y1="12" x2="21" y2="12" />
                <line x1="3" y1="18" x2="21" y2="18" />
              </svg>
            </button>
            <BrandLogo withLabel size="sm" />
            <Link
              to="/setup"
              className="ml-auto px-3 py-1.5 rounded-md bg-primary hover:bg-primary/90 text-primary-foreground text-xs font-semibold shadow-retro"
            >
              + New
            </Link>
          </div>

          <UpdateBanner />
          {/* No PageTransition here — withChrome() in App.tsx already wraps
              every page in one; nesting them compounds the fade (opacity
              multiplies) and doubles the slide distance on every nav. */}
          {children}
          <CommandPalette />
        </div>
      </div>
    </div>
  );
}
