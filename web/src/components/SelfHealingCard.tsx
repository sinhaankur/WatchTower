import { Link } from 'react-router-dom';
import { useHealingActions } from '@/hooks/queries';

/**
 * Self-healing activity feed — WatchTower's headline differentiator, made
 * visible. The self-heal engine runs silently in the background; this surfaces
 * "here's what WatchTower caught and fixed for you" on the Dashboard so the
 * one thing no competitor does is actually legible.
 *
 * Renders nothing when there's no healing history (fresh install), so it never
 * clutters an empty dashboard.
 */

// Humanize the backend failure_kind enum into a short, plain-English label.
const KIND_LABEL: Record<string, string> = {
  port_conflict: 'Port conflict',
  registry_flake: 'Registry hiccup',
  oom: 'Out of memory',
  build_error: 'Build error',
  missing_env: 'Missing env var',
  timeout: 'Timeout',
  unknown: 'Unknown failure',
};

function statusMeta(a: { status: string; auto_applicable: boolean }): { dot: string; text: string; label: string } {
  switch (a.status) {
    case 'auto_applied':
      return { dot: 'bg-emerald-500', text: 'text-emerald-700', label: 'Auto-fixed' };
    case 'approved':
      return { dot: 'bg-emerald-500', text: 'text-emerald-700', label: 'Fixed (approved)' };
    case 'pending':
      return { dot: 'bg-amber-500', text: 'text-amber-700', label: 'Needs you' };
    case 'failed':
      return { dot: 'bg-red-500', text: 'text-red-700', label: 'Fix failed' };
    case 'dismissed':
      return { dot: 'bg-slate-400', text: 'text-muted-foreground', label: 'Dismissed' };
    default:
      return { dot: 'bg-slate-400', text: 'text-muted-foreground', label: a.status };
  }
}

function fmtWhen(iso: string | null): string {
  if (!iso) return '';
  const secs = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  if (secs < 60) return 'just now';
  if (secs < 3600) return `${Math.round(secs / 60)}m ago`;
  if (secs < 86400) return `${Math.round(secs / 3600)}h ago`;
  return `${Math.round(secs / 86400)}d ago`;
}

export default function SelfHealingCard() {
  const { data: actions, isLoading } = useHealingActions();
  const items = (actions ?? []).slice(0, 5);

  // Fresh install with no healing history — stay out of the way.
  if (isLoading || items.length === 0) return null;

  const autoFixed = (actions ?? []).filter((a) => a.status === 'auto_applied' || a.status === 'approved').length;

  return (
    <div className="rounded-lg border border-border bg-card p-5 shadow-retro">
      <div className="flex items-center justify-between gap-3 mb-1">
        <h2 className="text-sm font-semibold text-foreground flex items-center gap-2">
          <span aria-hidden>🩹</span> Self-healing activity
        </h2>
        {autoFixed > 0 && (
          <span className="text-[11px] font-medium text-emerald-700 bg-emerald-50 border border-emerald-200 px-2 py-0.5 rounded-full">
            {autoFixed} auto-fixed
          </span>
        )}
      </div>
      <p className="text-xs text-muted-foreground mb-3">
        WatchTower watches your deploys, diagnoses failures, and fixes what it can on its own.
      </p>

      <div className="space-y-1.5">
        {items.map((a) => {
          const m = statusMeta(a);
          const kind = KIND_LABEL[a.failure_kind] ?? a.failure_kind;
          return (
            <div
              key={a.id}
              className="flex items-start gap-2.5 rounded-md border border-border-soft bg-surface-soft px-3 py-2"
            >
              <span className={`mt-1 inline-block w-1.5 h-1.5 rounded-full shrink-0 ${m.dot}`} />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2 flex-wrap text-xs">
                  <span className="font-medium text-foreground truncate">{a.project_name ?? 'Project'}</span>
                  <span className="text-muted-foreground">·</span>
                  <span className="text-muted-foreground">{kind}</span>
                  <span className={`ml-auto font-medium ${m.text}`}>{m.label}</span>
                </div>
                {a.fix_description && (
                  <p className="text-[11px] text-muted-foreground mt-0.5 truncate" title={a.fix_description}>
                    {a.status === 'auto_applied' || a.status === 'approved' ? '↳ ' : ''}{a.fix_description}
                  </p>
                )}
                <p className="text-[10px] text-muted-foreground/70 mt-0.5">{fmtWhen(a.created_at)}</p>
              </div>
            </div>
          );
        })}
      </div>

      <div className="mt-3 flex items-center justify-between">
        <Link to="/settings" className="text-xs text-primary hover:text-primary/80 font-medium">
          Manage autonomy →
        </Link>
      </div>
    </div>
  );
}
