import { ReactNode, useState, useEffect, type ReactElement } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import BrandLogo from './BrandLogo';
import TitleBar from './TitleBar';
import ActivityBar from './ActivityBar';
import { PageTransition } from './PageTransition';
import { useUpdateCheck, useMe } from '@/hooks/queries';

const UPDATE_BANNER_DISMISSED_KEY = 'watchtower:updateBannerDismissed';

function UpdateBanner() {
  // Banner appears once per (current,latest) pair — dismissing it stores
  // the latest version, so the same release won't nag again but a future
  // release will resurface the banner.
  const { data } = useUpdateCheck();
  const [dismissedFor, setDismissedFor] = useState<string | null>(() => {
    try { return localStorage.getItem(UPDATE_BANNER_DISMISSED_KEY); } catch { return null; }
  });

  useEffect(() => {
    if (!data?.has_update) return;
    // No-op — placeholder to silence the dependency lint and keep the
    // visibility logic centralised in render.
  }, [data?.has_update]);

  if (!data?.has_update || dismissedFor === data.latest) return null;

  const dismiss = () => {
    if (!data.latest) return;
    try { localStorage.setItem(UPDATE_BANNER_DISMISSED_KEY, data.latest); } catch { /* ignore */ }
    setDismissedFor(data.latest);
  };

  return (
    <div className="flex items-center gap-3 px-4 py-2 bg-amber-50 border-b border-amber-200 text-amber-900 text-xs">
      <span className="inline-flex items-center justify-center w-4 h-4 rounded-full bg-amber-400 text-amber-900 text-[10px] font-bold">!</span>
      <span className="flex-1">
        <strong>WatchTower {data.latest}</strong> is available
        {data.current && <> — you're on <span className="font-mono">{data.current}</span></>}.
      </span>
      {data.release_url && (
        <a
          href={data.release_url}
          target="_blank"
          rel="noopener noreferrer"
          className="px-2 py-0.5 rounded border border-amber-700 bg-white text-amber-800 hover:bg-amber-100 font-medium"
        >
          Release notes
        </a>
      )}
      <Link
        to="/settings"
        className="px-2 py-0.5 rounded border border-amber-700 bg-white text-amber-800 hover:bg-amber-100 font-medium"
      >
        Update
      </Link>
      <button
        onClick={dismiss}
        title="Dismiss until next release"
        className="ml-1 text-amber-700 hover:text-amber-900"
        aria-label="Dismiss update banner"
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
        </svg>
      </button>
    </div>
  );
}

// Detect if running inside Electron
const isElectron = typeof window !== 'undefined' && Boolean((window as any).electronAPI);

// ── SVG icon helpers ──────────────────────────────────────────────────────────
function IconDashboard() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="3" width="7" height="7" rx="1" />
      <rect x="14" y="3" width="7" height="7" rx="1" />
      <rect x="3" y="14" width="7" height="7" rx="1" />
      <rect x="14" y="14" width="7" height="7" rx="1" />
    </svg>
  );
}
function IconServer() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="2" y="2" width="20" height="8" rx="2" />
      <rect x="2" y="14" width="20" height="8" rx="2" />
      <line x1="6" y1="6" x2="6.01" y2="6" />
      <line x1="6" y1="18" x2="6.01" y2="18" />
    </svg>
  );
}
function IconBox() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z" />
      <polyline points="3.27 6.96 12 12.01 20.73 6.96" />
      <line x1="12" y1="22.08" x2="12" y2="12" />
    </svg>
  );
}
function IconDatabase() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <ellipse cx="12" cy="5" rx="9" ry="3" />
      <path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3" />
      <path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5" />
    </svg>
  );
}
function IconLayers() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polygon points="12 2 2 7 12 12 22 7 12 2" />
      <polyline points="2 17 12 22 22 17" />
      <polyline points="2 12 12 17 22 12" />
    </svg>
  );
}
function IconUsers() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
      <circle cx="9" cy="7" r="4" />
      <path d="M23 21v-2a4 4 0 0 0-3-3.87" />
      <path d="M16 3.13a4 4 0 0 1 0 7.75" />
    </svg>
  );
}
function IconSettings() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </svg>
  );
}
function IconShield() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
      <path d="M9 12l2 2 4-4" />
    </svg>
  );
}
function IconLink() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07L11.9 4.99" />
      <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.57-1.52" />
    </svg>
  );
}
function IconPlus() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <line x1="12" y1="5" x2="12" y2="19" />
      <line x1="5" y1="12" x2="19" y2="12" />
    </svg>
  );
}

// ── Navigation structure ──────────────────────────────────────────────────────
type NavItem = { path: string; label: string; Icon: () => ReactElement };

function IconPuzzle() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M20.24 12.24a6 6 0 0 0-8.49-8.49L5 10.5V19h8.5z" />
      <line x1="16" y1="8" x2="2" y2="22" />
      <line x1="17.5" y1="15" x2="9" y2="15" />
    </svg>
  );
}

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
const PRIMARY_NAV: NavItem[] = [
  { path: '/',              label: 'Dashboard',     Icon: IconDashboard },
  { path: '/applications',  label: 'Applications',  Icon: IconBox },
  { path: '/servers',       label: 'Servers',       Icon: IconServer },
  { path: '/services',      label: 'Services',      Icon: IconLayers },
];

const SECONDARY_NAV: NavItem[] = [
  { path: '/integrations', label: 'Integrations', Icon: IconPuzzle },
  { path: '/team',         label: 'Team',         Icon: IconUsers },
  { path: '/audit',        label: 'Audit Log',    Icon: IconShield },
  { path: '/settings',     label: 'Settings',     Icon: IconSettings },
];

function NavLink({ item, pathname, onClick }: { item: NavItem; pathname: string; onClick?: () => void }) {
  const active = item.path === '/' ? pathname === '/' : pathname.startsWith(item.path);
  return (
    <Link
      to={item.path}
      onClick={onClick}
      className={`flex items-center gap-3 px-3 py-2 rounded-lg text-sm font-medium transition-all ${
        active
          ? 'bg-red-50 text-red-700 border-l-2 border-red-700 pl-[10px] shadow-sm'
          : 'text-slate-600 hover:bg-white hover:text-slate-900 border-l-2 border-transparent pl-[10px]'
      }`}
    >
      <item.Icon />
      {item.label}
    </Link>
  );
}

// ── Layout ────────────────────────────────────────────────────────────────────
export default function Layout({ children }: { children: ReactNode }) {
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const hasSessionToken = Boolean(localStorage.getItem('authToken'));
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false);
  const { data: updateData } = useUpdateCheck();
  const versionLabel = updateData?.current ? `v${updateData.current}` : '';
  const { data: me, isLoading: meLoading } = useMe();

  const handleLogout = () => {
    localStorage.removeItem('authToken');
    navigate('/login');
  };

  // Shared sidebar content used in both desktop sidebar and mobile drawer
  const SidebarInner = ({ onNavClick }: { onNavClick?: () => void }) => (
    <>
      {!isElectron && (
        <div className="px-4 py-5 border-b" style={{ borderColor: 'hsl(214 32% 88%)' }}>
          <BrandLogo withLabel size="md" />
        </div>
      )}
      {isElectron && <div className="h-3" />}

      <div className="px-3 pt-3 pb-2">
        <Link
          to="/setup"
          onClick={onNavClick}
          className="flex items-center justify-center gap-2 w-full py-2 px-3 rounded-xl bg-red-700 hover:bg-red-800 border border-slate-800 shadow-[2px_2px_0_0_#1f2937] transition-colors text-white text-sm font-semibold"
        >
          <IconPlus />
          New Resource
        </Link>
      </div>

      <nav className="flex-1 px-3 py-2 space-y-0.5 overflow-y-auto">
        {PRIMARY_NAV.map((item) => (
          <NavLink key={item.path} item={item} pathname={pathname} onClick={onNavClick} />
        ))}
        <div className="my-3 border-t" style={{ borderColor: 'hsl(214 32% 88%)' }} />
        {SECONDARY_NAV.map((item) => (
          <NavLink key={item.path} item={item} pathname={pathname} onClick={onNavClick} />
        ))}
      </nav>

      <div className="px-3 py-3 border-t" style={{ borderColor: 'hsl(214 32% 88%)' }}>
        {hasSessionToken ? (
          <>
            {/* Identity badge — who am I, in which org */}
            {meLoading && !me ? (
              <div className="flex items-center gap-2 px-2 py-2 rounded-lg bg-white border border-border mb-2 animate-pulse">
                <div className="w-7 h-7 rounded-full bg-slate-200 shrink-0" />
                <div className="min-w-0 flex-1 space-y-1">
                  <div className="h-2.5 w-24 bg-slate-200 rounded" />
                  <div className="h-2 w-32 bg-slate-100 rounded" />
                </div>
              </div>
            ) : (
            <div className="flex items-center gap-2 px-2 py-2 rounded-lg bg-white border border-border mb-2">
              {me?.avatar_url ? (
                <img
                  src={me.avatar_url}
                  alt=""
                  className="w-7 h-7 rounded-full border border-slate-200 shrink-0"
                />
              ) : (
                <div className="w-7 h-7 rounded-full bg-slate-200 text-slate-600 text-xs font-semibold flex items-center justify-center shrink-0 uppercase">
                  {(me?.name ?? me?.email ?? '?').slice(0, 1)}
                </div>
              )}
              <div className="min-w-0 flex-1">
                <p
                  className="text-[11px] font-medium text-slate-900 truncate flex items-center gap-1"
                  title={me?.email ?? ''}
                >
                  <span className="truncate">
                    {me?.name ?? me?.email ?? (me?.is_guest ? 'Guest' : 'Signed in')}
                  </span>
                  {me?.is_github_authenticated && (
                    <svg
                      viewBox="0 0 16 16"
                      width="11"
                      height="11"
                      fill="currentColor"
                      className="shrink-0 text-slate-700"
                      aria-label="Signed in with GitHub"
                    >
                      <title>Signed in with GitHub</title>
                      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z" />
                    </svg>
                  )}
                </p>
                <p className="text-[10px] text-slate-500 truncate" title={me?.org_name ?? ''}>
                  {me?.is_guest
                    ? 'Guest mode · sign in for full features'
                    : me?.org_name
                      ? `${me.org_name}${me.role ? ` · ${me.role}` : ''}`
                      : 'WatchTower'}
                </p>
              </div>
            </div>
            )}
            {/* Team used to live here too, but it was a duplicate of
                the SECONDARY_NAV item — sidebar footer now only carries
                the action that doesn't fit anywhere else: Sign out. */}
            <div className="flex justify-end px-1">
              <button
                type="button"
                onClick={() => { handleLogout(); onNavClick?.(); }}
                className="text-[11px] text-slate-600 hover:text-red-600 transition-colors"
              >
                Sign out
              </button>
            </div>
          </>
        ) : (
          <Link to="/login" onClick={onNavClick} className="block text-xs text-slate-600 hover:text-red-700 transition-colors px-1">
            Sign in with GitHub →
          </Link>
        )}
        <p className="text-[10px] text-slate-500 mt-3 px-1">
          WatchTower{versionLabel ? ` ${versionLabel}` : ''}
          {updateData?.has_update && (
            <Link to="/settings" className="ml-1 text-amber-700 hover:text-amber-900 font-medium">
              · update available
            </Link>
          )}
        </p>
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
            style={{ background: 'hsl(214 55% 98%)', borderColor: 'hsl(214 32% 88%)' }}
          >
            <div className="flex items-center justify-between px-4 py-3 border-b" style={{ borderColor: 'hsl(214 32% 88%)' }}>
              <BrandLogo withLabel size="md" />
              <button
                onClick={() => setMobileSidebarOpen(false)}
                className="p-1.5 rounded hover:bg-slate-200 text-slate-500 transition-colors"
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
        {isElectron && <ActivityBar />}

        {/* Desktop sidebar */}
        {sidebarOpen && (
          <aside
            className="hidden lg:flex shrink-0 flex-col border-r backdrop-blur-sm"
            style={{ width: 224, background: 'hsl(214 55% 98%)', borderColor: 'hsl(214 32% 88%)' }}
          >
            <SidebarInner />
          </aside>
        )}

        {/* Desktop sidebar toggle */}
        <button
          title={sidebarOpen ? 'Collapse sidebar' : 'Expand sidebar'}
          onClick={() => setSidebarOpen((v) => !v)}
          className="hidden lg:flex absolute z-10 items-center justify-center w-4 h-10 bg-slate-100 border border-slate-200 hover:bg-slate-200 transition-colors text-slate-500"
          style={{
            left: isElectron ? (sidebarOpen ? 48 + 224 : 48) : (sidebarOpen ? 224 : 0),
            top: '50%',
            transform: 'translateY(-50%)',
            borderRadius: '0 4px 4px 0',
          }}
        >
          <svg width="8" height="12" viewBox="0 0 8 12" fill="none" stroke="currentColor" strokeWidth="1.5">
            {sidebarOpen ? (
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
            style={{ background: 'rgba(248, 251, 255, 0.95)', borderColor: 'hsl(214 32% 88%)' }}
          >
            <button
              onClick={() => setMobileSidebarOpen(true)}
              className="p-1.5 rounded hover:bg-slate-100 text-slate-600 transition-colors"
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
              className="ml-auto px-3 py-1.5 rounded-lg bg-red-700 hover:bg-red-800 text-white text-xs font-semibold border border-slate-800"
            >
              + New
            </Link>
          </div>

          <UpdateBanner />
          <PageTransition>{children}</PageTransition>
        </div>
      </div>
    </div>
  );
}
