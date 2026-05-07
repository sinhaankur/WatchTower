import { Fragment, useEffect, useRef, useState } from 'react';
import { useParams, Link /*, useNavigate*/ } from 'react-router-dom';
import apiClient from '@/lib/api';
import {
  useProjects,
  useProjectRelations,
  useAddRelation,
  useRemoveRelation,
  useRunWithRelated,
} from '@/hooks/queries';

/** Pull a 'detail' message out of an axios-shaped error, with fallback. */
function extractDetail(err: unknown, fallback: string): string {
  const detail = (err as { response?: { data?: { detail?: string } } })?.response?.data?.detail;
  return typeof detail === 'string' && detail.length > 0 ? detail : fallback;
}

// ── Types ─────────────────────────────────────────────────────────────────────

type Project = {
  id: string;
  name: string;
  use_case: string;
  repo_url: string;
  repo_branch: string;
  build_command: string | null;
  created_at: string;
};

type Deployment = {
  id: string;
  commit_sha: string;
  commit_message: string | null;
  branch: string;
  status: string;
  trigger: string;
  created_at: string;
  completed_at: string | null;
};

type Build = {
  id: string;
  status: string;
  started_at: string | null;
  completed_at: string | null;
  build_output: string | null;
};

type EnvVar = {
  id: string;
  key: string;
  value: string;
  environment: string;
};

type Webhook = {
  id: string;
  provider: string;
  label: string | null;
  url: string;
  is_active: boolean;
};

// (RelatedProject + RunResultItem types now come from web/src/hooks/queries.ts
// — they're owned by the hook layer to keep the API contract in one place.)

// ── Helpers ───────────────────────────────────────────────────────────────────

const STATUS_COLOR: Record<string, string> = {
  live:       'bg-emerald-100 text-emerald-700 border-emerald-200',
  building:   'bg-blue-100 text-blue-700 border-blue-200',
  deploying:  'bg-indigo-100 text-indigo-700 border-indigo-200',
  pending:    'bg-amber-100 text-amber-700 border-amber-200',
  failed:     'bg-red-100 text-red-700 border-red-200',
  cancelled:  'bg-slate-100 text-slate-500 border-slate-200',
  rolled_back:'bg-slate-100 text-slate-500 border-slate-200',
};

function Badge({ status }: { status: string }) {
  const cls = STATUS_COLOR[status.toLowerCase()] ?? 'bg-slate-100 text-slate-600 border-slate-200';
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium border ${cls}`}>
      {status.replace(/_/g, ' ')}
    </span>
  );
}

function fmtDate(s: string | null) {
  if (!s) return '—';
  return new Date(s).toLocaleString();
}

// ── Tabs ──────────────────────────────────────────────────────────────────────

const TABS = ['Overview', 'Deployments', 'Build Logs', 'Env Vars', 'Domains', 'Webhooks', 'Related'] as const;
type Tab = typeof TABS[number];

// ── Main component ────────────────────────────────────────────────────────────

export default function ProjectDetail() {
  const { id } = useParams<{ id: string }>();
  // const navigate = useNavigate();
  const [project, setProject] = useState<Project | null>(null);
  const [tab, setTab] = useState<Tab>('Overview');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!id) return;
    apiClient.get(`/projects/${id}`)
      .then(r => setProject(r.data))
      .catch(() => setError('Project not found'))
      .finally(() => setLoading(false));
  }, [id]);

  if (loading) return <div className="flex items-center justify-center h-64 text-muted-foreground">Loading…</div>;
  if (error || !project) return (
    <div className="max-w-xl mx-auto mt-16 text-center">
      <p className="text-red-600 font-medium">{error ?? 'Project not found'}</p>
      <Link to="/" className="text-sm text-blue-600 hover:underline mt-2 inline-block">← Back to dashboard</Link>
    </div>
  );

  return (
    <div className="flex flex-col gap-0 h-full">
      {/* Header */}
      <div className="border-b border-border bg-card px-6 py-5">
        <div className="flex items-center gap-3 mb-1">
          <Link to="/" className="text-sm text-muted-foreground hover:text-foreground transition-colors">Dashboard</Link>
          <span className="text-muted-foreground text-sm">›</span>
          <span className="text-sm font-medium">{project.name}</span>
        </div>
        <div className="flex items-end justify-between">
          <div>
            <h1 className="text-2xl font-bold">{project.name}</h1>
            <p className="text-sm text-muted-foreground mt-1">
              {project.repo_url} · <span className="font-mono">{project.repo_branch}</span>
            </p>
          </div>
          <TriggerDeployButton projectId={project.id} branch={project.repo_branch} />
        </div>
      </div>

      {/* Tabs */}
      <div className="border-b border-border bg-card px-6 flex gap-1">
        {TABS.map(t => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`px-4 py-3 text-sm font-medium border-b-2 transition-colors ${
              tab === t
                ? 'border-red-600 text-red-700'
                : 'border-transparent text-muted-foreground hover:text-foreground'
            }`}
          >
            {t}
          </button>
        ))}
      </div>

      {/* Tab content */}
      <div className="flex-1 overflow-auto p-6">
        {tab === 'Overview'     && <OverviewTab project={project} />}
        {tab === 'Deployments'  && <DeploymentsTab projectId={project.id} />}
        {tab === 'Build Logs'   && <BuildLogsTab projectId={project.id} />}
        {tab === 'Env Vars'     && <EnvVarsTab projectId={project.id} />}
        {tab === 'Domains'      && <DomainsTab projectId={project.id} />}
        {tab === 'Webhooks'     && <WebhooksTab projectId={project.id} />}
        {tab === 'Related'      && <RelatedTab projectId={project.id} />}
      </div>
    </div>
  );
}

// ── TriggerDeployButton ───────────────────────────────────────────────────────

function TriggerDeployButton({ projectId, branch }: { projectId: string; branch: string }) {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  async function trigger() {
    setBusy(true);
    setMsg(null);
    try {
      await apiClient.post(`/projects/${projectId}/deployments`, {
        branch,
        commit_sha: 'manual',
        node_ids: [],
      });
      setMsg('Deployment queued!');
    } catch {
      setMsg('Failed to trigger deployment');
    } finally {
      setBusy(false);
      setTimeout(() => setMsg(null), 4000);
    }
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <button
        onClick={trigger}
        disabled={busy}
        className="px-4 py-2 rounded-lg bg-red-600 hover:bg-red-700 text-white text-sm font-medium disabled:opacity-50 transition-colors"
      >
        {busy ? 'Queueing…' : 'Deploy Now'}
      </button>
      {msg && <p className={`text-xs ${msg.startsWith('Failed') ? 'text-red-600' : 'text-emerald-600'}`}>{msg}</p>}
    </div>
  );
}

// ── HealthCheckCard ───────────────────────────────────────────────────────────
//
// Foundation for gap #2 (health checks + auto-rollback). v1 ships an
// on-demand probe; v2 adds continuous polling, v3 adds auto-rollback.
// User clicks "Check health" → backend hits the project's launch_url
// + /health (configurable path) → result rendered inline. No
// continuous polling here.

type HealthResult = {
  status: 'healthy' | 'unhealthy' | 'unreachable' | 'no_url';
  response_code: number | null;
  latency_ms: number | null;
  url: string | null;
  error: string | null;
};

function HealthCheckCard({ projectId }: { projectId: string }) {
  const [result, setResult] = useState<HealthResult | null>(null);
  const [checking, setChecking] = useState(false);
  const [path, setPath] = useState('/health');

  const runProbe = async () => {
    setChecking(true);
    try {
      const r = await apiClient.get(`/projects/${projectId}/health-check`, {
        params: { path },
      });
      setResult(r.data);
    } catch (e) {
      setResult({
        status: 'unreachable',
        response_code: null,
        latency_ms: null,
        url: null,
        error: extractDetail(e, 'Probe failed'),
      });
    } finally {
      setChecking(false);
    }
  };

  const statusColor =
    result?.status === 'healthy'
      ? 'border-emerald-300 bg-emerald-50 text-emerald-700'
      : result?.status === 'unhealthy'
        ? 'border-amber-300 bg-amber-50 text-amber-800'
        : result?.status === 'unreachable'
          ? 'border-red-300 bg-red-50 text-red-700'
          : 'border-slate-300 bg-slate-50 text-slate-600';

  return (
    <div className="rounded-xl border border-border bg-card overflow-hidden">
      <div className="px-5 py-4 border-b border-border bg-muted/30 flex items-center gap-3">
        <h2 className="text-sm font-semibold flex-1">Health Check</h2>
        <span className="text-[10px] text-muted-foreground">on-demand probe</span>
      </div>
      <div className="px-5 py-4 space-y-3">
        <p className="text-xs text-slate-600">
          Probe the deployed app's health endpoint synchronously. Continuous
          monitoring + auto-rollback ship in v2 — this is the foundation.
        </p>
        <div className="flex items-center gap-2">
          <label className="text-[11px] text-slate-600 w-20 shrink-0">Path</label>
          <input
            type="text"
            value={path}
            onChange={(e) => setPath(e.target.value)}
            placeholder="/health"
            className="flex-1 text-xs px-2 py-1.5 rounded border border-slate-300 focus:border-slate-800 focus:outline-none font-mono"
          />
          <button
            onClick={() => void runProbe()}
            disabled={checking}
            className="text-xs px-3 py-1.5 rounded-lg border border-slate-800 bg-amber-400 hover:bg-amber-500 text-slate-900 font-semibold shadow-[1px_1px_0_0_#1f2937] disabled:opacity-50 disabled:cursor-wait"
          >
            {checking ? 'Probing…' : 'Check health'}
          </button>
        </div>

        {result && (
          <div className={`rounded border p-3 space-y-1 ${statusColor}`}>
            <div className="flex items-center gap-2">
              <span className="text-[10px] uppercase font-bold tracking-wide">{result.status.replace('_', ' ')}</span>
              {result.response_code !== null && (
                <span className="text-[10px] font-mono">HTTP {result.response_code}</span>
              )}
              {result.latency_ms !== null && result.latency_ms > 0 && (
                <span className="text-[10px] font-mono">{result.latency_ms} ms</span>
              )}
            </div>
            {result.url && (
              <p className="text-[11px] font-mono break-all opacity-80">{result.url}</p>
            )}
            {result.error && (
              <p className="text-[11px] opacity-80">{result.error}</p>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// ── OverviewTab ───────────────────────────────────────────────────────────────

function OverviewTab({ project }: { project: Project }) {
  const items = [
    { label: 'Project ID', value: project.id },
    { label: 'Use Case', value: project.use_case.replace(/_/g, ' ') },
    { label: 'Repository', value: project.repo_url },
    { label: 'Branch', value: project.repo_branch },
    { label: 'Created', value: fmtDate(project.created_at) },
  ];

  // Webhook URL for GitHub
  const webhookUrl = `${window.location.origin}/api/webhooks/github/${project.id}`;

  return (
    <div className="max-w-2xl flex flex-col gap-6">
      <div className="rounded-xl border border-border bg-card overflow-hidden">
        <div className="px-5 py-4 border-b border-border bg-muted/30">
          <h2 className="text-sm font-semibold">Project Details</h2>
        </div>
        <dl className="divide-y divide-border">
          {items.map(({ label, value }) => (
            <div key={label} className="flex px-5 py-3 gap-4">
              <dt className="w-36 text-xs text-muted-foreground flex-shrink-0 flex items-center">{label}</dt>
              <dd className="text-sm font-mono break-all">{value}</dd>
            </div>
          ))}
        </dl>
      </div>

      <HealthCheckCard projectId={project.id} />

      <RunLocallyCard projectId={project.id} />

      <BuildCommandCard project={project} />

      <div className="rounded-xl border border-border bg-card overflow-hidden">
        <div className="px-5 py-4 border-b border-border bg-muted/30">
          <h2 className="text-sm font-semibold">GitHub Webhook URL</h2>
        </div>
        <div className="px-5 py-4 flex items-center gap-3">
          <code className="flex-1 text-xs bg-muted rounded px-3 py-2 break-all font-mono">{webhookUrl}</code>
          <button
            onClick={() => navigator.clipboard.writeText(webhookUrl)}
            className="text-xs px-3 py-2 rounded border border-border hover:bg-muted transition-colors"
          >
            Copy
          </button>
        </div>
      </div>
    </div>
  );
}

// ── BuildCommandCard ──────────────────────────────────────────────────────────
// Inline editor for Project.build_command. NULL/empty in the DB means
// "auto-detect at deploy time based on lockfile" — shown to the user as
// "Auto-detect" so they don't have to know about the column being nullable.

function BuildCommandCard({ project }: { project: Project }) {
  const [saved, setSaved] = useState<string | null>(project.build_command);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<string>(project.build_command ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const placeholder = 'npm install && npm run build';

  const startEdit = () => {
    setDraft(saved ?? '');
    setError(null);
    setEditing(true);
  };

  const cancel = () => {
    setEditing(false);
    setError(null);
  };

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const trimmed = draft.trim();
      const resp = await apiClient.put(`/projects/${project.id}`, {
        build_command: trimmed,
      });
      const next: string | null = resp.data?.build_command ?? null;
      setSaved(next && next.length > 0 ? next : null);
      setEditing(false);
    } catch (err) {
      setError(extractDetail(err, 'Failed to save build command'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="rounded-xl border border-border bg-card overflow-hidden">
      <div className="px-5 py-4 border-b border-border bg-muted/30 flex items-center justify-between">
        <h2 className="text-sm font-semibold">Build Command</h2>
        {!editing && (
          <button
            onClick={startEdit}
            className="text-xs px-3 py-1 rounded border border-border hover:bg-muted transition-colors"
          >
            {saved ? 'Edit' : 'Override'}
          </button>
        )}
      </div>
      <div className="px-5 py-4 flex flex-col gap-3">
        {!editing && (
          <>
            <code className="text-xs bg-muted rounded px-3 py-2 break-all font-mono">
              {saved ?? `Auto-detect (default: ${placeholder})`}
            </code>
            <p className="text-xs text-muted-foreground">
              {saved
                ? 'Custom override. Runs verbatim during every deploy.'
                : 'WatchTower picks an install command (npm / pnpm / yarn / bun) based on the lockfile in your repo, then runs `npm run build`. Set an override to run a different pipeline.'}
            </p>
          </>
        )}
        {editing && (
          <>
            <input
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              placeholder={placeholder}
              className="w-full text-sm font-mono px-3 py-2 rounded border border-border bg-white focus:outline-none focus:border-blue-500"
            />
            <p className="text-xs text-muted-foreground">
              Leave blank to fall back to auto-detect.
            </p>
            {error && <p className="text-xs text-red-600">{error}</p>}
            <div className="flex gap-2">
              <button
                onClick={save}
                disabled={busy}
                className="text-xs px-3 py-1.5 rounded bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50 transition-colors"
              >
                {busy ? 'Saving…' : 'Save'}
              </button>
              <button
                onClick={cancel}
                disabled={busy}
                className="text-xs px-3 py-1.5 rounded border border-border hover:bg-muted disabled:opacity-50 transition-colors"
              >
                Cancel
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

// ── DeploymentsTab ────────────────────────────────────────────────────────────

type Diagnosis = {
  kind:
    | 'port_in_use' | 'missing_env_var' | 'package_not_found'
    | 'build_oom' | 'permission_denied' | 'disk_full'
    | 'git_auth_failed' | 'network_failure' | 'build_timeout'
    | 'tls_failure' | 'registry_transient' | 'runtime_oom'
    | 'unknown';
  cause: string;
  fix: { description: string; command: string | null; auto_applicable: boolean };
  matched_text: string | null;
  extracted: Record<string, string>;
  deployment_id: string;
  deployment_status: string | null;
  build_id: string | null;
  // Set only when kind=unknown AND a log exists to analyze. Lets the
  // SPA show "Ask the agent" with a pre-filled prompt without an
  // extra round-trip.
  agent_prompt?: string;
  agent_route?: string;
};

function DeploymentsTab({ projectId }: { projectId: string }) {
  const [deployments, setDeployments] = useState<Deployment[]>([]);
  const [loading, setLoading] = useState(true);
  // Map of deployment_id → diagnosis state. Cached per row so re-running
  // diagnose doesn't re-fetch unless the user closes and reopens.
  const [diagnoses, setDiagnoses] = useState<Record<string, { state: 'loading' | 'ready' | 'error'; data?: Diagnosis; error?: string }>>({});

  async function load() {
    try {
      const r = await apiClient.get(`/projects/${projectId}/deployments`);
      setDeployments(r.data);
    } catch {
      setDeployments([]);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
    const t = setInterval(load, 10_000);
    return () => clearInterval(t);
  }, [projectId]);

  async function runDiagnose(deploymentId: string) {
    // Toggle off if already open.
    if (diagnoses[deploymentId]) {
      setDiagnoses(prev => {
        const next = { ...prev };
        delete next[deploymentId];
        return next;
      });
      return;
    }
    setDiagnoses(prev => ({ ...prev, [deploymentId]: { state: 'loading' } }));
    try {
      const r = await apiClient.get(`/projects/deployments/${deploymentId}/diagnose`);
      setDiagnoses(prev => ({ ...prev, [deploymentId]: { state: 'ready', data: r.data } }));
    } catch (e) {
      const msg = (e as { response?: { data?: { detail?: string } } })?.response?.data?.detail ?? 'Could not diagnose this deployment.';
      setDiagnoses(prev => ({ ...prev, [deploymentId]: { state: 'error', error: msg } }));
    }
  }

  // Per-row in-flight flag so the user can't double-click rollback while
  // the previous request is mid-air. Backend rolls back via a new
  // queued deploy + flips the current LIVE row to ROLLED_BACK, so a
  // refresh after the call gives the user authoritative state.
  const [rolling, setRolling] = useState<Record<string, boolean>>({});

  async function runRollback(deploymentId: string) {
    if (rolling[deploymentId]) return;
    const ok = window.confirm(
      'Roll back to the previous successful deployment?\n\n' +
      'This queues a new deployment that re-deploys the prior commit, ' +
      'and marks the current live deployment as rolled-back.'
    );
    if (!ok) return;
    setRolling(prev => ({ ...prev, [deploymentId]: true }));
    try {
      await apiClient.post(`/deployments/${deploymentId}/rollback`);
      // Optimistic refresh — the new rolled-back-to deployment shows up
      // at the top of the list, current row flips status. The 10s
      // polling interval would catch this anyway but immediate feedback
      // matters here.
      await load();
    } catch (e) {
      const detail = (e as { response?: { data?: { detail?: string } } })?.response?.data?.detail ?? 'Rollback failed.';
      window.alert(typeof detail === 'string' ? detail : JSON.stringify(detail));
    } finally {
      setRolling(prev => {
        const next = { ...prev };
        delete next[deploymentId];
        return next;
      });
    }
  }

  if (loading) return <p className="text-sm text-muted-foreground">Loading…</p>;
  if (!deployments.length) return <p className="text-sm text-muted-foreground">No deployments yet.</p>;

  return (
    <div className="max-w-4xl rounded-xl border border-border overflow-hidden">
      <table className="w-full text-sm">
        <thead className="bg-muted/50 text-xs uppercase text-muted-foreground">
          <tr>
            <th className="px-4 py-3 text-left">Commit</th>
            <th className="px-4 py-3 text-left">Branch</th>
            <th className="px-4 py-3 text-left">Status</th>
            <th className="px-4 py-3 text-left">Trigger</th>
            <th className="px-4 py-3 text-left">Started</th>
            <th className="px-4 py-3 text-left">Finished</th>
            <th className="px-4 py-3 text-left"></th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {deployments.map(d => {
            const isFailed = d.status?.toLowerCase() === 'failed';
            const isLive = d.status?.toLowerCase() === 'live';
            const diag = diagnoses[d.id];
            const isRollingBack = Boolean(rolling[d.id]);
            return (
              <Fragment key={d.id}>
                <tr className="hover:bg-muted/30 transition-colors">
                  <td className="px-4 py-3 font-mono">{(d.commit_sha || '—').slice(0, 8)}</td>
                  <td className="px-4 py-3 font-mono text-xs">{d.branch}</td>
                  <td className="px-4 py-3"><Badge status={d.status} /></td>
                  <td className="px-4 py-3 text-xs capitalize">{d.trigger}</td>
                  <td className="px-4 py-3 text-xs text-muted-foreground">{fmtDate(d.created_at)}</td>
                  <td className="px-4 py-3 text-xs text-muted-foreground">{fmtDate(d.completed_at)}</td>
                  <td className="px-4 py-3 text-right">
                    <div className="inline-flex items-center gap-1.5">
                      {isFailed && (
                        <button
                          onClick={() => void runDiagnose(d.id)}
                          className="text-[11px] px-2 py-1 rounded border border-slate-300 hover:border-slate-500 text-slate-600 hover:text-slate-900 transition-colors"
                        >
                          {diag ? 'Hide' : 'Diagnose'}
                        </button>
                      )}
                      {isLive && (
                        <button
                          onClick={() => void runRollback(d.id)}
                          disabled={isRollingBack}
                          title="Roll back to the previous successful deployment"
                          className="text-[11px] px-2 py-1 rounded border border-amber-300 bg-amber-50 hover:bg-amber-100 text-amber-800 transition-colors disabled:opacity-50"
                        >
                          {isRollingBack ? 'Rolling back…' : '↶ Rollback'}
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
                {diag && (
                  <tr>
                    <td colSpan={7} className="px-4 py-3 bg-slate-50">
                      <DiagnosisPanel
                        state={diag}
                        deploymentId={d.id}
                        onApplied={(newId) => {
                          // Remove the diagnosis panel for the failed
                          // deploy and force-refresh the list so the
                          // newly-queued deploy shows up at the top.
                          setDiagnoses(prev => {
                            const next = { ...prev };
                            delete next[d.id];
                            return next;
                          });
                          void load();
                          // Audit-friendly client log so a tab pinned
                          // open across multiple auto-fixes still
                          // produces a visible trail.
                          console.log('[WatchTower] auto-fix applied; new deployment', newId);
                        }}
                      />
                    </td>
                  </tr>
                )}
              </Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

const KIND_LABEL: Record<Diagnosis['kind'], string> = {
  port_in_use: 'Port in use',
  missing_env_var: 'Missing environment variable',
  package_not_found: 'Package not found',
  build_oom: 'Out of memory during build',
  permission_denied: 'Permission denied',
  disk_full: 'Disk full',
  git_auth_failed: 'Git authentication failed',
  network_failure: 'Network / DNS failure',
  build_timeout: 'Build timed out',
  tls_failure: 'TLS / SSL failure',
  registry_transient: 'Registry transient error',
  runtime_oom: 'Out of memory at runtime',
  unknown: 'Unrecognized failure pattern',
};

type DiagnosisPanelProps = {
  state: { state: 'loading' | 'ready' | 'error'; data?: Diagnosis; error?: string };
  deploymentId: string;
  onApplied?: (newDeploymentId: string) => void;
};

function DiagnosisPanel({ state, deploymentId, onApplied }: DiagnosisPanelProps) {
  const [applying, setApplying] = useState(false);
  const [applyResult, setApplyResult] = useState<{ ok: boolean; msg: string } | null>(null);

  if (state.state === 'loading') {
    return <p className="text-xs text-slate-600">Diagnosing failed deployment…</p>;
  }
  if (state.state === 'error') {
    return <p className="text-xs text-red-600">{state.error}</p>;
  }
  const d = state.data!;
  const isUnknown = d.kind === 'unknown';

  const applyFix = async () => {
    setApplying(true);
    setApplyResult(null);
    try {
      const r = await apiClient.post(`/projects/deployments/${deploymentId}/auto-fix`);
      const newId = r.data?.new_deployment_id as string | undefined;
      const newPort = r.data?.details?.new_port;
      setApplyResult({
        ok: true,
        msg: newPort
          ? `Queued new deployment on port ${newPort}.`
          : 'Queued new deployment.',
      });
      if (newId && onApplied) {
        // Brief delay so the user sees the success message before the
        // panel disappears on refresh.
        setTimeout(() => onApplied(newId), 1200);
      }
    } catch (e) {
      const msg = (e as { response?: { data?: { detail?: string } } })?.response?.data?.detail
        ?? 'Could not apply the fix.';
      setApplyResult({ ok: false, msg });
    } finally {
      setApplying(false);
    }
  };

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <span className={`text-[10px] px-2 py-0.5 rounded-full border font-medium ${
          isUnknown
            ? 'border-slate-300 bg-slate-100 text-slate-700'
            : 'border-amber-300 bg-amber-50 text-amber-800'
        }`}>
          {KIND_LABEL[d.kind]}
        </span>
        {d.fix.auto_applicable && (
          <span className="text-[10px] px-2 py-0.5 rounded-full border font-medium border-emerald-300 bg-emerald-50 text-emerald-700">
            Auto-fixable
          </span>
        )}
      </div>

      <p className="text-xs text-slate-800">{d.cause}</p>

      <div className="rounded border border-border bg-white p-3 space-y-2">
        <p className="text-[10px] font-semibold uppercase tracking-wide text-slate-500">Suggested fix</p>
        <p className="text-xs text-slate-800">{d.fix.description}</p>
        {d.fix.command && (
          <code className="block text-[11px] font-mono bg-slate-100 rounded px-2 py-1 text-slate-700">
            {d.fix.command}
          </code>
        )}
        {d.fix.auto_applicable && (
          <div className="flex items-center gap-2 pt-1">
            <button
              onClick={() => void applyFix()}
              disabled={applying}
              className="text-[11px] px-3 py-1 rounded border border-slate-800 bg-emerald-600 hover:bg-emerald-700 text-white font-semibold shadow-[1px_1px_0_0_#1f2937] disabled:opacity-60"
              title="Apply the suggested fix and trigger a fresh deployment"
            >
              {applying ? 'Applying…' : 'Apply fix'}
            </button>
            {applyResult && (
              <span className={`text-[11px] ${applyResult.ok ? 'text-emerald-700' : 'text-red-600'}`}>
                {applyResult.msg}
              </span>
            )}
          </div>
        )}
      </div>

      {d.matched_text && (
        <details className="text-[11px] text-slate-500">
          <summary className="cursor-pointer">Matched log line</summary>
          <pre className="mt-1 px-2 py-1 bg-slate-100 rounded font-mono text-[10px] text-slate-700 whitespace-pre-wrap">
            {d.matched_text}
          </pre>
        </details>
      )}

      {isUnknown && (
        <div className="space-y-2">
          <p className="text-[11px] text-slate-500">
            No automatic pattern matched this failure.
            {d.agent_prompt && ' The WatchTower agent can read the log and suggest a fix in plain English.'}
          </p>
          {d.agent_prompt && (
            <button
              onClick={async () => {
                // Two-step handoff: copy the prompt to clipboard so
                // the user can paste it into the agent's input,
                // then navigate to the agent route. Avoids touching
                // the agent component's internal state from here.
                try { await navigator.clipboard.writeText(d.agent_prompt!); }
                catch { /* clipboard blocked — user can re-copy from log */ }
                const route = d.agent_route ?? '/agent';
                window.location.assign(route);
              }}
              className="text-[11px] px-3 py-1 rounded border border-slate-800 bg-white hover:bg-slate-50 text-slate-800 font-semibold shadow-[1px_1px_0_0_#1f2937]"
              title="Copy the diagnosis prompt to clipboard and open the WatchTower agent"
            >
              Ask the agent (prompt copied) →
            </button>
          )}
          {!d.agent_prompt && (
            <p className="text-[11px] text-slate-500">
              Open the Build Logs tab to investigate manually.
            </p>
          )}
        </div>
      )}
    </div>
  );
}

// ── BuildLogsTab ──────────────────────────────────────────────────────────────

function BuildLogsTab({ projectId }: { projectId: string }) {
  const [deployments, setDeployments] = useState<Deployment[]>([]);
  const [selectedDeploymentId, setSelectedDeploymentId] = useState<string>('');
  const [builds, setBuilds] = useState<Build[]>([]);
  const [selectedBuild, setSelectedBuild] = useState<Build | null>(null);
  const [liveLog, setLiveLog] = useState<string>('');
  const logsRef = useRef<HTMLPreElement>(null);
  const wsRef = useRef<WebSocket | null>(null);

  useEffect(() => {
    apiClient.get(`/projects/${projectId}/deployments`)
      .then(r => {
        setDeployments(r.data);
        if (r.data.length > 0) setSelectedDeploymentId(r.data[0].id);
      })
      .catch(() => {});
  }, [projectId]);

  useEffect(() => {
    if (!selectedDeploymentId) return;
    apiClient.get(`/deployments/${selectedDeploymentId}/builds`)
      .then(r => {
        setBuilds(r.data);
        if (r.data.length > 0) setSelectedBuild(r.data[0]);
      })
      .catch(() => setBuilds([]));
  }, [selectedDeploymentId]);

  useEffect(() => {
    if (!selectedBuild) return;
    setLiveLog(selectedBuild.build_output ?? '');

    if (selectedBuild.status !== 'running') return;

    // Reconnect with exponential backoff up to ~32s. The previous code
    // had ws.onclose = () => {} which silently froze the log viewer
    // whenever the backend restarted mid-build. Now the stream resumes
    // automatically; the user only notices the brief pause.
    let cancelled = false;
    let attempt = 0;
    let socket: WebSocket | null = null;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    const buildId = selectedBuild.id;

    const open = () => {
      if (cancelled) return;
      const wsUrl = `${window.location.origin.replace('http', 'ws')}/api/ws/builds/${buildId}/logs`;
      const ws = new WebSocket(wsUrl);
      socket = ws;
      wsRef.current = ws;

      ws.onopen = () => {
        attempt = 0;  // reset backoff on a successful connect
      };
      ws.onmessage = (e) => {
        setLiveLog(prev => prev + e.data);
        if (logsRef.current) logsRef.current.scrollTop = logsRef.current.scrollHeight;
      };
      ws.onclose = () => {
        if (cancelled) return;
        const delay = Math.min(1000 * 2 ** attempt, 32000);
        attempt += 1;
        retryTimer = setTimeout(open, delay);
      };
      ws.onerror = () => {
        // Force the browser to fire onclose so reconnect logic runs.
        try { ws.close(); } catch { /* ignore */ }
      };
    };

    open();

    return () => {
      cancelled = true;
      if (retryTimer) clearTimeout(retryTimer);
      if (socket) {
        socket.onclose = null;
        socket.onerror = null;
        try { socket.close(); } catch { /* ignore */ }
      }
    };
  }, [selectedBuild]);

  // Auto-scroll on log update
  useEffect(() => {
    if (logsRef.current) logsRef.current.scrollTop = logsRef.current.scrollHeight;
  }, [liveLog]);

  return (
    <div className="flex flex-col gap-4 max-w-4xl">
      <div className="flex gap-3 flex-wrap">
        <div className="flex flex-col gap-1">
          <label className="text-xs text-muted-foreground">Deployment</label>
          <select
            value={selectedDeploymentId}
            onChange={e => setSelectedDeploymentId(e.target.value)}
            className="text-sm border border-border rounded-lg px-3 py-2 bg-card focus:outline-none focus:ring-2 focus:ring-red-500"
          >
            {deployments.map(d => (
              <option key={d.id} value={d.id}>
                {(d.commit_sha || '').slice(0, 8)} — {d.branch} ({d.status})
              </option>
            ))}
          </select>
        </div>
        {builds.length > 1 && (
          <div className="flex flex-col gap-1">
            <label className="text-xs text-muted-foreground">Build</label>
            <select
              value={selectedBuild?.id ?? ''}
              onChange={e => setSelectedBuild(builds.find(b => b.id === e.target.value) ?? null)}
              className="text-sm border border-border rounded-lg px-3 py-2 bg-card focus:outline-none focus:ring-2 focus:ring-red-500"
            >
              {builds.map(b => (
                <option key={b.id} value={b.id}>{fmtDate(b.started_at)} ({b.status})</option>
              ))}
            </select>
          </div>
        )}
      </div>

      {selectedBuild ? (
        <div className="relative">
          {selectedBuild.status === 'running' && (
            <div className="absolute top-3 right-3 flex items-center gap-1.5">
              <span className="w-2 h-2 rounded-full bg-blue-500 status-pulse" />
              <span className="text-xs text-blue-600">Live</span>
            </div>
          )}
          <pre
            ref={logsRef}
            className="bg-slate-950 text-slate-100 rounded-xl p-5 text-xs font-mono overflow-auto max-h-[60vh] leading-relaxed whitespace-pre-wrap"
          >
            {liveLog || 'No output yet.'}
          </pre>
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">Select a deployment to view logs.</p>
      )}
    </div>
  );
}

// ── EnvVarsTab ────────────────────────────────────────────────────────────────

function EnvVarsTab({ projectId }: { projectId: string }) {
  const [vars, setVars] = useState<EnvVar[]>([]);
  const [loading, setLoading] = useState(true);
  const [newKey, setNewKey] = useState('');
  const [newValue, setNewValue] = useState('');
  const [newEnv, setNewEnv] = useState('production');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    try {
      const r = await apiClient.get(`/projects/${projectId}/env`);
      setVars(r.data);
    } catch {
      setVars([]);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { load(); }, [projectId]);

  async function addVar() {
    if (!newKey.trim() || !newValue) return;
    setSaving(true);
    setError(null);
    try {
      await apiClient.post(`/projects/${projectId}/env`, {
        key: newKey.trim(),
        value: newValue,
        environment: newEnv,
      });
      setNewKey('');
      setNewValue('');
      await load();
    } catch (e: any) {
      setError(e?.response?.data?.detail ?? 'Failed to save');
    } finally {
      setSaving(false);
    }
  }

  async function deleteVar(varId: string) {
    if (!confirm('Delete this environment variable?')) return;
    try {
      await apiClient.delete(`/projects/${projectId}/env/${varId}`);
      await load();
    } catch {
      setError('Failed to delete');
    }
  }

  if (loading) return <p className="text-sm text-muted-foreground">Loading…</p>;

  return (
    <div className="max-w-3xl flex flex-col gap-6">
      {/* Add form */}
      <div className="rounded-xl border border-border bg-card p-5">
        <h3 className="text-sm font-semibold mb-4">Add Variable</h3>
        {error && <p className="text-xs text-red-600 mb-3">{error}</p>}
        <div className="flex gap-2 flex-wrap">
          <input
            value={newKey}
            onChange={e => setNewKey(e.target.value)}
            placeholder="KEY"
            className="flex-1 min-w-[140px] border border-border rounded-lg px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-red-500 bg-background"
          />
          <input
            type="password"
            value={newValue}
            onChange={e => setNewValue(e.target.value)}
            placeholder="VALUE"
            className="flex-1 min-w-[200px] border border-border rounded-lg px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-red-500 bg-background"
          />
          <select
            value={newEnv}
            onChange={e => setNewEnv(e.target.value)}
            className="border border-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-red-500 bg-card"
          >
            <option value="production">Production</option>
            <option value="staging">Staging</option>
            <option value="development">Development</option>
          </select>
          <button
            onClick={addVar}
            disabled={saving || !newKey.trim()}
            className="px-4 py-2 rounded-lg bg-red-600 hover:bg-red-700 text-white text-sm font-medium disabled:opacity-50 transition-colors"
          >
            {saving ? 'Saving…' : 'Add'}
          </button>
        </div>
      </div>

      {/* Table */}
      {vars.length === 0 ? (
        <p className="text-sm text-muted-foreground">No environment variables yet.</p>
      ) : (
        <div className="rounded-xl border border-border overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-muted/50 text-xs uppercase text-muted-foreground">
              <tr>
                <th className="px-4 py-3 text-left">Key</th>
                <th className="px-4 py-3 text-left">Value</th>
                <th className="px-4 py-3 text-left">Environment</th>
                <th className="px-4 py-3 text-left"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {vars.map(v => (
                <tr key={v.id} className="hover:bg-muted/30 transition-colors">
                  <td className="px-4 py-3 font-mono">{v.key}</td>
                  <td className="px-4 py-3 font-mono text-xs text-muted-foreground">{v.value}</td>
                  <td className="px-4 py-3 text-xs capitalize">{v.environment}</td>
                  <td className="px-4 py-3 text-right">
                    <button
                      onClick={() => deleteVar(v.id)}
                      className="text-xs text-red-600 hover:text-red-700 hover:underline"
                    >
                      Delete
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ── WebhooksTab ───────────────────────────────────────────────────────────────

function WebhooksTab({ projectId }: { projectId: string }) {
  const [hooks, setHooks] = useState<Webhook[]>([]);
  const [loading, setLoading] = useState(true);
  const [url, setUrl] = useState('');
  const [provider, setProvider] = useState('discord');
  const [label, setLabel] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    try {
      const r = await apiClient.get(`/projects/${projectId}/webhooks`);
      setHooks(r.data);
    } catch {
      setHooks([]);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { load(); }, [projectId]);

  async function addHook() {
    if (!url.trim()) return;
    setSaving(true);
    setError(null);
    try {
      await apiClient.post(`/projects/${projectId}/webhooks`, { url: url.trim(), provider, label: label || undefined });
      setUrl('');
      setLabel('');
      await load();
    } catch (e: any) {
      setError(e?.response?.data?.detail ?? 'Failed to add webhook');
    } finally {
      setSaving(false);
    }
  }

  async function deleteHook(hookId: string) {
    if (!confirm('Remove this webhook?')) return;
    try {
      await apiClient.delete(`/projects/${projectId}/webhooks/${hookId}`);
      await load();
    } catch {
      setError('Failed to remove webhook');
    }
  }

  if (loading) return <p className="text-sm text-muted-foreground">Loading…</p>;

  return (
    <div className="max-w-3xl flex flex-col gap-6">
      <div className="rounded-xl border border-border bg-card p-5">
        <h3 className="text-sm font-semibold mb-1">Add Notification Webhook</h3>
        <p className="text-xs text-muted-foreground mb-4">
          Receive deploy success / failure notifications in Discord or Slack.
        </p>
        {error && <p className="text-xs text-red-600 mb-3">{error}</p>}
        <div className="flex gap-2 flex-wrap">
          <select
            value={provider}
            onChange={e => setProvider(e.target.value)}
            className="border border-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-red-500 bg-card"
          >
            <option value="discord">Discord</option>
            <option value="slack">Slack</option>
          </select>
          <input
            value={url}
            onChange={e => setUrl(e.target.value)}
            placeholder="Webhook URL"
            className="flex-1 min-w-[280px] border border-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-red-500 bg-background"
          />
          <input
            value={label}
            onChange={e => setLabel(e.target.value)}
            placeholder="Label (optional)"
            className="w-36 border border-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-red-500 bg-background"
          />
          <button
            onClick={addHook}
            disabled={saving || !url.trim()}
            className="px-4 py-2 rounded-lg bg-red-600 hover:bg-red-700 text-white text-sm font-medium disabled:opacity-50 transition-colors"
          >
            {saving ? 'Saving…' : 'Add'}
          </button>
        </div>
      </div>

      {hooks.length === 0 ? (
        <p className="text-sm text-muted-foreground">No notification webhooks yet.</p>
      ) : (
        <div className="rounded-xl border border-border overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-muted/50 text-xs uppercase text-muted-foreground">
              <tr>
                <th className="px-4 py-3 text-left">Provider</th>
                <th className="px-4 py-3 text-left">Label</th>
                <th className="px-4 py-3 text-left">URL</th>
                <th className="px-4 py-3 text-left"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {hooks.map(h => (
                <tr key={h.id} className="hover:bg-muted/30 transition-colors">
                  <td className="px-4 py-3 capitalize font-medium">{h.provider}</td>
                  <td className="px-4 py-3 text-xs">{h.label ?? '—'}</td>
                  <td className="px-4 py-3 text-xs text-muted-foreground truncate max-w-[280px] font-mono">{h.url}</td>
                  <td className="px-4 py-3 text-right">
                    <button
                      onClick={() => deleteHook(h.id)}
                      className="text-xs text-red-600 hover:text-red-700 hover:underline"
                    >
                      Remove
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ── RelatedTab ────────────────────────────────────────────────────────────────

function RelatedTab({ projectId }: { projectId: string }) {
  // Server state via React Query — fetch, cache, invalidate are owned here.
  const relationsQ = useProjectRelations(projectId);
  const projectsQ = useProjects();
  const addMutation = useAddRelation(projectId);
  const removeMutation = useRemoveRelation(projectId);
  const runMutation = useRunWithRelated(projectId);

  // Form state stays as local useState — that's a UI concern, not a server one.
  const [chosenId, setChosenId] = useState('');
  const [order, setOrder] = useState(0);
  const [note, setNote] = useState('');

  const relations = relationsQ.data ?? [];
  const allProjects = projectsQ.data ?? [];
  const loading = relationsQ.isLoading || projectsQ.isLoading;
  const runResults = runMutation.data?.results ?? null;

  // Surface the most recent error from any mutation or query.
  const error =
    addMutation.error ? extractDetail(addMutation.error, 'Failed to add relation') :
    removeMutation.error ? 'Failed to remove relation' :
    runMutation.error ? extractDetail(runMutation.error, 'Failed to start bundle') :
    relationsQ.error || projectsQ.error ? 'Failed to load related projects' :
    null;

  // Eligible: every other project, minus ones already linked.
  const linked = new Set(relations.map(r => r.related_project_id));
  const candidates = allProjects.filter(p => p.id !== projectId && !linked.has(p.id));

  async function add() {
    if (!chosenId) return;
    await addMutation.mutateAsync({
      related_project_id: chosenId,
      order_index: order,
      note: note.trim() || undefined,
    }).then(() => {
      setChosenId('');
      setOrder(0);
      setNote('');
    }).catch(() => { /* error surfaces via addMutation.error */ });
  }

  async function remove(relatedId: string) {
    if (!confirm('Remove this related project?')) return;
    await removeMutation.mutateAsync(relatedId).catch(() => { /* surfaces via .error */ });
  }

  async function runBundle() {
    await runMutation.mutateAsync().catch(() => { /* surfaces via .error */ });
  }

  const saving = addMutation.isPending;
  const running = runMutation.isPending;

  if (loading) return <p className="text-sm text-muted-foreground">Loading…</p>;

  return (
    <div className="max-w-3xl flex flex-col gap-6">
      <div className="rounded-xl border border-border bg-card p-5">
        <div className="flex items-start justify-between gap-3 mb-1">
          <div>
            <h3 className="text-sm font-semibold">Related Applications</h3>
            <p className="text-xs text-muted-foreground mt-1">
              Other projects that should be deployed when you run this one. Lower order runs first; this project runs last.
            </p>
          </div>
          <button
            onClick={runBundle}
            disabled={running}
            className="px-4 py-2 rounded-lg bg-red-600 hover:bg-red-700 text-white text-sm font-medium disabled:opacity-50 transition-colors whitespace-nowrap"
          >
            {running ? 'Queueing…' : 'Run with Related'}
          </button>
        </div>
        {error && <p className="text-xs text-red-600 mt-3">{error}</p>}

        {runResults && (
          <div className="mt-4 rounded-lg border border-border overflow-hidden">
            <table className="w-full text-xs">
              <thead className="bg-muted/40 text-muted-foreground">
                <tr>
                  <th className="px-3 py-2 text-left">Project</th>
                  <th className="px-3 py-2 text-left">Status</th>
                  <th className="px-3 py-2 text-left">Detail</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {runResults.map(r => (
                  <tr key={r.project_id}>
                    <td className="px-3 py-2 font-medium">{r.project_name}</td>
                    <td className="px-3 py-2">
                      <span className={
                        r.status === 'queued' ? 'text-emerald-700' :
                        r.status === 'error'  ? 'text-red-700' :
                                                'text-amber-700'
                      }>
                        {r.status}
                      </span>
                    </td>
                    <td className="px-3 py-2 text-muted-foreground">{r.detail ?? (r.deployment_id ? r.deployment_id.slice(0, 8) : '—')}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="rounded-xl border border-border bg-card p-5">
        <h3 className="text-sm font-semibold mb-4">Add Related Project</h3>
        {candidates.length === 0 ? (
          <p className="text-xs text-muted-foreground">No other projects available to link.</p>
        ) : (
          <div className="flex gap-2 flex-wrap">
            <select
              value={chosenId}
              onChange={e => setChosenId(e.target.value)}
              className="flex-1 min-w-[220px] border border-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-red-500 bg-card"
            >
              <option value="">Choose a project…</option>
              {candidates.map(p => (
                <option key={p.id} value={p.id}>{p.name}</option>
              ))}
            </select>
            <input
              type="number"
              value={order}
              onChange={e => setOrder(parseInt(e.target.value || '0', 10))}
              placeholder="Order"
              className="w-24 border border-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-red-500 bg-background"
              title="Lower = runs first"
            />
            <input
              value={note}
              onChange={e => setNote(e.target.value)}
              placeholder="Note (optional)"
              className="flex-1 min-w-[180px] border border-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-red-500 bg-background"
            />
            <button
              onClick={add}
              disabled={saving || !chosenId}
              className="px-4 py-2 rounded-lg bg-red-600 hover:bg-red-700 text-white text-sm font-medium disabled:opacity-50 transition-colors"
            >
              {saving ? 'Saving…' : 'Add'}
            </button>
          </div>
        )}
      </div>

      {relations.length === 0 ? (
        <p className="text-sm text-muted-foreground">No related projects yet.</p>
      ) : (
        <div className="rounded-xl border border-border overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-muted/50 text-xs uppercase text-muted-foreground">
              <tr>
                <th className="px-4 py-3 text-left w-16">Order</th>
                <th className="px-4 py-3 text-left">Project</th>
                <th className="px-4 py-3 text-left">Branch</th>
                <th className="px-4 py-3 text-left">Note</th>
                <th className="px-4 py-3 text-left"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {relations.map(r => (
                <tr key={r.id} className="hover:bg-muted/30 transition-colors">
                  <td className="px-4 py-3 font-mono text-xs">{r.order_index}</td>
                  <td className="px-4 py-3 font-medium">
                    <Link to={`/projects/${r.related_project_id}`} className="hover:underline">
                      {r.related_project_name ?? r.related_project_id.slice(0, 8)}
                    </Link>
                  </td>
                  <td className="px-4 py-3 font-mono text-xs">{r.related_project_branch ?? '—'}</td>
                  <td className="px-4 py-3 text-xs text-muted-foreground">{r.note ?? '—'}</td>
                  <td className="px-4 py-3 text-right">
                    <button
                      onClick={() => remove(r.related_project_id)}
                      className="text-xs text-red-600 hover:text-red-700 hover:underline"
                    >
                      Remove
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ── DomainsTab ─────────────────────────────────────────────────────────────
// Manages CustomDomain rows for the project. Phase 2 of the Cloudflare
// integration is wired here: per-domain "Sync DNS to Cloudflare" so the
// A record gets created/updated automatically. Operators must have at
// least one CloudflareCredential (Integrations page) for the sync UI
// to appear.

type CustomDomain = {
  id: string;
  project_id: string;
  domain: string;
  is_primary: boolean;
  tls_enabled: boolean;
  letsencrypt_validated: boolean;
  cloudflare_credential_id: string | null;
  cloudflare_zone_id: string | null;
  cloudflare_record_id: string | null;
  cloudflare_target_ip: string | null;
  cloudflare_synced_at: string | null;
};

type CfCredential = {
  id: string;
  label: string | null;
  account_name: string | null;
};

function DomainsTab({ projectId }: { projectId: string }) {
  const [domains, setDomains] = useState<CustomDomain[] | null>(null);
  const [creds, setCreds] = useState<CfCredential[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [newDomain, setNewDomain] = useState('');
  const [adding, setAdding] = useState(false);

  const load = async () => {
    setError(null);
    try {
      const [domResp, credResp] = await Promise.all([
        apiClient.get<CustomDomain[]>(`/projects/${projectId}/domains`),
        apiClient.get<CfCredential[]>('/integrations/cloudflare'),
      ]);
      setDomains(domResp.data);
      setCreds(credResp.data);
    } catch (e) {
      setError(extractDetail(e, 'Could not load domains'));
    }
  };

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { void load(); }, [projectId]);

  const addDomain = async () => {
    const d = newDomain.trim().toLowerCase();
    if (!d) return;
    setAdding(true);
    setError(null);
    try {
      await apiClient.post(`/projects/${projectId}/domains`, { domain: d });
      setNewDomain('');
      void load();
    } catch (e) {
      setError(extractDetail(e, 'Could not add domain'));
    } finally {
      setAdding(false);
    }
  };

  return (
    <div className="space-y-4">
      {error && (
        <div className="rounded-lg border border-red-300 bg-red-50 p-3 text-xs text-red-800">{error}</div>
      )}

      <section className="rounded-xl border border-slate-200 bg-white p-4 space-y-3">
        <h2 className="text-sm font-semibold text-slate-900">Add a domain</h2>
        <p className="text-[11px] text-slate-500">
          Adding a domain here records it on the project. Automatic DNS sync to Cloudflare requires a Cloudflare API token configured under{' '}
          <a href="/integrations" className="underline hover:text-slate-700">Integrations → Cloudflare</a>.
          Without it, you'll still need to point the DNS record at this server manually.
        </p>
        {creds && creds.length === 0 && (
          <div className="flex items-start gap-2 rounded-md border border-amber-200 bg-amber-50 px-2.5 py-2 text-[11px] text-amber-800">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="mt-0.5 shrink-0">
              <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
              <line x1="12" y1="9" x2="12" y2="13" />
              <line x1="12" y1="17" x2="12.01" y2="17" />
            </svg>
            <div>
              <strong>Cloudflare not connected.</strong> You can still add a domain, but DNS won't auto-update.{' '}
              <a href="/integrations" className="underline hover:text-amber-900">Connect Cloudflare →</a>
            </div>
          </div>
        )}
        <div className="flex gap-2">
          <input
            type="text"
            value={newDomain}
            onChange={(e) => setNewDomain(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && void addDomain()}
            placeholder="app.example.com"
            className="flex-1 rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-slate-800 focus:ring-1 focus:ring-slate-800 outline-none"
          />
          <button
            type="button"
            onClick={() => void addDomain()}
            disabled={adding || !newDomain.trim()}
            className="px-3 py-1.5 rounded-md bg-slate-900 hover:bg-slate-800 disabled:opacity-50 text-white text-sm font-medium"
          >
            {adding ? 'Adding…' : 'Add'}
          </button>
        </div>
      </section>

      <section className="rounded-xl border border-slate-200 bg-white">
        <header className="px-4 py-3 border-b border-slate-100">
          <h2 className="text-sm font-semibold text-slate-900">Domains</h2>
        </header>
        {!domains ? (
          <p className="px-4 py-3 text-xs text-slate-500">Loading…</p>
        ) : domains.length === 0 ? (
          <p className="px-4 py-3 text-xs text-slate-500">No domains yet. Add one above.</p>
        ) : (
          <ul className="divide-y divide-slate-100">
            {domains.map((d) => (
              <DomainRow
                key={d.id}
                domain={d}
                creds={creds}
                projectId={projectId}
                onChanged={() => void load()}
              />
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

function DomainRow({
  domain,
  creds,
  projectId,
  onChanged,
}: {
  domain: CustomDomain;
  creds: CfCredential[];
  projectId: string;
  onChanged: () => void;
}) {
  const [showSync, setShowSync] = useState(false);
  const [credId, setCredId] = useState<string>(domain.cloudflare_credential_id ?? creds[0]?.id ?? '');
  const [targetIp, setTargetIp] = useState<string>(domain.cloudflare_target_ip ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const synced = Boolean(domain.cloudflare_record_id);

  const sync = async () => {
    if (!credId || !targetIp.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await apiClient.post(`/integrations/cloudflare/projects/${projectId}/domains/${domain.id}/sync`, {
        credential_id: credId,
        target_ip: targetIp.trim(),
      });
      setShowSync(false);
      onChanged();
    } catch (e) {
      setError(extractDetail(e, 'Sync failed'));
    } finally {
      setBusy(false);
    }
  };

  const unsync = async () => {
    if (!confirm('Remove the Cloudflare A record for this domain?')) return;
    setBusy(true);
    setError(null);
    try {
      await apiClient.post(`/integrations/cloudflare/projects/${projectId}/domains/${domain.id}/unsync`);
      onChanged();
    } catch (e) {
      setError(extractDetail(e, 'Unsync failed'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <li className="px-4 py-3">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm font-medium text-slate-900">{domain.domain}</p>
          <p className="text-[11px] text-slate-500">
            {synced ? (
              <>
                ✓ Cloudflare DNS → <code className="font-mono">{domain.cloudflare_target_ip}</code>
                {domain.cloudflare_synced_at && <> · synced {new Date(domain.cloudflare_synced_at).toLocaleString()}</>}
              </>
            ) : (
              creds.length > 0 ? 'DNS not managed by WatchTower.' : 'Connect Cloudflare in Integrations to manage DNS automatically.'
            )}
          </p>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {creds.length > 0 && !showSync && !synced && (
            <button
              type="button"
              onClick={() => setShowSync(true)}
              className="text-[11px] px-2 py-1 rounded bg-orange-600 hover:bg-orange-700 text-white font-medium"
            >
              Sync to Cloudflare
            </button>
          )}
          {synced && (
            <button
              type="button"
              onClick={() => void unsync()}
              disabled={busy}
              className="text-[11px] text-red-600 hover:text-red-800 underline underline-offset-2 disabled:opacity-50"
            >
              Remove from CF
            </button>
          )}
        </div>
      </div>

      {showSync && (
        <div className="mt-3 rounded-md border border-orange-200 bg-orange-50 p-3 space-y-2">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            <label className="block text-[11px] text-slate-700">
              Cloudflare account
              <select
                value={credId}
                onChange={(e) => setCredId(e.target.value)}
                className="mt-1 w-full rounded border border-slate-300 bg-white px-2 py-1 text-xs"
              >
                {creds.map((c) => (
                  <option key={c.id} value={c.id}>{c.label || c.account_name || 'Cloudflare'}</option>
                ))}
              </select>
            </label>
            <label className="block text-[11px] text-slate-700">
              Target IP (A record)
              <input
                type="text"
                value={targetIp}
                onChange={(e) => setTargetIp(e.target.value)}
                placeholder="203.0.113.10"
                className="mt-1 w-full rounded border border-slate-300 bg-white px-2 py-1 text-xs font-mono"
              />
            </label>
          </div>
          {error && <p className="text-[11px] text-red-700">{error}</p>}
          <div className="flex gap-2 justify-end">
            <button
              type="button"
              onClick={() => { setShowSync(false); setError(null); }}
              className="text-[11px] px-2 py-1 rounded border border-slate-300 text-slate-700 hover:bg-slate-100"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={() => void sync()}
              disabled={busy || !credId || !targetIp.trim()}
              className="text-[11px] px-2 py-1 rounded bg-orange-600 hover:bg-orange-700 disabled:opacity-50 text-white font-medium"
            >
              {busy ? 'Syncing…' : 'Verify & sync'}
            </button>
          </div>
        </div>
      )}
    </li>
  );
}

// ── RunLocallyCard ─────────────────────────────────────────────────────────
// Spawns a Podman container on this machine after a build completes.
// Idempotent — Run Locally stops the prior container and starts a fresh
// build. Restart bounces the existing container without rebuilding.
// Static-site projects get nginx; Containerfile-based projects build + run
// their own image. Closes the "develop locally before paying for a server"
// loop.

type LocalRun = {
  project_id: string;
  project_name?: string;
  url: string;
  port: number;
  container_id: string;
  container_name?: string;
  image: string;
  serving_path: string | null;
  started_at?: string | null;
};

// Tiny human-readable elapsed-time formatter. We could pull date-fns but
// it's already not a dep here and this is one place — 8 lines wins.
function _uptimeLabel(startedAtIso?: string | null): string {
  if (!startedAtIso) return '';
  const t = Date.parse(startedAtIso);
  if (Number.isNaN(t)) return '';
  const sec = Math.max(0, Math.floor((Date.now() - t) / 1000));
  if (sec < 60) return `${sec}s`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m`;
  if (sec < 86400) return `${Math.floor(sec / 3600)}h ${Math.floor((sec % 3600) / 60)}m`;
  return `${Math.floor(sec / 86400)}d ${Math.floor((sec % 86400) / 3600)}h`;
}

function RunLocallyCard({ projectId }: { projectId: string }) {
  const [run, setRun] = useState<LocalRun | null>(null);
  const [busy, setBusy] = useState(false);
  const [busyAction, setBusyAction] = useState<'start' | 'restart' | 'stop' | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Logs panel state. Keeping it inside the card avoids prop-drilling
  // and lets the panel close on container stop without external wiring.
  const [logsOpen, setLogsOpen] = useState(false);
  const [logs, setLogs] = useState<string>('');
  const [logsLoading, setLogsLoading] = useState(false);
  const [autoFollow, setAutoFollow] = useState(true);

  // Tick the uptime label every 5s so a "running for 0s" doesn't sit
  // there frozen. Cheaper than polling /run-locally for the same info.
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!run) return;
    const id = setInterval(() => setTick((n) => n + 1), 5000);
    return () => clearInterval(id);
  }, [run]);

  const refresh = async () => {
    try {
      const r = await apiClient.get<LocalRun | null>(`/projects/${projectId}/run-locally`);
      setRun(r.data);
    } catch {
      setRun(null);
    }
  };

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { void refresh(); }, [projectId]);

  const start = async () => {
    setBusy(true);
    setBusyAction('start');
    setError(null);
    try {
      const r = await apiClient.post<LocalRun>(`/projects/${projectId}/run-locally`, {});
      setRun(r.data);
    } catch (e) {
      setError(extractDetail(e, 'Could not start local container'));
    } finally {
      setBusy(false);
      setBusyAction(null);
    }
  };

  const restart = async () => {
    setBusy(true);
    setBusyAction('restart');
    setError(null);
    try {
      const r = await apiClient.post<LocalRun>(`/projects/${projectId}/run-locally/restart`, {});
      setRun(r.data);
    } catch (e) {
      setError(extractDetail(e, 'Could not restart local container'));
    } finally {
      setBusy(false);
      setBusyAction(null);
    }
  };

  const stop = async () => {
    setBusy(true);
    setBusyAction('stop');
    setError(null);
    try {
      await apiClient.delete(`/projects/${projectId}/run-locally`);
      setRun(null);
      setLogsOpen(false);
      setLogs('');
    } catch (e) {
      setError(extractDetail(e, 'Could not stop container'));
    } finally {
      setBusy(false);
      setBusyAction(null);
    }
  };

  const fetchLogs = async () => {
    setLogsLoading(true);
    try {
      const r = await apiClient.get<{ logs: string }>(`/projects/${projectId}/run-locally/logs?tail=200`);
      setLogs(r.data.logs ?? '');
    } catch (e) {
      setLogs(`(failed to fetch logs: ${extractDetail(e, 'unknown error')})`);
    } finally {
      setLogsLoading(false);
    }
  };

  // Auto-refresh logs every 3s while panel open + follow on. Stops when
  // panel closes or follow toggles off — avoids hammering podman logs
  // when the user isn't looking.
  useEffect(() => {
    if (!run || !logsOpen) return;
    void fetchLogs();
    if (!autoFollow) return;
    const id = setInterval(() => void fetchLogs(), 3000);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [run, logsOpen, autoFollow, projectId]);

  return (
    <div className="rounded-xl border border-border bg-card overflow-hidden">
      <div className="px-5 py-4 border-b border-border bg-muted/30 flex items-center justify-between">
        <div>
          <h2 className="text-sm font-semibold">Run Locally</h2>
          <p className="text-[11px] text-muted-foreground mt-0.5">
            Spin up the latest build as a Podman container on this machine. Free, instant, no server needed.
            <br />
            <span className="text-[10.5px]">
              Requires <a href="https://podman.io/docs/installation" target="_blank" rel="noopener noreferrer" className="underline hover:text-slate-700">Podman</a> installed locally
              {' '}(<code className="font-mono">brew install podman</code> on macOS,
              {' '}<code className="font-mono">apt install podman</code> on Linux,
              {' '}<a href="https://podman.io/docs/installation#windows" target="_blank" rel="noopener noreferrer" className="underline hover:text-slate-700">winget install RedHat.Podman</a> on Windows).
            </span>
          </p>
        </div>
        {!run && (
          <button
            type="button"
            onClick={() => void start()}
            disabled={busy}
            className="px-3 py-1.5 rounded-md bg-emerald-600 hover:bg-emerald-700 disabled:opacity-50 text-white text-xs font-medium"
          >
            {busyAction === 'start' ? 'Starting…' : 'Run Locally'}
          </button>
        )}
      </div>
      <div className="px-5 py-4">
        {error && (
          <div className="rounded-lg border border-red-300 bg-red-50 p-3 mb-3 text-xs text-red-800">
            {error}
          </div>
        )}
        {run ? (
          <div className="space-y-3">
            <div className="flex items-center gap-3 flex-wrap">
              <span className="inline-flex items-center gap-1.5 text-xs px-2 py-1 rounded-full bg-emerald-100 text-emerald-800 border border-emerald-300">
                <span className="w-1.5 h-1.5 rounded-full bg-emerald-600 animate-pulse" />
                Running
              </span>
              <a
                href={run.url}
                target="_blank"
                rel="noopener noreferrer"
                className="text-sm font-mono text-blue-700 hover:underline"
              >
                {run.url} ↗
              </a>
              {run.started_at && (
                <span className="text-[11px] text-muted-foreground">
                  Up <span className="tabular-nums">{_uptimeLabel(run.started_at)}</span>
                </span>
              )}
            </div>
            <p className="text-[11px] text-muted-foreground">
              Image: <code className="font-mono">{run.image}</code> · Container: <code className="font-mono">{run.container_id.slice(0, 12)}</code>
              {run.serving_path && <> · Serving: <code className="font-mono">{run.serving_path}</code></>}
            </p>
            <div className="flex items-center gap-2 flex-wrap">
              <button
                type="button"
                onClick={() => void restart()}
                disabled={busy}
                title="Bounce the existing container without rebuilding the image (picks up env-var changes, recovers from crashes)"
                className="text-xs px-3 py-1.5 rounded-md border border-border hover:bg-muted disabled:opacity-50"
              >
                {busyAction === 'restart' ? 'Restarting…' : 'Restart'}
              </button>
              <button
                type="button"
                onClick={() => void start()}
                disabled={busy}
                title="Stop and rebuild from scratch (picks up new code from the latest deploy)"
                className="text-xs px-3 py-1.5 rounded-md border border-border hover:bg-muted disabled:opacity-50"
              >
                {busyAction === 'start' ? 'Rebuilding…' : 'Rebuild'}
              </button>
              <button
                type="button"
                onClick={() => setLogsOpen((v) => !v)}
                className="text-xs px-3 py-1.5 rounded-md border border-border hover:bg-muted"
              >
                {logsOpen ? 'Hide logs' : 'Show logs'}
              </button>
              <button
                type="button"
                onClick={() => void stop()}
                disabled={busy}
                className="text-xs px-3 py-1.5 rounded-md border border-red-300 text-red-700 hover:bg-red-50 disabled:opacity-50"
              >
                {busyAction === 'stop' ? 'Stopping…' : 'Stop'}
              </button>
            </div>

            {/* Logs panel — collapsible, polls every 3s while open + follow */}
            {logsOpen && (
              <div className="rounded-lg border border-slate-300 bg-slate-950 overflow-hidden">
                <div className="px-3 py-2 border-b border-slate-800 bg-slate-900 flex items-center justify-between">
                  <div className="flex items-center gap-3 text-[11px] text-slate-300">
                    <span className="font-medium">Container logs</span>
                    <span className="text-slate-500">last 200 lines</span>
                    {logsLoading && <span className="text-slate-500">refreshing…</span>}
                  </div>
                  <div className="flex items-center gap-3">
                    <label className="flex items-center gap-1.5 text-[11px] text-slate-300 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={autoFollow}
                        onChange={(e) => setAutoFollow(e.target.checked)}
                        className="accent-emerald-500"
                      />
                      Follow
                    </label>
                    <button
                      type="button"
                      onClick={() => void fetchLogs()}
                      className="text-[11px] text-slate-300 hover:text-white"
                    >
                      Refresh
                    </button>
                  </div>
                </div>
                <pre className="p-3 m-0 text-[11px] leading-snug text-slate-200 font-mono overflow-auto max-h-72 whitespace-pre-wrap break-words">
                  {logs || (logsLoading ? '' : '(no output yet — try refreshing or trigger some traffic)')}
                </pre>
              </div>
            )}
          </div>
        ) : (
          <p className="text-xs text-muted-foreground">
            Not running. Trigger a deploy first (the <strong>Deploy Now</strong> button up top), then come back here and click <strong>Run Locally</strong>. Static sites get served by nginx; Dockerfile-based projects build + run their own image.
          </p>
        )}
      </div>
    </div>
  );
}
