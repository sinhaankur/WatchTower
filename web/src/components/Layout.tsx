import { ReactNode } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import BrandLogo from '@/components/BrandLogo';

const NAV_ITEMS = [
  { path: '/', label: 'Overview', icon: '◉' },
  { path: '/setup', label: 'New Project', icon: '+' },
  { path: '/nodes', label: 'Infrastructure', icon: '○' },
  { path: '/team', label: 'Team', icon: '◎' },
];

export default function Layout({ children }: { children: ReactNode }) {
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const hasSessionToken = Boolean(localStorage.getItem('authToken'));

  const handleLogout = () => {
    localStorage.removeItem('authToken');
    navigate('/login');
  };

  return (
    <div className="flex min-h-screen electron-shell">
      {/* Sidebar */}
      <aside className="w-64 shrink-0 electron-card-solid electron-divider border-r flex flex-col">
        {/* Brand */}
        <div className="px-5 py-5 electron-divider border-b">
          <BrandLogo size="md" withLabel />
          <p className="text-[11px] mt-1 electron-accent">Desktop Deployment Platform</p>
        </div>

        {/* Nav */}
        <nav className="flex-1 px-3 py-4 space-y-1.5">
          {NAV_ITEMS.map(({ path, label, icon }) => {
            const active = path === '/' ? pathname === '/' : pathname.startsWith(path);
            return (
              <Link
                key={path}
                to={path}
                className={`flex items-center justify-between gap-3 px-3 py-2 text-sm rounded-md transition-colors border ${
                  active
                    ? 'electron-accent-bg border-transparent font-semibold'
                    : 'electron-button border-transparent'
                }`}
              >
                <span>{label}</span>
                <span className={`text-xs font-mono ${active ? 'text-[#042034]/80' : 'electron-accent'}`}>{icon}</span>
              </Link>
            );
          })}
        </nav>

        {/* Footer */}
        <div className="px-5 py-4 border-t electron-divider">
          <p className="text-[11px] electron-accent">v2.0.0</p>
          {hasSessionToken && (
            <button
              type="button"
              onClick={handleLogout}
              className="block text-[11px] electron-accent transition-colors hover:opacity-80"
            >
              Sign out
            </button>
          )}
          <a
            href="https://github.com/sinhaankur/WatchTower"
            target="_blank"
            rel="noreferrer"
            className="text-[11px] electron-accent transition-colors hover:opacity-80"
          >
            GitHub ↗
          </a>
        </div>
      </aside>

      {/* Main content */}
      <div className="flex-1 flex flex-col min-w-0">
        {children}
      </div>
    </div>
  );
}
