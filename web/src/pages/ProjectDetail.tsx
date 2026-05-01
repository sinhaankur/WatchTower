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

const TABS = ['Overview', 'Deployments', 'Build Logs', 'Env Vars', 'Webhooks', 'Related'] as const;
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

// ── DeploymentsTab ────────────────────────────────────────────────────────────

type Diagnosis = {
  kind: 'port_in_use' | 'missing_env_var' | 'package_not_found' | 'build_oom' | 'permission_denied' | 'disk_full' | 'unknown';
  cause: string;
  fix: { description: string; command: string | null; auto_applicable: boolean };
  matched_text: string | null;
  extracted: Record<string, string>;
  deployment_id: string;
  deployment_status: string | null;
  build_id: string | null;
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
            const diag = diagnoses[d.id];
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
                    {isFailed && (
                      <button
                        onClick={() => void runDiagnose(d.id)}
                        className="text-[11px] px-2 py-1 rounded border border-slate-300 hover:border-slate-500 text-slate-600 hover:text-slate-900 transition-colors"
                      >
                        {diag ? 'Hide' : 'Diagnose'}
                      </button>
                    )}
                  </td>
                </tr>
                {diag && (
                  <tr>
                    <td colSpan={7} className="px-4 py-3 bg-slate-50">
                      <DiagnosisPanel state={diag} />
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
  unknown: 'Unrecognized failure pattern',
};

function DiagnosisPanel({ state }: { state: { state: 'loading' | 'ready' | 'error'; data?: Diagnosis; error?: string } }) {
  if (state.state === 'loading') {
    return <p className="text-xs text-slate-600">Diagnosing failed deployment…</p>;
  }
  if (state.state === 'error') {
    return <p className="text-xs text-red-600">{state.error}</p>;
  }
  const d = state.data!;
  const isUnknown = d.kind === 'unknown';
  return (
    <div className="space-y-2">
      {/* The "Auto-fixable" badge intentionally isn't rendered yet — the
          /auto-fix endpoint that would back an "Apply fix" button is
          v2 work. Showing the badge without the action is a UX lie.
          When the action lands, render it next to KIND_LABEL gated on
          d.fix.auto_applicable. */}
      <div className="flex items-center gap-2">
        <span className={`text-[10px] px-2 py-0.5 rounded-full border font-medium ${
          isUnknown
            ? 'border-slate-300 bg-slate-100 text-slate-700'
            : 'border-amber-300 bg-amber-50 text-amber-800'
        }`}>
          {KIND_LABEL[d.kind]}
        </span>
      </div>

      <p className="text-xs text-slate-800">{d.cause}</p>

      <div className="rounded border border-border bg-white p-3 space-y-1">
        <p className="text-[10px] font-semibold uppercase tracking-wide text-slate-500">Suggested fix</p>
        <p className="text-xs text-slate-800">{d.fix.description}</p>
        {d.fix.command && (
          <code className="block text-[11px] font-mono bg-slate-100 rounded px-2 py-1 text-slate-700 mt-1">
            {d.fix.command}
          </code>
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
        <p className="text-[11px] text-slate-500">
          No automatic pattern matched this failure. Open the Build Logs tab to investigate manually.
        </p>
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
