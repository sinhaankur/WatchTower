import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useMe } from '@/hooks/queries';
import { toast } from '@/lib/toast';

const IS_ELECTRON =
  typeof window !== 'undefined' && Boolean((window as unknown as { electronAPI?: unknown }).electronAPI);

/**
 * /account — full identity + security page reachable from the sidebar
 * UserMenu. Pre-1.13.0 the only sign-out affordance was a tiny text
 * link at the bottom of the sidebar, and there was no way to inspect
 * what account you were signed into. This page surfaces:
 *   - Profile snapshot (avatar, name, email, GitHub username)
 *   - Auth method & org/role
 *   - Permissions matrix (so the user knows what they can do)
 *   - Session controls (sign out)
 *   - Future: revoke other devices, rotate signing key, manage tokens
 */
export default function Account() {
  const { data: me, isLoading } = useMe();
  const navigate = useNavigate();
  const [signingOut, setSigningOut] = useState(false);

  const handleSignOut = () => {
    if (signingOut) return;
    setSigningOut(true);
    try { localStorage.setItem('wt:explicitlySignedOut', '1'); } catch { /* ignore */ }
    try { localStorage.removeItem('authToken'); } catch { /* ignore */ }
    toast.success('Signed out');
    navigate('/login');
  };

  if (isLoading && !me) {
    return (
      <div className="max-w-3xl mx-auto px-6 py-8">
        <div className="h-7 w-40 bg-slate-200 rounded animate-pulse" />
        <div className="mt-2 h-4 w-72 bg-slate-100 rounded animate-pulse" />
        <div className="mt-8 h-48 bg-white border border-slate-200 rounded-xl animate-pulse" />
      </div>
    );
  }

  const initial = (me?.name ?? me?.email ?? '?').slice(0, 1).toUpperCase();
  const authMethodLabel = me?.is_github_authenticated
    ? 'GitHub'
    : me?.is_guest
      ? 'Guest mode'
      : 'API token';

  return (
    <div className="max-w-3xl mx-auto px-6 py-8">
      {/* Page header */}
      <header className="mb-6">
        <h1 className="text-xl font-semibold text-slate-900">Account &amp; security</h1>
        <p className="mt-1 text-sm text-slate-500">
          Your identity, organization membership, and session controls for this WatchTower install.
        </p>
      </header>

      {/* Profile card */}
      <section className="rounded-xl border border-slate-800 bg-white shadow-[2px_2px_0_0_#1f2937] mb-6">
        <div className="flex items-start gap-4 p-5">
          {me?.avatar_url ? (
            <img
              src={me.avatar_url}
              alt=""
              className="w-16 h-16 rounded-full border border-slate-300 shrink-0"
            />
          ) : (
            <div className="w-16 h-16 rounded-full bg-slate-200 text-slate-600 text-xl font-semibold flex items-center justify-center shrink-0 uppercase">
              {initial}
            </div>
          )}
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 flex-wrap">
              <h2 className="text-base font-semibold text-slate-900 truncate">
                {me?.name ?? me?.email ?? 'Signed in'}
              </h2>
              {me?.is_github_authenticated && (
                <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-slate-100 border border-slate-200 text-[10px] font-medium text-slate-700">
                  <svg viewBox="0 0 16 16" width="11" height="11" fill="currentColor" aria-hidden="true">
                    <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z" />
                  </svg>
                  GitHub
                </span>
              )}
              {me?.is_guest && (
                <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-amber-50 border border-amber-200 text-[10px] font-medium text-amber-700">
                  Guest mode
                </span>
              )}
            </div>
            <dl className="mt-3 grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-2 text-sm">
              <Field label="Email" value={me?.email ?? '—'} mono />
              <Field label="GitHub ID" value={me?.github_id ?? '—'} mono />
              <Field label="Auth method" value={authMethodLabel} />
              <Field label="User ID" value={me?.user_id ?? '—'} mono small />
            </dl>
          </div>
        </div>
      </section>

      {/* Organization & role */}
      <section className="rounded-xl border border-slate-800 bg-white shadow-[2px_2px_0_0_#1f2937] mb-6">
        <div className="px-5 py-4 border-b border-slate-200">
          <h2 className="text-sm font-semibold text-slate-900">Organization</h2>
          <p className="mt-0.5 text-xs text-slate-500">
            Which tenant of WatchTower you belong to and what role gives you which permissions.
          </p>
        </div>
        <div className="p-5">
          <dl className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-2 text-sm">
            <Field label="Org name" value={me?.org_name ?? '—'} />
            <Field label="Role" value={me?.role ? me.role : '—'} capitalize />
          </dl>
          <div className="mt-4 grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs">
            <Capability ok={me?.can_create_projects} label="Create projects" />
            <Capability ok={me?.can_manage_deployments} label="Manage deployments" />
            <Capability ok={me?.can_manage_nodes} label="Manage nodes" />
            <Capability ok={me?.can_manage_team} label="Manage team" />
          </div>
        </div>
      </section>

      {/* Session security */}
      <section className="rounded-xl border border-slate-800 bg-white shadow-[2px_2px_0_0_#1f2937] mb-6">
        <div className="px-5 py-4 border-b border-slate-200">
          <h2 className="text-sm font-semibold text-slate-900">Session</h2>
          <p className="mt-0.5 text-xs text-slate-500">
            Sessions persist across {IS_ELECTRON ? 'app restarts' : 'browser restarts'} for up to 30 days.
            The session signing key lives at <code className="font-mono text-[10.5px] bg-slate-100 border border-slate-200 px-1 py-0.5 rounded">~/.watchtower/auth-signing.key</code> on this install.
          </p>
        </div>
        <div className="p-5 space-y-3">
          <div className="flex items-start gap-3 p-3 rounded-lg bg-slate-50 border border-slate-200">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-slate-500 mt-0.5 shrink-0">
              <rect x="3" y="11" width="18" height="11" rx="2" ry="2" /><path d="M7 11V7a5 5 0 0 1 10 0v4" />
            </svg>
            <div className="text-xs text-slate-600">
              Sign out clears the stored session token on this device. Other devices remain signed in until their tokens expire or you delete the install's signing key.
            </div>
          </div>
          <button
            type="button"
            onClick={handleSignOut}
            disabled={signingOut}
            className="inline-flex items-center gap-2 px-3 py-2 rounded-md border border-red-300 bg-white text-red-700 text-xs font-medium hover:bg-red-50 hover:border-red-400 transition-colors disabled:opacity-60 disabled:cursor-wait"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
              <polyline points="16 17 21 12 16 7" />
              <line x1="21" y1="12" x2="9" y2="12" />
            </svg>
            {signingOut ? 'Signing out…' : `Sign out${IS_ELECTRON ? ' of this app' : ''}`}
          </button>
        </div>
      </section>
    </div>
  );
}

function Field({
  label,
  value,
  mono,
  small,
  capitalize,
}: {
  label: string;
  value: string;
  mono?: boolean;
  small?: boolean;
  capitalize?: boolean;
}) {
  return (
    <div className="min-w-0">
      <dt className="text-[10px] uppercase tracking-wider font-semibold text-slate-500">{label}</dt>
      <dd
        className={`mt-0.5 truncate text-slate-900 ${mono ? 'font-mono' : ''} ${
          small ? 'text-[11px]' : 'text-sm'
        } ${capitalize ? 'capitalize' : ''}`}
        title={value}
      >
        {value}
      </dd>
    </div>
  );
}

function Capability({ ok, label }: { ok?: boolean; label: string }) {
  return (
    <div
      className={`flex items-center gap-1.5 px-2 py-1.5 rounded-md border text-[11px] ${
        ok
          ? 'bg-emerald-50 border-emerald-200 text-emerald-800'
          : 'bg-slate-50 border-slate-200 text-slate-400'
      }`}
      title={ok ? `You can ${label.toLowerCase()}` : `You cannot ${label.toLowerCase()}`}
    >
      {ok ? (
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3">
          <polyline points="20 6 9 17 4 12" />
        </svg>
      ) : (
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
        </svg>
      )}
      <span className="truncate">{label}</span>
    </div>
  );
}
