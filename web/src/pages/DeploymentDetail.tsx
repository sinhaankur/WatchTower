import { useCallback, useEffect, useRef, useState } from 'react';
import { useParams, Link, useNavigate } from 'react-router-dom';
import apiClient from '@/lib/api';
import { Skeleton } from '@/components/Skeleton';

// ── Types (mirror schemas.DeploymentDetailResponse) ──────────────────────────

type Deployment = {
  id: string;
  project_id: string;
  commit_sha: string;
  commit_message: string | null;
  branch: string;
  status: string;
  trigger: string;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
  triggered_by_email: string | null;
  triggered_by_name: string | null;
};

type Build = {
  id: string;
  status: string;
  build_output: string | null;
  started_at: string | null;
  completed_at: string | null;
};

type NodeStatus = {
  node_id: string;
  node_name: string | null;
  node_host: string | null;
  status: string | null;
  deployed_at: string | null;
};

type DetailResponse = {
  deployment: Deployment;
  builds: Build[];
  nodes: NodeStatus[];
};

// ── Helpers ──────────────────────────────────────────────────────────────────

const STATUS_COLOR: Record<string, string> = {
  live:        'bg-emerald-100 text-emerald-700 border-emerald-200',
  success:     'bg-emerald-100 text-emerald-700 border-emerald-200',
  building:    'bg-blue-100 text-blue-700 border-blue-200',
  deploying:   'bg-indigo-100 text-indigo-700 border-indigo-200',
  running:     'bg-blue-100 text-blue-700 border-blue-200',
  pending:     'bg-amber-100 text-amber-700 border-amber-200',
  failed:      'bg-red-100 text-red-700 border-red-200',
  cancelled:   'bg-slate-100 text-slate-500 border-slate-200',
  rolled_back: 'bg-slate-100 text-slate-500 border-slate-200',
};

const ACTIVE = new Set(['pending', 'building', 'deploying', 'running']);
const isActive = (s: string | null | undefined) => ACTIVE.has((s ?? '').toLowerCase());

function Badge({ status }: { status: string | null | undefined }) {
  const s = (status ?? 'unknown').toLowerCase();
  const cls = STATUS_COLOR[s] ?? 'bg-slate-100 text-slate-600 border-slate-200';
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium border ${cls}`}>
      {(status ?? 'unknown').replace(/_/g, ' ')}
    </span>
  );
}

function fmtDate(s: string | null) {
  return s ? new Date(s).toLocaleString() : '—';
}

function fmtDuration(startISO: string | null, endISO: string | null, now: number, active: boolean): string {
  if (!startISO) return '—';
  const start = Date.parse(startISO);
  if (!Number.isFinite(start)) return '—';
  const end = active ? now : (endISO ? Date.parse(endISO) : now);
  let secs = Math.max(0, Math.round((end - start) / 1000));
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  secs %= 60;
  if (mins < 60) return `${mins}m ${secs.toString().padStart(2, '0')}s`;
  const hrs = Math.floor(mins / 60);
  return `${hrs}h ${(mins % 60).toString().padStart(2, '0')}m`;
}

// ── Lifecycle timeline ────────────────────────────────────────────────────────
// Derive the four canonical phases from timestamps + status. A phase is
// "done" once we've moved past it, "active" while we're in it, "failed" if
// the deploy failed at that phase, and "pending" if not yet reached.

type Phase = { key: string; label: string; at: string | null };
type PhaseState = 'done' | 'active' | 'failed' | 'pending';

function phaseStates(d: Deployment): Array<Phase & { state: PhaseState }> {
  const s = (d.status || '').toLowerCase();
  const failed = s === 'failed';
  const phases: Phase[] = [
    { key: 'queued',    label: 'Queued',    at: d.created_at },
    { key: 'building',  label: 'Building',  at: d.started_at },
    { key: 'deploying', label: 'Deploying', at: null },
    { key: 'live',      label: s === 'rolled_back' ? 'Rolled back' : 'Live', at: d.completed_at },
  ];

  // Index of the phase we've currently reached.
  let reached: number;
  if (s === 'pending') reached = 0;
  else if (s === 'building') reached = 1;
  else if (s === 'deploying') reached = 2;
  else reached = 3; // live / success / failed / rolled_back / cancelled

  return phases.map((p, i) => {
    let state: PhaseState;
    if (failed && i === reached) state = 'failed';
    else if (i < reached) state = 'done';
    else if (i === reached && isActive(s)) state = 'active';
    else if (i <= reached) state = 'done';
    else state = 'pending';
    return { ...p, state };
  });
}

const DOT_CLASS: Record<PhaseState, string> = {
  done:    'bg-emerald-500 border-emerald-500',
  active:  'bg-blue-500 border-blue-500 status-pulse',
  failed:  'bg-red-500 border-red-500',
  pending: 'bg-white border-slate-300',
};

function Timeline({ d, now }: { d: Deployment; now: number }) {
  const phases = phaseStates(d);
  return (
    <ol className="flex flex-col gap-0">
      {phases.map((p, i) => (
        <li key={p.key} className="flex items-start gap-3">
          <div className="flex flex-col items-center">
            <span className={`mt-1 w-3 h-3 rounded-full border-2 ${DOT_CLASS[p.state]}`} />
            {i < phases.length - 1 && (
              <span className={`w-0.5 grow min-h-[1.75rem] ${p.state === 'done' ? 'bg-emerald-300' : 'bg-slate-200'}`} />
            )}
          </div>
          <div className="pb-4 -mt-0.5">
            <div className={`text-sm font-medium ${
              p.state === 'failed' ? 'text-red-700'
              : p.state === 'active' ? 'text-blue-700'
              : p.state === 'pending' ? 'text-slate-400'
              : 'text-slate-900'}`}>
              {p.label}
              {p.state === 'active' && <span className="ml-2 text-xs text-blue-600">in progress…</span>}
              {p.state === 'failed' && <span className="ml-2 text-xs text-red-600">failed here</span>}
            </div>
            {p.at && <div className="text-xs text-muted-foreground tabular-nums">{fmtDate(p.at)}</div>}
          </div>
        </li>
      ))}
      <li className="text-xs text-muted-foreground">
        Total: <span className="tabular-nums">{fmtDuration(d.created_at, d.completed_at, now, isActive(d.status))}</span>
      </li>
    </ol>
  );
}

// ── Page ───────────────────────────────────────────────────────────────────────

export default function DeploymentDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [detail, setDetail] = useState<DetailResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());

  const load = useCallback(async () => {
    if (!id) return;
    try {
      const r = await apiClient.get<DetailResponse>(`/projects/deployments/${id}/detail`);
      setDetail(r.data);
      setError(null);
    } catch (e) {
      const msg = (e as { response?: { status?: number; data?: { detail?: string } } })?.response;
      if (msg?.status === 404) setError('Deployment not found.');
      else setError(msg?.data?.detail || 'Could not load this deployment.');
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => { void load(); }, [load]);

  const active = isActive(detail?.deployment.status);

  // Poll fast while active so the timeline + logs progress; tick the clock
  // for live durations. Both stop when the deploy settles.
  useEffect(() => {
    if (!active) return;
    const poll = setInterval(load, 3000);
    const tick = setInterval(() => setNow(Date.now()), 1000);
    return () => { clearInterval(poll); clearInterval(tick); };
  }, [active, load]);

  // Latest build drives the log viewer.
  const latestBuild = detail?.builds?.[0] ?? null;

  if (loading) return (
    <div className="p-6 flex flex-col gap-4 max-w-4xl">
      <Skeleton.Line className="h-7 w-72" />
      <Skeleton.Card />
      <Skeleton.Card />
    </div>
  );

  if (error || !detail) return (
    <div className="max-w-xl mx-auto mt-16 text-center">
      <p className="text-red-600 font-medium">{error ?? 'Deployment not found'}</p>
      <button onClick={() => navigate(-1)} className="text-sm text-blue-600 hover:underline mt-2 inline-block">
        ← Back
      </button>
    </div>
  );

  const d = detail.deployment;
  const isFailed = d.status?.toLowerCase() === 'failed';
  const isLive = d.status?.toLowerCase() === 'live';
  const triggeredBy = d.triggered_by_name || d.triggered_by_email || d.trigger;

  async function action(kind: 'rollback' | 'redeploy' | 'diagnose') {
    if (busy) return;
    setBusy(kind);
    try {
      if (kind === 'rollback') {
        if (!window.confirm('Roll back to the previous successful deployment?')) { setBusy(null); return; }
        await apiClient.post(`/projects/deployments/${d.id}/rollback`);
        await load();
      } else if (kind === 'redeploy') {
        // Re-trigger the same branch/commit on the project.
        await apiClient.post(`/projects/${d.project_id}/deployments`, {
          branch: d.branch, commit_sha: d.commit_sha,
        });
        navigate(`/projects/${d.project_id}`);
      } else if (kind === 'diagnose') {
        const r = await apiClient.get(`/projects/deployments/${d.id}/diagnose`);
        const diag = r.data as { summary?: string; suggested_fix?: string };
        window.alert(
          `Diagnosis: ${diag.summary || 'see build logs'}` +
          (diag.suggested_fix ? `\n\nSuggested fix: ${diag.suggested_fix}` : '')
        );
      }
    } catch (e) {
      const detailMsg = (e as { response?: { data?: { detail?: string } } })?.response?.data?.detail;
      window.alert(typeof detailMsg === 'string' ? detailMsg : 'Action failed.');
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="p-6 flex flex-col gap-6 max-w-4xl">
      {/* Header */}
      <div>
        <div className="flex items-center gap-2 text-sm text-muted-foreground mb-1">
          <Link to="/" className="hover:text-foreground">Dashboard</Link>
          <span>›</span>
          <Link to={`/projects/${d.project_id}`} className="hover:text-foreground">Project</Link>
          <span>›</span>
          <span className="font-mono">{(d.commit_sha || '').slice(0, 8)}</span>
        </div>
        <div className="flex items-start justify-between gap-4">
          <div>
            <h1 className="text-2xl font-bold flex items-center gap-3">
              <span className="font-mono">{(d.commit_sha || '—').slice(0, 8)}</span>
              <Badge status={d.status} />
            </h1>
            {d.commit_message && <p className="text-sm text-muted-foreground mt-1">{d.commit_message}</p>}
            <p className="text-xs text-muted-foreground mt-1">
              <span className="font-mono">{d.branch}</span> · triggered by <span className="capitalize">{triggeredBy}</span> · {fmtDate(d.created_at)}
            </p>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            {isFailed && (
              <button onClick={() => void action('diagnose')} disabled={!!busy}
                className="text-xs px-3 py-1.5 rounded-lg border border-slate-300 hover:bg-slate-50 disabled:opacity-50">
                {busy === 'diagnose' ? 'Diagnosing…' : 'Diagnose'}
              </button>
            )}
            <button onClick={() => void action('redeploy')} disabled={!!busy}
              className="text-xs px-3 py-1.5 rounded-lg border border-slate-300 hover:bg-slate-50 disabled:opacity-50">
              {busy === 'redeploy' ? 'Queuing…' : '↻ Redeploy'}
            </button>
            {isLive && (
              <button onClick={() => void action('rollback')} disabled={!!busy}
                className="text-xs px-3 py-1.5 rounded-lg border border-amber-300 bg-amber-50 hover:bg-amber-100 text-amber-800 disabled:opacity-50">
                {busy === 'rollback' ? 'Rolling back…' : '↶ Rollback'}
              </button>
            )}
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
        {/* Timeline */}
        <section className="rounded-xl border border-border p-4">
          <h2 className="text-sm font-semibold mb-3">Lifecycle</h2>
          <Timeline d={d} now={now} />
        </section>

        {/* Nodes */}
        <section className="rounded-xl border border-border p-4 md:col-span-2">
          <h2 className="text-sm font-semibold mb-3">Target nodes</h2>
          {detail.nodes.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No remote nodes — built locally, artifacts stored on this host.
            </p>
          ) : (
            <table className="w-full text-sm">
              <thead className="text-xs uppercase text-muted-foreground">
                <tr>
                  <th className="text-left py-1.5">Node</th>
                  <th className="text-left py-1.5">Host</th>
                  <th className="text-left py-1.5">Status</th>
                  <th className="text-left py-1.5">Deployed</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {detail.nodes.map(n => (
                  <tr key={n.node_id}>
                    <td className="py-2">{n.node_name || <span className="font-mono text-xs">{n.node_id.slice(0, 8)}</span>}</td>
                    <td className="py-2 font-mono text-xs text-muted-foreground">{n.node_host || '—'}</td>
                    <td className="py-2"><Badge status={n.status} /></td>
                    <td className="py-2 text-xs text-muted-foreground">{fmtDate(n.deployed_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
      </div>

      {/* Build logs */}
      <BuildLogViewer build={latestBuild} active={active} />
    </div>
  );
}

// ── Build log viewer (live WS streaming, mirrors ProjectDetail's pattern) ─────

function BuildLogViewer({ build, active }: { build: Build | null; active: boolean }) {
  const [log, setLog] = useState('');
  const preRef = useRef<HTMLPreElement>(null);

  useEffect(() => {
    if (!build) { setLog(''); return; }
    setLog(build.build_output ?? '');
    if (build.status !== 'running') return;

    let cancelled = false;
    let attempt = 0;
    let socket: WebSocket | null = null;
    let retry: ReturnType<typeof setTimeout> | null = null;

    const open = () => {
      if (cancelled) return;
      const url = `${window.location.origin.replace('http', 'ws')}/api/ws/builds/${build.id}/logs`;
      const ws = new WebSocket(url);
      socket = ws;
      ws.onopen = () => { attempt = 0; };
      ws.onmessage = (e) => {
        setLog(prev => prev + e.data);
        if (preRef.current) preRef.current.scrollTop = preRef.current.scrollHeight;
      };
      ws.onclose = () => {
        if (cancelled) return;
        const delay = Math.min(1000 * 2 ** attempt, 32000);
        attempt += 1;
        retry = setTimeout(open, delay);
      };
      ws.onerror = () => { try { ws.close(); } catch { /* ignore */ } };
    };
    open();

    return () => {
      cancelled = true;
      if (retry) clearTimeout(retry);
      if (socket) { socket.onclose = null; socket.onerror = null; try { socket.close(); } catch { /* ignore */ } }
    };
  }, [build]);

  useEffect(() => {
    if (preRef.current) preRef.current.scrollTop = preRef.current.scrollHeight;
  }, [log]);

  return (
    <section className="rounded-xl border border-border overflow-hidden">
      <div className="flex items-center justify-between px-4 py-2.5 border-b border-border bg-muted/40">
        <h2 className="text-sm font-semibold">Build logs</h2>
        {active && build?.status === 'running' && (
          <span className="inline-flex items-center gap-1.5 text-xs text-blue-600">
            <span className="w-2 h-2 rounded-full bg-blue-500 status-pulse" /> Live
          </span>
        )}
      </div>
      {build ? (
        <pre ref={preRef} className="m-0 p-4 text-xs font-mono leading-relaxed bg-slate-950 text-slate-100 overflow-auto max-h-[28rem] whitespace-pre-wrap">
          {log || 'No output yet.'}
        </pre>
      ) : (
        <p className="p-4 text-sm text-muted-foreground">No build for this deployment yet.</p>
      )}
    </section>
  );
}
