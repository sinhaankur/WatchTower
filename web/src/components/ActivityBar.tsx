import { Link, useLocation } from 'react-router-dom';
import { type ReactElement } from 'react';

type ActivityItem = {
  path: string;
  label: string;
  icon: () => ReactElement;
  bottom?: boolean;
};

function IcoDashboard() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="3" width="7" height="7" rx="1" />
      <rect x="14" y="3" width="7" height="7" rx="1" />
      <rect x="3" y="14" width="7" height="7" rx="1" />
      <rect x="14" y="14" width="7" height="7" rx="1" />
    </svg>
  );
}
function IcoServer() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <rect x="2" y="2" width="20" height="8" rx="2" />
      <rect x="2" y="14" width="20" height="8" rx="2" />
      <line x1="6" y1="6" x2="6.01" y2="6" />
      <line x1="6" y1="18" x2="6.01" y2="18" />
    </svg>
  );
}
function IcoBox() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z" />
      <polyline points="3.27 6.96 12 12.01 20.73 6.96" />
      <line x1="12" y1="22.08" x2="12" y2="12" />
    </svg>
  );
}
function IcoDatabase() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <ellipse cx="12" cy="5" rx="9" ry="3" />
      <path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3" />
      <path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5" />
    </svg>
  );
}
function IcoLayers() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <polygon points="12 2 2 7 12 12 22 7 12 2" />
      <polyline points="2 17 12 22 22 17" />
      <polyline points="2 12 12 17 22 12" />
    </svg>
  );
}
function IcoLink() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07L11.9 4.99" />
      <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.57-1.52" />
    </svg>
  );
}
function IcoUsers() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
      <circle cx="9" cy="7" r="4" />
      <path d="M23 21v-2a4 4 0 0 0-3-3.87" />
      <path d="M16 3.13a4 4 0 0 1 0 7.75" />
    </svg>
  );
}
function IcoSettings() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </svg>
  );
}

const ITEMS: ActivityItem[] = [
  { path: '/',             label: 'Dashboard',    icon: IcoDashboard },
  { path: '/servers',      label: 'Servers',      icon: IcoServer },
  { path: '/applications', label: 'Applications', icon: IcoBox },
  { path: '/databases',    label: 'Databases',    icon: IcoDatabase },
  { path: '/services',     label: 'Services',     icon: IcoLayers },
  { path: '/host-connect', label: 'Host Connect', icon: IcoLink },
  { path: '/team',         label: 'Team',         icon: IcoUsers },
];

const BOTTOM_ITEMS: ActivityItem[] = [
  { path: '/settings', label: 'Settings', icon: IcoSettings, bottom: true },
];

function ActivityButton({ item, active }: { item: ActivityItem; active: boolean }) {
  return (
    <Link
      to={item.path}
      title={item.label}
      className="group relative flex items-center justify-center w-12 h-12 transition-colors"
      style={{
        borderLeft: active ? '2px solid #b91c1c' : '2px solid transparent',
        color: active ? '#b91c1c' : '#64748b',
        background: active ? 'rgba(185,28,28,0.07)' : 'transparent',
      }}
    >
      <item.icon />
      {/* Tooltip */}
      <span
        className="pointer-events-none absolute left-14 z-50 whitespace-nowrap rounded bg-slate-900 px-2 py-1 text-xs text-white opacity-0 group-hover:opacity-100 transition-opacity"
        style={{ fontFamily: 'Space Mono, monospace' }}
      >
        {item.label}
      </span>
    </Link>
  );
}

export default function ActivityBar() {
  const { pathname } = useLocation();

  function isActive(item: ActivityItem) {
    return item.path === '/' ? pathname === '/' : pathname.startsWith(item.path);
  }

  return (
    <aside
      className="shrink-0 flex flex-col items-center border-r border-slate-200 overflow-hidden"
      style={{ width: 48, background: '#f8f4ed' }}
    >
      <div className="flex flex-col flex-1 w-full pt-2">
        {ITEMS.map((item) => (
          <ActivityButton key={item.path} item={item} active={isActive(item)} />
        ))}
      </div>
      <div className="flex flex-col w-full pb-2 border-t border-slate-200">
        {BOTTOM_ITEMS.map((item) => (
          <ActivityButton key={item.path} item={item} active={isActive(item)} />
        ))}
      </div>
    </aside>
  );
}
