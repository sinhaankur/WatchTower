import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useMe } from '@/hooks/queries';

// Detect Electron at module-load. We don't need reactive Electron-mode —
// the renderer process is either running inside Electron for its whole
// lifetime or it isn't.
const IS_ELECTRON =
  typeof window !== 'undefined' && Boolean((window as unknown as { electronAPI?: unknown }).electronAPI);

type Props = {
  /** When true, renders only an avatar button (rail/icon-only sidebar mode). */
  rail?: boolean;
};

/**
 * Identity dropdown rendered at the bottom of the sidebar.
 *
 * Click the avatar/name area → menu opens with profile preview, account
 * link, and sign-out. Replaces the inline "Sign out" link that used to
 * sit naked at the bottom of the sidebar — that hid the profile
 * affordance entirely (no "click your avatar" pattern users expect from
 * Vercel/Linear/etc.).
 *
 * Closes on: outside click, Escape key, navigation to a new route, blur
 * to outside the menu. Each of those was a footgun in earlier hand-rolled
 * dropdowns.
 */
export function UserMenu({ rail }: Props) {
  const { data: me, isLoading } = useMe();
  const navigate = useNavigate();
  const hasSession = typeof window !== 'undefined' && Boolean(localStorage.getItem('authToken'));
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);

  // Close on outside click, Escape, and on resize (so a popover stranded
  // off-screen after a window-shrink doesn't linger).
  useEffect(() => {
    if (!open) return;
    const handleClick = (e: MouseEvent) => {
      if (!rootRef.current) return;
      if (rootRef.current.contains(e.target as Node)) return;
      setOpen(false);
    };
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    const handleResize = () => setOpen(false);
    document.addEventListener('mousedown', handleClick);
    document.addEventListener('keydown', handleKey);
    window.addEventListener('resize', handleResize);
    return () => {
      document.removeEventListener('mousedown', handleClick);
      document.removeEventListener('keydown', handleKey);
      window.removeEventListener('resize', handleResize);
    };
  }, [open]);

  const handleSignOut = () => {
    // Match Layout.tsx's sign-out semantics: leave a sentinel so
    // Login.tsx's auto-login doesn't immediately re-authenticate against
    // VITE_API_TOKEN. Without it, sign-out used to be a no-op in dev /
    // Electron — Login mounted, saw the env-baked token, bounced you
    // straight back to the dashboard.
    try { localStorage.setItem('wt:explicitlySignedOut', '1'); } catch { /* ignore */ }
    try { localStorage.removeItem('authToken'); } catch { /* ignore */ }
    setOpen(false);
    navigate('/login');
  };

  if (!hasSession) {
    return (
      <Link
        to="/login"
        className={
          rail
            ? 'mx-1 my-2 flex items-center justify-center w-9 h-9 rounded-full border border-slate-300 hover:border-slate-500 text-slate-600 hover:text-slate-900 transition-colors'
            : 'block text-xs text-slate-600 hover:text-red-700 transition-colors px-1'
        }
        title="Sign in with GitHub"
      >
        {rail ? (
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4" /><polyline points="10 17 15 12 10 7" /><line x1="15" y1="12" x2="3" y2="12" />
          </svg>
        ) : 'Sign in with GitHub →'}
      </Link>
    );
  }

  // Initials for the placeholder avatar — single letter, uppercase.
  const initial = (me?.name ?? me?.email ?? '?').slice(0, 1).toUpperCase();
  const avatarNode = me?.avatar_url ? (
    <img
      src={me.avatar_url}
      alt=""
      className={`rounded-full border border-slate-200 shrink-0 ${rail ? 'w-7 h-7' : 'w-7 h-7'}`}
    />
  ) : (
    <div
      className={`rounded-full bg-slate-200 text-slate-600 text-xs font-semibold flex items-center justify-center shrink-0 uppercase ${
        rail ? 'w-7 h-7' : 'w-7 h-7'
      }`}
    >
      {initial}
    </div>
  );

  // Rail mode: just an avatar button, dropdown opens to the right.
  // Full mode: full identity card, dropdown opens above (it lives at the
  // sidebar bottom — opening downward would clip).
  if (rail) {
    return (
      <div ref={rootRef} className="relative flex justify-center">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-haspopup="menu"
          aria-expanded={open}
          title={me?.email ?? me?.name ?? 'Account'}
          className="rounded-full focus:outline-none focus:ring-2 focus:ring-slate-400/40"
        >
          {avatarNode}
        </button>
        {open && (
          <DropdownPanel
            me={me}
            onSignOut={handleSignOut}
            onClose={() => setOpen(false)}
            anchor="rail"
          />
        )}
      </div>
    );
  }

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        className={`w-full flex items-center gap-2 px-2 py-2 rounded-lg bg-white border border-border text-left transition-colors hover:border-slate-400 focus:outline-none focus:ring-2 focus:ring-slate-400/40 ${
          open ? 'border-slate-400 ring-2 ring-slate-400/30' : ''
        }`}
      >
        {isLoading && !me ? (
          <>
            <div className="w-7 h-7 rounded-full bg-slate-200 shrink-0 animate-pulse" />
            <div className="min-w-0 flex-1 space-y-1">
              <div className="h-2.5 w-24 bg-slate-200 rounded animate-pulse" />
              <div className="h-2 w-32 bg-slate-100 rounded animate-pulse" />
            </div>
          </>
        ) : (
          <>
            {avatarNode}
            <div className="min-w-0 flex-1">
              <p className="text-[11px] font-medium text-slate-900 truncate flex items-center gap-1" title={me?.email ?? ''}>
                <span className="truncate">
                  {me?.name ?? me?.email ?? (me?.is_guest ? 'Guest' : 'Signed in')}
                </span>
                {me?.is_github_authenticated && (
                  <svg viewBox="0 0 16 16" width="11" height="11" fill="currentColor" className="shrink-0 text-slate-700" aria-label="Signed in with GitHub">
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
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              className={`shrink-0 text-slate-400 transition-transform ${open ? 'rotate-180' : ''}`}
              aria-hidden="true"
            >
              <polyline points="6 9 12 15 18 9" />
            </svg>
          </>
        )}
      </button>
      {open && (
        <DropdownPanel
          me={me}
          onSignOut={handleSignOut}
          onClose={() => setOpen(false)}
          anchor="full"
        />
      )}
    </div>
  );
}

type DropdownPanelProps = {
  me: ReturnType<typeof useMe>['data'];
  onSignOut: () => void;
  onClose: () => void;
  anchor: 'rail' | 'full';
};

function DropdownPanel({ me, onSignOut, onClose, anchor }: DropdownPanelProps) {
  // Position:
  //   full: open upward (anchor at sidebar bottom; downward would clip).
  //   rail: open to the right of the avatar (rail is too narrow for
  //         left/right placement, and downward also clips).
  const position =
    anchor === 'rail'
      ? 'absolute left-full top-0 ml-2'
      : 'absolute bottom-full mb-2 left-0 right-0';

  return (
    <div
      role="menu"
      className={`${position} z-30 rounded-lg border border-slate-200 bg-white shadow-lg overflow-hidden ${
        anchor === 'rail' ? 'w-56' : ''
      }`}
    >
      {/* Profile header — bigger, friendlier than the trigger card. */}
      <div className="px-3 py-3 border-b border-slate-100 bg-slate-50/60">
        <div className="flex items-center gap-2.5">
          {me?.avatar_url ? (
            <img src={me.avatar_url} alt="" className="w-9 h-9 rounded-full border border-slate-200" />
          ) : (
            <div className="w-9 h-9 rounded-full bg-slate-200 text-slate-600 text-sm font-semibold flex items-center justify-center uppercase">
              {(me?.name ?? me?.email ?? '?').slice(0, 1)}
            </div>
          )}
          <div className="min-w-0 flex-1">
            <p className="text-xs font-semibold text-slate-900 truncate">
              {me?.name ?? me?.email ?? 'Signed in'}
            </p>
            {me?.email && me?.name && (
              <p className="text-[10px] text-slate-500 truncate" title={me.email}>{me.email}</p>
            )}
          </div>
        </div>
        {me?.org_name && (
          <p className="mt-2 text-[10px] text-slate-500 truncate">
            <span className="text-slate-400">org · </span>
            <span className="font-medium text-slate-700">{me.org_name}</span>
            {me.role && <> · <span className="capitalize">{me.role}</span></>}
          </p>
        )}
        {me?.is_guest && (
          <p className="mt-2 text-[10px] text-amber-700 bg-amber-50 border border-amber-200 px-2 py-1 rounded">
            Guest mode — sign in with GitHub for full access
          </p>
        )}
      </div>

      {/* Menu items */}
      <div className="py-1">
        <Link
          to="/account"
          onClick={onClose}
          role="menuitem"
          className="flex items-center gap-2.5 px-3 py-2 text-xs text-slate-700 hover:bg-slate-100 transition-colors"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-slate-400">
            <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
            <circle cx="12" cy="7" r="4" />
          </svg>
          Account &amp; security
        </Link>
        <Link
          to="/settings"
          onClick={onClose}
          role="menuitem"
          className="flex items-center gap-2.5 px-3 py-2 text-xs text-slate-700 hover:bg-slate-100 transition-colors"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-slate-400">
            <circle cx="12" cy="12" r="3" />
            <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.6 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.6a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
          </svg>
          App settings
        </Link>
      </div>

      <div className="border-t border-slate-100 py-1">
        <button
          type="button"
          role="menuitem"
          onClick={onSignOut}
          className="w-full flex items-center gap-2.5 px-3 py-2 text-xs text-red-600 hover:bg-red-50 hover:text-red-700 transition-colors"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
            <polyline points="16 17 21 12 16 7" />
            <line x1="21" y1="12" x2="9" y2="12" />
          </svg>
          Sign out{IS_ELECTRON ? ' of this app' : ''}
        </button>
      </div>
    </div>
  );
}
