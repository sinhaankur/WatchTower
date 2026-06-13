import { useState } from 'react';
import { Link } from 'react-router-dom';
import apiClient from '@/lib/api';
import { toast } from '@/lib/toast';
import {
  usePodmanStatus,
  usePodmanContainers,
  usePodmanPods,
  useStartPodmanMachine,
  useCreatePodmanContainer,
  usePodmanContainerAction,
  useCreatePodmanPod,
  usePodmanPodAction,
  useProjects,
  type PodmanContainer,
  type PodmanPod,
  type PodmanPort,
} from '@/hooks/queries';

/**
 * Full local Podman manager: connection card (with one-click machine
 * start), every container on the machine (not just WatchTower-built
 * ones), create-container / create-pod wizards, and pod cards.
 * Containers/pods created here are labelled, and can be linked to a
 * WatchTower project at create time — the label renders as a badge
 * that deep-links to the project.
 */

function extractDetail(err: unknown, fallback: string): string {
  return (err as { response?: { data?: { detail?: string } } })?.response?.data?.detail ?? fallback;
}

const stateBadge = (state: string) => {
  const s = (state || '').toLowerCase();
  if (s.includes('running') || s === 'up') return 'text-emerald-700 bg-emerald-50 border-emerald-200';
  if (s.includes('paused')) return 'text-amber-700 bg-amber-50 border-amber-200';
  if (s.includes('exited') || s.includes('stopped') || s.includes('created')) return 'text-slate-600 bg-slate-100 border-slate-200';
  return 'text-slate-600 bg-slate-100 border-slate-200';
};

// ── Connection card ──────────────────────────────────────────────────────────

function ConnectionCard() {
  const { data: status, isLoading } = usePodmanStatus();
  const startMachine = useStartPodmanMachine();

  if (isLoading) {
    return <div className="rounded-xl border border-slate-200 bg-white p-4 text-xs text-slate-500">Checking Podman…</div>;
  }
  if (!status) return null;

  const dot = status.connected ? 'bg-emerald-500' : status.available ? 'bg-amber-500' : 'bg-red-500';

  return (
    <div className="rounded-xl border border-slate-200 bg-white p-4 flex items-center gap-4 flex-wrap">
      <span className={`w-2.5 h-2.5 rounded-full ${dot} shrink-0`} />
      <div className="flex-1 min-w-[220px]">
        <p className="text-sm font-medium text-slate-900">
          {status.connected
            ? `Podman connected — ${status.version ?? ''}`
            : status.available
              ? 'Podman installed but not running'
              : 'Podman not installed'}
        </p>
        {status.machine && (
          <p className="text-[11px] text-slate-500 mt-0.5">
            Machine <code className="font-mono">{status.machine.name}</code>{' '}
            {status.machine.running ? 'running' : 'stopped'}
            {status.machine.cpus ? ` · ${status.machine.cpus} CPUs` : ''}
          </p>
        )}
        {!status.connected && status.hint && (
          <p className="text-[11px] text-amber-700 mt-0.5">{status.hint}</p>
        )}
      </div>
      {status.available && !status.connected && status.machine && !status.machine.running && (
        <button
          onClick={() => {
            startMachine.mutate(undefined, {
              onSuccess: (s) => s.connected
                ? toast.success('Podman machine started')
                : toast.warning('Machine started but Podman is still not responding'),
              onError: (e) => toast.error(extractDetail(e, 'Could not start the Podman machine')),
            });
          }}
          disabled={startMachine.isPending}
          className="text-xs px-4 py-2 rounded-lg border border-slate-800 bg-amber-400 hover:bg-amber-500 text-slate-900 font-semibold shadow-[1px_1px_0_0_#1f2937] disabled:opacity-50"
        >
          {startMachine.isPending ? 'Starting… (can take a minute)' : 'Start Podman'}
        </button>
      )}
      {!status.available && (
        <a
          href="https://podman.io/docs/installation"
          target="_blank" rel="noopener noreferrer"
          className="text-xs px-3 py-2 rounded-lg border border-slate-300 text-slate-700 hover:border-slate-500"
        >
          Install Podman ↗
        </a>
      )}
    </div>
  );
}

// ── Port-mapping mini editor (shared by both wizards) ───────────────────────

function PortsEditor({ ports, onChange }: { ports: PodmanPort[]; onChange: (p: PodmanPort[]) => void }) {
  return (
    <div className="space-y-1.5">
      {ports.map((p, i) => (
        <div key={i} className="flex items-center gap-1.5">
          <input
            type="number" placeholder="host" value={p.host || ''}
            onChange={(e) => onChange(ports.map((x, j) => j === i ? { ...x, host: Number(e.target.value) } : x))}
            className="w-24 text-xs font-mono rounded border border-slate-300 px-2 py-1.5"
          />
          <span className="text-slate-400 text-xs">→</span>
          <input
            type="number" placeholder="container" value={p.container || ''}
            onChange={(e) => onChange(ports.map((x, j) => j === i ? { ...x, container: Number(e.target.value) } : x))}
            className="w-24 text-xs font-mono rounded border border-slate-300 px-2 py-1.5"
          />
          <button onClick={() => onChange(ports.filter((_, j) => j !== i))} className="text-slate-400 hover:text-red-600 text-sm px-1">×</button>
        </div>
      ))}
      <button onClick={() => onChange([...ports, { host: 0, container: 0 }])} className="text-[11px] text-blue-700 hover:underline">
        + Add port mapping
      </button>
    </div>
  );
}

function ProjectPicker({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const { data: projects } = useProjects();
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className="w-full text-xs rounded border border-slate-300 px-2 py-1.5 bg-white"
    >
      <option value="">No project link</option>
      {(projects ?? []).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
    </select>
  );
}

// ── Create-container wizard ──────────────────────────────────────────────────

function CreateContainerForm({ pods, onDone }: { pods: PodmanPod[]; onDone: () => void }) {
  const create = useCreatePodmanContainer();
  const [name, setName] = useState('');
  const [image, setImage] = useState('');
  const [ports, setPorts] = useState<PodmanPort[]>([]);
  const [envText, setEnvText] = useState('');
  const [pod, setPod] = useState('');
  const [projectId, setProjectId] = useState('');

  const submit = () => {
    const env: Record<string, string> = {};
    for (const line of envText.split('\n')) {
      const t = line.trim();
      if (!t) continue;
      const eq = t.indexOf('=');
      if (eq < 1) { toast.error(`Env line "${t}" must be KEY=value`); return; }
      env[t.slice(0, eq)] = t.slice(eq + 1);
    }
    create.mutate(
      {
        name: name.trim(),
        image: image.trim(),
        ports: pod ? [] : ports.filter((p) => p.host && p.container),
        env,
        pod: pod || undefined,
        project_id: projectId || undefined,
      },
      {
        onSuccess: () => { toast.success(`Container ${name} created`); onDone(); },
        onError: (e) => toast.error(extractDetail(e, 'Could not create container')),
      },
    );
  };

  return (
    <div className="rounded-xl border border-slate-300 bg-slate-50 p-4 space-y-3">
      <div className="grid sm:grid-cols-2 gap-3">
        <label className="block">
          <span className="text-[11px] text-slate-600">Name</span>
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="my-redis"
            className="mt-1 w-full text-xs font-mono rounded border border-slate-300 px-2 py-1.5" />
        </label>
        <label className="block">
          <span className="text-[11px] text-slate-600">Image</span>
          <input value={image} onChange={(e) => setImage(e.target.value)} placeholder="docker.io/library/redis:7"
            className="mt-1 w-full text-xs font-mono rounded border border-slate-300 px-2 py-1.5" />
        </label>
      </div>
      <div className="grid sm:grid-cols-2 gap-3">
        <div>
          <span className="text-[11px] text-slate-600">Run inside pod (optional)</span>
          <select value={pod} onChange={(e) => setPod(e.target.value)}
            className="mt-1 w-full text-xs rounded border border-slate-300 px-2 py-1.5 bg-white">
            <option value="">Standalone container</option>
            {pods.map((p) => <option key={p.name} value={p.name}>{p.name}</option>)}
          </select>
          {pod && <p className="text-[10px] text-slate-400 mt-1">Ports are managed by the pod.</p>}
        </div>
        <div>
          <span className="text-[11px] text-slate-600">Link to project (optional)</span>
          <div className="mt-1"><ProjectPicker value={projectId} onChange={setProjectId} /></div>
        </div>
      </div>
      {!pod && (
        <div>
          <span className="text-[11px] text-slate-600">Ports (host → container)</span>
          <div className="mt-1"><PortsEditor ports={ports} onChange={setPorts} /></div>
        </div>
      )}
      <label className="block">
        <span className="text-[11px] text-slate-600">Environment variables (one KEY=value per line)</span>
        <textarea value={envText} onChange={(e) => setEnvText(e.target.value)} rows={2} placeholder={'REDIS_PASSWORD=secret'}
          className="mt-1 w-full text-xs font-mono rounded border border-slate-300 px-2 py-1.5" />
      </label>
      <div className="flex gap-2 justify-end">
        <button onClick={onDone} className="text-xs px-3 py-1.5 rounded-lg border border-slate-300 text-slate-600 hover:border-slate-400">Cancel</button>
        <button
          onClick={submit}
          disabled={create.isPending || !name.trim() || !image.trim()}
          className="text-xs px-4 py-1.5 rounded-lg border border-slate-800 bg-amber-400 hover:bg-amber-500 text-slate-900 font-semibold shadow-[1px_1px_0_0_#1f2937] disabled:opacity-50"
        >
          {create.isPending ? 'Creating… (first pull can take a while)' : 'Create & start'}
        </button>
      </div>
    </div>
  );
}

// ── Create-pod wizard ────────────────────────────────────────────────────────

function CreatePodForm({ onDone }: { onDone: () => void }) {
  const create = useCreatePodmanPod();
  const [name, setName] = useState('');
  const [ports, setPorts] = useState<PodmanPort[]>([]);
  const [projectId, setProjectId] = useState('');

  return (
    <div className="rounded-xl border border-slate-300 bg-slate-50 p-4 space-y-3">
      <div className="grid sm:grid-cols-2 gap-3">
        <label className="block">
          <span className="text-[11px] text-slate-600">Pod name</span>
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="my-app"
            className="mt-1 w-full text-xs font-mono rounded border border-slate-300 px-2 py-1.5" />
        </label>
        <div>
          <span className="text-[11px] text-slate-600">Link to project (optional)</span>
          <div className="mt-1"><ProjectPicker value={projectId} onChange={setProjectId} /></div>
        </div>
      </div>
      <div>
        <span className="text-[11px] text-slate-600">Published ports (host → container) — shared by every container in the pod</span>
        <div className="mt-1"><PortsEditor ports={ports} onChange={setPorts} /></div>
      </div>
      <div className="flex gap-2 justify-end">
        <button onClick={onDone} className="text-xs px-3 py-1.5 rounded-lg border border-slate-300 text-slate-600 hover:border-slate-400">Cancel</button>
        <button
          onClick={() => create.mutate(
            { name: name.trim(), ports: ports.filter((p) => p.host && p.container), project_id: projectId || undefined },
            {
              onSuccess: () => { toast.success(`Pod ${name} created — add containers to it`); onDone(); },
              onError: (e) => toast.error(extractDetail(e, 'Could not create pod')),
            },
          )}
          disabled={create.isPending || !name.trim()}
          className="text-xs px-4 py-1.5 rounded-lg border border-slate-800 bg-amber-400 hover:bg-amber-500 text-slate-900 font-semibold shadow-[1px_1px_0_0_#1f2937] disabled:opacity-50"
        >
          {create.isPending ? 'Creating…' : 'Create pod'}
        </button>
      </div>
    </div>
  );
}

// ── Rows ─────────────────────────────────────────────────────────────────────

function ContainerRow({ c }: { c: PodmanContainer }) {
  const act = usePodmanContainerAction();
  const [logs, setLogs] = useState<string | null>(null);

  const run = (action: 'start' | 'stop' | 'restart' | 'remove') => {
    if (action === 'remove' && !window.confirm(`Remove container ${c.name}? This deletes it (volumes survive).`)) return;
    act.mutate({ name: c.name, action }, {
      onSuccess: () => toast.success(`${c.name}: ${action} ok`),
      onError: (e) => toast.error(extractDetail(e, `${action} failed`)),
    });
  };

  const showLogs = async () => {
    if (logs !== null) { setLogs(null); return; }
    try {
      const r = await apiClient.get<{ logs: string }>(`/podman/containers/${encodeURIComponent(c.name)}/logs`);
      setLogs(r.data.logs || '(no output)');
    } catch (e) {
      toast.error(extractDetail(e, 'Could not fetch logs'));
    }
  };

  const running = (c.state || '').toLowerCase().includes('running');

  return (
    <>
      <tr className="hover:bg-slate-50/50">
        <td className="px-4 py-2.5">
          <p className="font-mono text-xs text-slate-900">{c.name}</p>
          <div className="flex items-center gap-1.5 mt-0.5">
            {c.pod && <span className="text-[10px] text-purple-700 bg-purple-50 border border-purple-200 rounded px-1">pod: {c.pod}</span>}
            {c.project_id && (
              <Link to={`/projects/${c.project_id}`} className="text-[10px] text-blue-700 bg-blue-50 border border-blue-200 rounded px-1 hover:underline">
                {c.project_name || 'project'}
              </Link>
            )}
          </div>
        </td>
        <td className="px-4 py-2.5"><code className="text-[11px] text-slate-600 font-mono truncate inline-block max-w-[220px]" title={c.image}>{c.image}</code></td>
        <td className="px-4 py-2.5">
          <span className={`text-[10px] border rounded px-1.5 py-0.5 ${stateBadge(c.state)}`}>{c.status || c.state}</span>
        </td>
        <td className="px-4 py-2.5 text-[11px] font-mono text-slate-600">
          {c.ports.map((p) => `${p.host}→${p.container}`).join(', ') || '—'}
        </td>
        <td className="px-4 py-2.5 text-right whitespace-nowrap">
          <div className="inline-flex items-center gap-1">
            {running
              ? <>
                  <button onClick={() => run('restart')} disabled={act.isPending} className="text-[11px] px-2 py-1 rounded border border-slate-300 hover:bg-slate-100 disabled:opacity-50">Restart</button>
                  <button onClick={() => run('stop')} disabled={act.isPending} className="text-[11px] px-2 py-1 rounded border border-slate-300 hover:bg-slate-100 disabled:opacity-50">Stop</button>
                </>
              : <button onClick={() => run('start')} disabled={act.isPending} className="text-[11px] px-2 py-1 rounded border border-emerald-300 text-emerald-700 hover:bg-emerald-50 disabled:opacity-50">Start</button>}
            <button onClick={() => void showLogs()} className="text-[11px] px-2 py-1 rounded border border-slate-300 hover:bg-slate-100">Logs</button>
            <button onClick={() => run('remove')} disabled={act.isPending} className="text-[11px] px-2 py-1 rounded border border-red-300 text-red-700 hover:bg-red-50 disabled:opacity-50">Remove</button>
          </div>
        </td>
      </tr>
      {logs !== null && (
        <tr>
          <td colSpan={5} className="px-4 pb-3">
            <pre className="text-[10px] font-mono bg-slate-900 text-slate-100 rounded-lg p-3 max-h-64 overflow-auto whitespace-pre-wrap">{logs}</pre>
          </td>
        </tr>
      )}
    </>
  );
}

function PodCard({ p }: { p: PodmanPod }) {
  const act = usePodmanPodAction();
  const running = (p.status || '').toLowerCase().includes('running');

  const run = (action: 'start' | 'stop' | 'restart' | 'remove') => {
    if (action === 'remove' && !window.confirm(`Remove pod ${p.name} and all its containers?`)) return;
    act.mutate({ name: p.name, action }, {
      onSuccess: () => toast.success(`Pod ${p.name}: ${action} ok`),
      onError: (e) => toast.error(extractDetail(e, `${action} failed`)),
    });
  };

  return (
    <div className="rounded-xl border border-slate-200 bg-white p-4">
      <div className="flex items-center gap-2 flex-wrap">
        <p className="font-mono text-xs font-semibold text-slate-900">{p.name}</p>
        <span className={`text-[10px] border rounded px-1.5 py-0.5 ${stateBadge(p.status)}`}>{p.status}</span>
        {p.project_id && (
          <Link to={`/projects/${p.project_id}`} className="text-[10px] text-blue-700 bg-blue-50 border border-blue-200 rounded px-1 hover:underline">
            {p.project_name || 'project'}
          </Link>
        )}
        <div className="ml-auto inline-flex items-center gap-1">
          {running
            ? <button onClick={() => run('stop')} disabled={act.isPending} className="text-[11px] px-2 py-1 rounded border border-slate-300 hover:bg-slate-100 disabled:opacity-50">Stop</button>
            : <button onClick={() => run('start')} disabled={act.isPending} className="text-[11px] px-2 py-1 rounded border border-emerald-300 text-emerald-700 hover:bg-emerald-50 disabled:opacity-50">Start</button>}
          <button onClick={() => run('remove')} disabled={act.isPending} className="text-[11px] px-2 py-1 rounded border border-red-300 text-red-700 hover:bg-red-50 disabled:opacity-50">Remove</button>
        </div>
      </div>
      <p className="text-[11px] text-slate-500 mt-2">
        {p.containers.length === 0
          ? 'Empty pod — use "New container" above and pick this pod.'
          : p.containers.map((c) => c.names).join(', ')}
      </p>
    </div>
  );
}

// ── Top-level section ────────────────────────────────────────────────────────

export default function PodmanManager() {
  const { data: status } = usePodmanStatus();
  const connected = Boolean(status?.connected);
  const { data: containers } = usePodmanContainers(connected);
  const { data: pods } = usePodmanPods(connected);
  const [creating, setCreating] = useState<'container' | 'pod' | null>(null);

  return (
    <div className="space-y-4">
      <ConnectionCard />

      {connected && (
        <>
          <div className="flex items-center gap-2">
            <h2 className="text-sm font-semibold text-slate-900 flex-1">All containers & pods on this machine</h2>
            <button
              onClick={() => setCreating(creating === 'pod' ? null : 'pod')}
              className="text-xs px-3 py-1.5 rounded-lg border border-slate-300 text-slate-700 hover:border-slate-500"
            >
              New pod
            </button>
            <button
              onClick={() => setCreating(creating === 'container' ? null : 'container')}
              className="text-xs px-3 py-1.5 rounded-lg border border-slate-800 bg-amber-400 hover:bg-amber-500 text-slate-900 font-semibold shadow-[1px_1px_0_0_#1f2937]"
            >
              New container
            </button>
          </div>

          {creating === 'container' && <CreateContainerForm pods={pods ?? []} onDone={() => setCreating(null)} />}
          {creating === 'pod' && <CreatePodForm onDone={() => setCreating(null)} />}

          {(pods ?? []).length > 0 && (
            <div className="grid sm:grid-cols-2 gap-3">
              {(pods ?? []).map((p) => <PodCard key={p.id} p={p} />)}
            </div>
          )}

          <div className="rounded-xl border border-slate-200 bg-white overflow-hidden shadow-[2px_2px_0_0_#1f2937]">
            <table className="w-full text-sm">
              <thead className="bg-slate-50 border-b border-slate-200">
                <tr className="text-left">
                  <th className="px-4 py-2.5 text-[11px] font-semibold uppercase tracking-wider text-slate-500">Container</th>
                  <th className="px-4 py-2.5 text-[11px] font-semibold uppercase tracking-wider text-slate-500">Image</th>
                  <th className="px-4 py-2.5 text-[11px] font-semibold uppercase tracking-wider text-slate-500">State</th>
                  <th className="px-4 py-2.5 text-[11px] font-semibold uppercase tracking-wider text-slate-500">Ports</th>
                  <th className="px-4 py-2.5 text-right text-[11px] font-semibold uppercase tracking-wider text-slate-500">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {(containers ?? []).length === 0 ? (
                  <tr><td colSpan={5} className="px-4 py-6 text-center text-xs text-slate-500">
                    No containers yet — click <strong>New container</strong> to run your first one.
                  </td></tr>
                ) : (
                  (containers ?? []).map((c) => <ContainerRow key={c.id} c={c} />)
                )}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}
