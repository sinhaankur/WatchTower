import { Link } from 'react-router-dom';
import { useEdition, type ProFeatureKey } from '@/hooks/queries';

/**
 * Pro-tier upsell card. Renders a friendly "this feature requires Pro"
 * panel whenever the install isn't on the Pro tier. Uses the feature key
 * to look up the right name + description from the edition response so
 * each lock screen feels feature-specific instead of a generic paywall.
 *
 * Place this at the top of any page or section that depends on a
 * Pro-gated endpoint, conditional on useProFeature(...) === false.
 */
export function ProLock({ feature }: { feature: ProFeatureKey }) {
  const { data, isLoading } = useEdition();

  if (isLoading) {
    return (
      <div className="rounded-xl border border-border bg-card p-8 text-center text-sm text-slate-500">
        Checking your edition…
      </div>
    );
  }

  const meta = data?.features?.[feature];
  // Defensive fallback if /api/edition didn't surface this key (frontend
  // shipped ahead of backend, etc.). Shouldn't happen in normal use but
  // we should still degrade to a generic upsell rather than a blank page.
  const name = meta?.name ?? 'This feature';
  const description =
    meta?.description ?? 'Available on the Pro tier of WatchTower.';

  return (
    <div className="rounded-2xl border-2 border-amber-200 bg-gradient-to-br from-amber-50 via-white to-amber-50/30 p-8">
      <div className="flex items-start gap-5">
        <div className="shrink-0 w-14 h-14 rounded-2xl bg-amber-100 border-2 border-amber-300 flex items-center justify-center text-2xl">
          🔒
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <h2 className="text-lg font-bold text-slate-900">{name}</h2>
            <span className="text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-full bg-amber-600 text-white border border-amber-700">
              Pro
            </span>
          </div>
          <p className="text-sm text-slate-700 mt-2 leading-relaxed">
            {description}
          </p>
          <div className="mt-5 flex flex-wrap gap-2">
            <a
              href={data?.upgrade_url ?? 'https://github.com/sinhaankur/WatchTower'}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-slate-900 hover:bg-slate-800 text-white text-sm font-semibold transition-colors"
            >
              Learn about Pro
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                <line x1="7" y1="17" x2="17" y2="7" /><polyline points="7 7 17 7 17 17" />
              </svg>
            </a>
            <Link
              to="/settings"
              className="inline-flex items-center px-4 py-2 rounded-lg border border-slate-300 bg-white hover:bg-slate-50 text-slate-700 text-sm font-medium transition-colors"
            >
              Settings
            </Link>
          </div>
          <p className="text-[11px] text-slate-500 mt-4">
            Currently on the <strong>Free</strong> tier. Pro unlocks
            this feature plus team roles, multi-region failover, SSO, and
            priority support.
          </p>
        </div>
      </div>
    </div>
  );
}

/**
 * Inline lock badge. Use next to nav items / buttons / toggles to
 * indicate "you can click this but it'll show a Pro upsell". Doesn't
 * gate the click itself — that's the Pro feature page's job.
 */
export function ProBadge({ size = 'sm' }: { size?: 'sm' | 'xs' }) {
  const cls = size === 'xs'
    ? 'text-[9px] px-1 py-0'
    : 'text-[10px] px-1.5 py-0.5';
  return (
    <span
      className={`inline-flex items-center gap-0.5 rounded font-bold uppercase tracking-wide bg-amber-100 text-amber-800 border border-amber-300 ${cls}`}
      title="Pro feature"
    >
      🔒 Pro
    </span>
  );
}
