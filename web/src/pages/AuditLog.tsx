import { useEffect, useMemo, useState } from 'react';
import apiClient from '@/lib/api';
import { useProFeature } from '@/hooks/queries';
import { ProLock } from '@/components/ProLock';
import EmptyState from '@/components/EmptyState';

type AuditEvent = {
  id: string;
  created_at: string | null;
  action: string;
  entity_type: string | null;
  entity_id: string | null;
  actor_email: string | null;
  request_id: string | null;
  ip_address: string | null;
  extra: unknown;
};

const ACTION_PRESETS: { label: string; value: string }[] = [
  { label: 'All actions', value: '' },
  { label: 'project.create', value: 'project.create' },
  { label: 'project.update', value: 'project.update' },
  { label: 'project.delete', value: 'project.delete' },
  { label: 'deployment.trigger', value: 'deployment.trigger' },
  { label: 'deployment.rollback', value: 'deployment.rollback' },
  { label: 'envvar.create', value: 'envvar.create' },
  { label: 'envvar.update', value: 'envvar.update' },
  { label: 'envvar.delete', value: 'envvar.delete' },
];

const ENTITY_PRESETS: { label: string; value: string }[] = [
  { label: 'All entities', value: '' },
  { label: 'project', value: 'project' },
  { label: 'deployment', value: 'deployment' },
  { label: 'envvar', value: 'envvar' },
];

function actionTone(action: string): { bg: string; text: string } {
  if (action.endsWith('.delete')) return { bg: 'bg-destructive/10', text: 'text-destructive' };
  if (action.endsWith('.create')) return { bg: 'bg-emerald-50', text: 'text-emerald-700' };
  if (action.endsWith('.update')) return { bg: 'bg-accent/10', text: 'text-amber-800' };
  if (action.endsWith('.trigger')) return { bg: 'bg-blue-50', text: 'text-blue-700' };
  if (action.endsWith('.rollback')) return { bg: 'bg-orange-50', text: 'text-orange-700' };
  return { bg: 'bg-muted', text: 'text-foreground/90' };
}

function formatRelative(iso: string | null): string {
  if (!iso) return '—';
  const now = Date.now();
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return iso;
  const sec = Math.floor((now - then) / 1000);
  if (sec < 60) return `${sec}s ago`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m ago`;
  if (sec < 86400) return `${Math.floor(sec / 3600)}h ago`;
  return `${Math.floor(sec / 86400)}d ago`;
}

export default function AuditLog() {
  const [events, setEvents] = useState<AuditEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [action, setAction] = useState('');
  const [entityType, setEntityType] = useState('');
  const [days, setDays] = useState(30);
  const [search, setSearch] = useState('');
  const [expanded, setExpanded] = useState<string | null>(null);

  // Pro gate. The /api/audit endpoint returns 402 on Free tier — we don't
  // bother fetching from it at all if we know the user can't see results.
  // Avoids a useless 402 in the network tab and lets <ProLock> render
  // immediately instead of after a fetch round-trip.
  const isPro = useProFeature('audit-log');

  useEffect(() => {
    if (!isPro) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    const params = new URLSearchParams();
    if (action) params.set('action', action);
    if (entityType) params.set('entity_type', entityType);
    params.set('days', String(days));
    params.set('limit', '200');
    apiClient
      .get<AuditEvent[]>(`/audit?${params.toString()}`)
      .then((r) => {
        if (!cancelled) setEvents(r.data);
      })
      .catch((e: unknown) => {
        if (!cancelled) {
          const msg = (e as { response?: { data?: { detail?: string } } })?.response?.data?.detail
            ?? 'Failed to load audit log';
          setError(typeof msg === 'string' ? msg : JSON.stringify(msg));
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, [action, entityType, days, isPro]);

  const filtered = useMemo(() => {
    if (!search.trim()) return events;
    const s = search.trim().toLowerCase();
    return events.filter((e) =>
      e.action.toLowerCase().includes(s) ||
      (e.actor_email ?? '').toLowerCase().includes(s) ||
      (e.entity_id ?? '').toLowerCase().includes(s) ||
      (e.request_id ?? '').toLowerCase().includes(s)
    );
  }, [events, search]);

  // Free tier: render the upsell card and stop. Header still shows so the
  // page identity is consistent (user clicked "Audit Log" in the nav and
  // sees an Audit Log page, not a generic paywall).
  if (!isPro) {
    return (
      <div className="flex-1 overflow-auto bg-muted">
        <header
          className="px-4 sm:px-6 lg:px-8 py-4 border-b"
          style={{ borderColor: 'hsl(var(--border-soft))' }}
        >
          <h1 className="text-lg font-semibold text-foreground">Audit Log</h1>
          <p className="text-xs text-muted-foreground mt-0.5">
            Append-only record of who changed what, scoped to your organization.
          </p>
        </header>
        <main className="px-4 sm:px-6 lg:px-8 py-8 max-w-3xl mx-auto w-full">
          <ProLock feature="audit-log" />
        </main>
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-auto bg-muted">
      <header
        className="px-4 sm:px-6 lg:px-8 py-4 border-b flex items-center justify-between gap-4"
        style={{ borderColor: 'hsl(var(--border-soft))' }}
      >
        <div>
          <h1 className="text-lg font-semibold text-foreground">Audit Log</h1>
          <p className="text-xs text-muted-foreground mt-0.5">
            Append-only record of who changed what, scoped to your organization.
          </p>
        </div>
        <div className="text-xs text-muted-foreground">
          {loading ? 'Loading…' : `${filtered.length} event${filtered.length === 1 ? '' : 's'}`}
        </div>
      </header>

      <main className="px-4 sm:px-6 lg:px-8 py-6 max-w-6xl mx-auto w-full space-y-4">
        {/* Filters */}
        <div className="rounded-xl border border-border bg-card p-4 grid grid-cols-1 md:grid-cols-4 gap-3">
          <div>
            <label className="block text-xs font-medium text-muted-foreground mb-1">Action</label>
            <select
              value={action}
              onChange={(e) => setAction(e.target.value)}
              className="w-full text-sm rounded-md border border-border bg-card px-2 py-1.5"
            >
              {ACTION_PRESETS.map((opt) => (
                <option key={opt.value} value={opt.value}>{opt.label}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-xs font-medium text-muted-foreground mb-1">Entity</label>
            <select
              value={entityType}
              onChange={(e) => setEntityType(e.target.value)}
              className="w-full text-sm rounded-md border border-border bg-card px-2 py-1.5"
            >
              {ENTITY_PRESETS.map((opt) => (
                <option key={opt.value} value={opt.value}>{opt.label}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-xs font-medium text-muted-foreground mb-1">Window</label>
            <select
              value={days}
              onChange={(e) => setDays(Number(e.target.value))}
              className="w-full text-sm rounded-md border border-border bg-card px-2 py-1.5"
            >
              <option value={1}>Last 24 hours</option>
              <option value={7}>Last 7 days</option>
              <option value={30}>Last 30 days</option>
              <option value={90}>Last 90 days</option>
              <option value={365}>Last year</option>
            </select>
          </div>
          <div>
            <label className="block text-xs font-medium text-muted-foreground mb-1">Search</label>
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="email, entity ID, request ID…"
              className="w-full text-sm rounded-md border border-border bg-card px-2 py-1.5"
            />
          </div>
        </div>

        {error && (
          <div className="rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
            {error}
          </div>
        )}

        {/* Events list */}
        <div className="rounded-xl border border-border bg-card overflow-hidden">
          {!loading && filtered.length === 0 && (
            <EmptyState
              compact
              title="Nothing in the log yet"
              description="As people create projects, trigger deploys, or change env vars, those actions land here. Adjust the filters above if you expected something specific."
            />
          )}
          {filtered.map((e) => {
            const tone = actionTone(e.action);
            const isOpen = expanded === e.id;
            const extraText = e.extra ? JSON.stringify(e.extra, null, 2) : null;
            return (
              <div key={e.id} className="border-b border-border last:border-b-0">
                <button
                  type="button"
                  onClick={() => setExpanded(isOpen ? null : e.id)}
                  className="w-full grid grid-cols-12 items-center gap-3 px-4 py-3 hover:bg-muted transition-colors text-left"
                >
                  <span className={`col-span-3 sm:col-span-2 text-xs font-mono px-2 py-0.5 rounded ${tone.bg} ${tone.text} truncate`}>
                    {e.action}
                  </span>
                  <span className="col-span-5 sm:col-span-3 text-xs text-foreground/90 truncate">
                    {e.actor_email ?? <em className="text-muted-foreground">unknown actor</em>}
                  </span>
                  <span className="hidden sm:block col-span-2 text-xs text-muted-foreground font-mono truncate">
                    {e.entity_type ?? '—'}
                  </span>
                  <span className="hidden sm:block col-span-3 text-xs text-muted-foreground font-mono truncate" title={e.entity_id ?? ''}>
                    {e.entity_id ?? '—'}
                  </span>
                  <span
                    className="col-span-4 sm:col-span-2 text-xs text-muted-foreground text-right"
                    title={e.created_at ?? ''}
                  >
                    {formatRelative(e.created_at)}
                  </span>
                </button>
                {isOpen && (
                  <div className="px-4 pb-4 pt-1 bg-muted/60 grid grid-cols-1 md:grid-cols-2 gap-3 text-xs">
                    <div className="space-y-1">
                      <div><span className="text-muted-foreground">When:</span> <span className="font-mono text-foreground/90">{e.created_at ?? '—'}</span></div>
                      <div><span className="text-muted-foreground">Actor:</span> <span className="text-foreground">{e.actor_email ?? '—'}</span></div>
                      <div><span className="text-muted-foreground">IP:</span> <span className="font-mono text-foreground/90">{e.ip_address ?? '—'}</span></div>
                      <div><span className="text-muted-foreground">Request ID:</span> <span className="font-mono text-foreground/90 break-all">{e.request_id ?? '—'}</span></div>
                    </div>
                    <div>
                      <div className="text-muted-foreground mb-1">Metadata</div>
                      {extraText ? (
                        <pre className="bg-card border border-border rounded p-2 text-xs font-mono text-foreground/90 overflow-auto max-h-48">
                          {extraText}
                        </pre>
                      ) : (
                        <div className="text-muted-foreground italic">none</div>
                      )}
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>

        <p className="text-xs text-muted-foreground px-1">
          Audit events are append-only and never store secret values (e.g. environment variable values are never recorded).
          Older events fall outside the read window — increase it above to see them.
        </p>
      </main>
    </div>
  );
}
