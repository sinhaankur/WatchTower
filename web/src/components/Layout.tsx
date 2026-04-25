import { ReactNode, useState, type ReactElement } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import BrandLogo from './BrandLogo';
import TitleBar from './TitleBar';
import ActivityBar from './ActivityBar';
import { PageTransition } from './PageTransition';

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

const PRIMARY_NAV: NavItem[] = [
  { path: '/',              label: 'Dashboard',     Icon: IconDashboard },
  { path: '/servers',       label: 'Servers',        Icon: IconServer },
  { path: '/applications',  label: 'Applications',   Icon: IconBox },
  { path: '/databases',     label: 'Databases',      Icon: IconDatabase },
  { path: '/integrations',  label: 'Integrations',   Icon: IconPuzzle },
  { path: '/services',      label: 'Services',       Icon: IconLayers },
];

const SECONDARY_NAV: NavItem[] = [
  { path: '/host-connect', label: 'Host Connect', Icon: IconLink },
  { path: '/team',     label: 'Team',     Icon: IconUsers },
  { path: '/settings', label: 'Settings', Icon: IconSettings },
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

      <div className="px-4 py-4 border-t" style={{ borderColor: 'hsl(214 32% 88%)' }}>
        {hasSessionToken ? (
          <div className="space-y-2">
            <Link
              to="/team"
              onClick={onNavClick}
              className="block text-xs text-slate-600 hover:text-slate-900 transition-colors"
            >
              GitHub Connections
            </Link>
            <button
              type="button"
              onClick={() => { handleLogout(); onNavClick?.(); }}
              className="block text-xs text-slate-600 hover:text-red-600 transition-colors"
            >
              Sign out
            </button>
          </div>
        ) : (
          <Link to="/login" onClick={onNavClick} className="block text-xs text-slate-600 hover:text-red-700 transition-colors">
            Sign in with GitHub →
          </Link>
        )}
        <p className="text-[10px] text-slate-500 mt-3">WatchTower Cloud Mesh v2.0.0</p>
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

          <PageTransition>{children}</PageTransition>
        </div>
      </div>
    </div>
  );
}
