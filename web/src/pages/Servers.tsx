import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import axios from 'axios';
import apiClient from '@/lib/api';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { StatusPill, nodeStatusTone } from '@/components/ui/status-pill';

type OrgNode = {
  id: string;
  name: string;
  host: string;
  user: string;
  port: number;
  remote_path: string;
  reload_command: string;
  is_primary: boolean;
  status: 'healthy' | 'unhealthy' | 'offline' | 'maintenance';
  cpu_usage?: number;
  memory_usage?: number;
  disk_usage?: number;
  last_health_check?: string;
};

const STATUS_META = {
  healthy:     { dot: 'bg-emerald-500', badge: 'bg-emerald-50 text-emerald-700 border-emerald-200', label: 'Healthy' },
  unhealthy:   { dot: 'bg-red-500',     badge: 'bg-red-50 text-red-700 border-red-200',             label: 'Unhealthy' },
  offline:     { dot: 'bg-slate-500',   badge: 'bg-slate-100 text-slate-700 border-slate-200',       label: 'Offline' },
  maintenance: { dot: 'bg-amber-500',   badge: 'bg-amber-50 text-amber-700 border-amber-200',       label: 'Maintenance' },
};

function UsageBar({ label, value }: { label: string; value?: number }) {
  const pct = value ?? 0;
  const color = pct > 80 ? 'bg-red-400' : pct > 60 ? 'bg-amber-400' : 'bg-emerald-400';
  return (
    <div>
      <div className="flex justify-between text-xs text-slate-600 mb-1">
        <span>{label}</span>
        <span>{value != null ? `${pct}%` : '—'}</span>
      </div>
      <div className="h-1.5 bg-muted rounded-full overflow-hidden">
        <div className={`h-full rounded-full transition-all ${color}`} style={{ width: value != null ? `${Math.min(pct, 100)}%` : '0%' }} />
      </div>
    </div>
  );
}

const STEP_LABELS = ['Basic Info', 'SSH Access', 'Deployment'];

const Servers = () => {
  const [orgId, setOrgId]           = useState('');
  const [orgName, setOrgName]       = useState('');
  const [nodes, setNodes]           = useState<OrgNode[]>([]);
  const [loading, setLoading]       = useState(false);
  const [pageError, setPageError]   = useState('');
  const [actionMsg, setActionMsg]   = useState<{ kind: 'success' | 'error'; text: string } | null>(null);
  const [healthLoading, setHealthL] = useState<string | null>(null);
  const [step, setStep]             = useState(0);
  const [addingNode, setAddingNode] = useState(false);
  const [offlineMode, setOffline]   = useState(false);
  const [showForm, setShowForm]     = useState(false);
  const [search, setSearch]         = useState('');
  const [filterStatus, setFilter]   = useState<string>('all');

  const [form, setFormData] = useState({
    name: '', host: '', user: 'deploy', port: 22,
    remote_path: '/opt/apps/watchtower', ssh_key_path: '~/.ssh/id_rsa',
    reload_command: 'sudo systemctl reload caddy', is_primary: true,
    max_concurrent_deployments: 1,
  });

  const setField = (k: string, v: string | number | boolean) => setFormData((p) => ({ ...p, [k]: v }));

  const showMsg = (kind: 'success' | 'error', text: string) => {
    setActionMsg({ kind, text });
    window.setTimeout(() => setActionMsg((c) => (c?.text === text ? null : c)), 4000);
  };

  const refreshNodes = async (oid: string) => {
    try {
      const r = await apiClient.get(`/orgs/${oid}/nodes`);
      setNodes(r.data as OrgNode[]);
    } catch { /* non-fatal */ }
  };

  const loadContext = async () => {
    setLoading(true);
    setPageError('');
    setOffline(false);
    try {
      const r = await apiClient.get('/context');
      const ctx = r.data as { organization: { id: string; name: string } };
      setOrgId(ctx.organization.id);
      setOrgName(ctx.organization.name);
      await refreshNodes(ctx.organization.id);
    } catch (err) {
      setOffline(true);
      if (axios.isAxiosError(err)) {
        const s = err.response?.status;
        if (s === 401) setPageError('Authentication failed. Check your API token.');
        else if (s === 503) setPageError('Server not configured. Set WATCHTOWER_API_TOKEN.');
        else setPageError('Could not connect to the server. Displaying offline view.');
      } else {
        setPageError('Could not connect. You can still browse the form below.');
      }
    } finally { setLoading(false); }
  };

  useEffect(() => {
    void loadContext();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const addNode = async () => {
    if (!orgId || !form.name || !form.host) return;
    setAddingNode(true);
    try {
      await apiClient.post(`/orgs/${orgId}/nodes`, form);
      setFormData({ name: '', host: '', user: 'deploy', port: 22, remote_path: '/opt/apps/watchtower', ssh_key_path: '~/.ssh/id_rsa', reload_command: 'sudo systemctl reload caddy', is_primary: true, max_concurrent_deployments: 1 });
      setStep(0);
      setShowForm(false);
      showMsg('success', 'Server added successfully!');
      await refreshNodes(orgId);
    } catch (err: unknown) {
      const detail =
        (err as { response?: { data?: { detail?: string } } })?.response?.data?.detail;
      showMsg('error', detail ?? 'Failed to add server. Check the connection details and try again.');
    }
    finally { setAddingNode(false); }
  };

  const checkHealth = async (nodeId: string) => {
    setHealthL(nodeId);
    try {
      await apiClient.get(`/org-nodes/${nodeId}/health`);
      await refreshNodes(orgId);
      showMsg('success', 'Health check completed.');
    } catch { showMsg('error', 'Health check failed. Ensure the node is reachable.'); }
    finally { setHealthL(null); }
  };

  const [deleteLoading, setDeleteL] = useState<string | null>(null);

  const deleteNode = async (nodeId: string) => {
    if (!window.confirm('Remove this server from your organization?')) return;
    setDeleteL(nodeId);
    try {
      await apiClient.delete(`/org-nodes/${nodeId}`);
      setNodes((prev) => prev.filter((n) => n.id !== nodeId));
      showMsg('success', 'Server removed.');
    } catch { showMsg('error', 'Failed to remove server.'); }
    finally { setDeleteL(null); }
  };

  const filteredNodes = nodes.filter((n) => {
    const q = search.toLowerCase();
    const matchSearch = !q || n.name.toLowerCase().includes(q) || n.host.toLowerCase().includes(q) || n.user.toLowerCase().includes(q);
    const matchStatus = filterStatus === 'all' || n.status === filterStatus;
    return matchSearch && matchStatus;
  });

  const healthCounts = nodes.reduce<Record<string, number>>(
    (acc, n) => { acc[n.status] = (acc[n.status] ?? 0) + 1; return acc; },
    {}
  );

  const isStepValid = (s: number) => {
    if (s === 0) return form.name.trim().length > 0 && form.host.trim().length > 0;
    return true;
  };

  return (
    <div className="flex-1 overflow-auto bg-slate-50">
      <header
        className="px-4 sm:px-6 lg:px-8 py-4 flex items-center justify-between border-b sticky top-0 z-10 backdrop-blur-sm"
        style={{ borderColor: 'hsl(214 32% 88%)', background: 'rgba(248, 251, 255, 0.9)' }}
      >
        <div>
          <h1 className="text-lg font-semibold text-slate-900">Servers</h1>
          <p className="text-xs text-slate-600 mt-0.5">
            {loading ? 'Loading…' : orgName ? `Organization: ${orgName}` : offlineMode ? 'Offline — some features unavailable' : 'Manage deployment servers'}
          </p>
        </div>
        <div className="flex items-center gap-3">
          {offlineMode && (
            <button onClick={() => void loadContext()}
              className="px-3 py-1.5 rounded-lg border border-border text-xs text-slate-700 hover:bg-slate-100 transition-colors">
              ↺ Retry
            </button>
          )}
          <button
            onClick={() => setShowForm((v) => !v)}
            className="px-4 py-1.5 rounded-lg bg-red-700 hover:bg-red-800 text-white text-sm font-medium transition-colors border border-slate-800 shadow-[2px_2px_0_0_#1f2937]"
          >
            {showForm ? 'Cancel' : '+ Add Server'}
          </button>
        </div>
      </header>

      <main className="px-4 sm:px-6 lg:px-8 py-6 space-y-6 max-w-5xl mx-auto w-full">
        {/* Notices */}
        {pageError && (
          <div className="flex items-start gap-3 rounded-xl border border-amber-300 bg-amber-50 px-4 py-3">
            <span className="text-amber-600 mt-0.5">⚠</span>
            <p className="text-sm text-amber-700">{pageError}</p>
          </div>
        )}
        {actionMsg && (
          <div className={`rounded-xl border px-4 py-3 text-sm ${
            actionMsg.kind === 'success'
              ? 'border-emerald-300 bg-emerald-50 text-emerald-700'
              : 'border-red-300 bg-red-50 text-red-700'
          }`}>
            {actionMsg.text}
          </div>
        )}

        {/* Add server form */}
        {showForm && (
          <div className="rounded-xl border border-border bg-card p-6 space-y-6">
            <div>
              <h2 className="text-sm font-semibold text-slate-900">Add a Server</h2>
              <p className="text-xs text-slate-600 mt-1">Connect a new server via SSH to use as a deployment target.</p>
            </div>

            {/* Step indicator */}
            <div className="flex items-center gap-0">
              {STEP_LABELS.map((label, i) => (
                <div key={i} className="flex items-center flex-1 last:flex-none">
                  <button
                    type="button"
                    onClick={() => i < step && setStep(i)}
                    className={`flex items-center gap-2 text-sm font-medium transition-colors ${
                      i === step ? 'text-slate-900' : i < step ? 'text-slate-600 cursor-pointer hover:text-red-800' : 'text-slate-400 cursor-default'
                    }`}
                  >
                    <span className={`w-6 h-6 rounded-full flex items-center justify-center text-xs border ${
                      i < step ? 'bg-red-700 border-red-700 text-white' :
                      i === step ? 'border-red-700 text-red-700 bg-red-50' :
                      'border-border text-slate-500'
                    }`}>
                      {i < step ? '✓' : i + 1}
                    </span>
                    {label}
                  </button>
                  {i < STEP_LABELS.length - 1 && (
                    <div className={`flex-1 h-px mx-3 ${i < step ? 'bg-red-700' : 'bg-border'}`} />
                  )}
                </div>
              ))}
            </div>

            {/* Step 0: Basic Info */}
            {step === 0 && (
              <div className="space-y-4">
                <div className="grid sm:grid-cols-2 gap-4">
                  <div>
                    <Label htmlFor="s-name" className="text-slate-700 text-xs">Server Name <span className="text-red-500">*</span></Label>
                    <Input id="s-name" placeholder="e.g. web-server-1" value={form.name}
                      onChange={(e) => setField('name', e.target.value)}
                      className="mt-1.5 bg-white border-border text-slate-900 placeholder:text-slate-500" />
                  </div>
                  <div>
                    <Label htmlFor="s-host" className="text-slate-700 text-xs">Host / IP <span className="text-red-500">*</span></Label>
                    <Input id="s-host" placeholder="192.168.1.101" value={form.host}
                      onChange={(e) => setField('host', e.target.value)}
                      className="mt-1.5 bg-white border-border text-slate-900 placeholder:text-slate-500" />
                  </div>
                </div>
                <label className="flex items-center gap-2 text-sm text-slate-700 cursor-pointer">
                  <input type="checkbox" checked={form.is_primary}
                    onChange={(e) => setField('is_primary', e.target.checked)}
                    className="accent-red-700 cursor-pointer" />
                  Mark as <strong className="text-slate-900">primary</strong> deployment server
                </label>
              </div>
            )}

            {/* Step 1: SSH Access */}
            {step === 1 && (
              <div className="space-y-4">
                <div className="grid sm:grid-cols-3 gap-4">
                  <div>
                    <Label htmlFor="s-user" className="text-slate-700 text-xs">SSH User</Label>
                    <Input id="s-user" value={form.user} onChange={(e) => setField('user', e.target.value)}
                      className="mt-1.5 bg-white border-border text-slate-900" />
                  </div>
                  <div>
                    <Label htmlFor="s-port" className="text-slate-700 text-xs">Port</Label>
                    <Input id="s-port" type="number" value={form.port} onChange={(e) => setField('port', Number(e.target.value))}
                      className="mt-1.5 bg-white border-border text-slate-900" />
                  </div>
                  <div>
                    <Label htmlFor="s-key" className="text-slate-700 text-xs">SSH Key Path</Label>
                    <Input id="s-key" value={form.ssh_key_path} onChange={(e) => setField('ssh_key_path', e.target.value)}
                      className="mt-1.5 bg-white border-border text-slate-900" />
                  </div>
                </div>
              </div>
            )}

            {/* Step 2: Deployment Config */}
            {step === 2 && (
              <div className="space-y-4">
                <div>
                  <Label htmlFor="s-path" className="text-slate-700 text-xs">Remote Deploy Path</Label>
                  <Input id="s-path" value={form.remote_path} onChange={(e) => setField('remote_path', e.target.value)}
                    className="mt-1.5 bg-white border-border text-slate-900" />
                </div>
                <div>
                  <Label htmlFor="s-reload" className="text-slate-700 text-xs">Reload Command</Label>
                  <Input id="s-reload" value={form.reload_command} onChange={(e) => setField('reload_command', e.target.value)}
                    className="mt-1.5 bg-white border-border text-slate-900" />
                </div>
              </div>
            )}

            {/* Form navigation */}
            <div className="flex justify-between pt-2">
              <button
                onClick={() => step > 0 && setStep((s) => s - 1)}
                disabled={step === 0}
                className="px-4 py-2 text-sm font-semibold text-slate-800 border border-slate-800 bg-white rounded-lg shadow-[2px_2px_0_0_#1f2937] hover:bg-amber-50 transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
              >
                ← Back
              </button>
              {step < STEP_LABELS.length - 1 ? (
                <button
                  onClick={() => setStep((s) => s + 1)}
                  disabled={!isStepValid(step)}
                  className="px-4 py-2 text-sm font-semibold bg-red-700 hover:bg-red-800 text-white rounded-lg border border-slate-800 shadow-[2px_2px_0_0_#1f2937] transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  Continue →
                </button>
              ) : (
                <button
                  onClick={() => void addNode()}
                  disabled={addingNode || !orgId}
                  className="px-6 py-2 text-sm font-semibold bg-red-700 hover:bg-red-800 text-white rounded-lg border border-slate-800 shadow-[2px_2px_0_0_#1f2937] transition-colors disabled:opacity-40"
                >
                  {addingNode ? 'Adding…' : 'Add Server'}
                </button>
              )}
            </div>
          </div>
        )}

        {/* Use This PC shortcut */}
        <Link
          to="/servers/local"
          className="flex items-center gap-4 rounded-xl border border-blue-200 bg-blue-50 hover:border-blue-400 hover:bg-blue-100 px-5 py-4 transition-colors group"
        >
          <div className="w-10 h-10 rounded-xl bg-white border border-blue-200 flex items-center justify-center text-xl shrink-0">💻</div>
          <div className="flex-1 min-w-0">
            <p className="text-sm font-semibold text-blue-900">Use this PC as a server</p>
            <p className="text-xs text-blue-700 mt-0.5">Register your current machine as a local deployment node — no SSH setup needed.</p>
          </div>
          <span className="text-blue-400 group-hover:text-blue-600 text-lg transition-colors">→</span>
        </Link>

        {/* Server list */}
        <div className="rounded-xl border border-border bg-card p-5">
          {/* Header row: count + health summary + search/filter */}
          <div className="flex flex-col sm:flex-row sm:items-center gap-3 mb-4">
            <h2 className="text-sm font-semibold text-slate-900 shrink-0">
              {loading ? 'Loading servers…' : `${nodes.length} Server${nodes.length !== 1 ? 's' : ''}`}
            </h2>

            {/* Health summary pills */}
            {!loading && nodes.length > 0 && (
              <div className="flex items-center gap-1.5 flex-wrap">
                {(Object.entries(healthCounts) as [string, number][]).map(([st, cnt]) => {
                  const m = STATUS_META[st as keyof typeof STATUS_META] ?? STATUS_META.offline;
                  return (
                    <button
                      key={st}
                      onClick={() => setFilter((f) => f === st ? 'all' : st)}
                      className={`text-[11px] px-2 py-0.5 rounded-full border font-medium transition-colors ${
                        filterStatus === st ? m.badge + ' ring-1 ring-offset-1 ring-current' : m.badge
                      }`}
                    >
                      {cnt} {m.label}
                    </button>
                  );
                })}
                {filterStatus !== 'all' && (
                  <button
                    onClick={() => setFilter('all')}
                    className="text-[11px] text-slate-500 hover:text-slate-700 transition-colors"
                  >
                    ✕ clear
                  </button>
                )}
              </div>
            )}

            {/* Search input */}
            {nodes.length > 0 && (
              <div className="sm:ml-auto relative">
                <input
                  type="search"
                  placeholder="Search servers…"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  className="w-full sm:w-52 pl-7 pr-3 py-1.5 text-xs rounded-lg border border-border bg-white text-slate-800 placeholder:text-slate-400 focus:outline-none focus:ring-1 focus:ring-red-400"
                />
                <span className="absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400 text-xs pointer-events-none">🔍</span>
              </div>
            )}
          </div>

          {nodes.length === 0 && !loading && (
            <div className="text-center py-14 border border-dashed border-border rounded-xl">
              <div className="w-12 h-12 rounded-xl bg-red-50 border border-red-200 flex items-center justify-center mx-auto mb-3">
                <span className="text-xl">🖥</span>
              </div>
              <p className="text-sm font-medium text-slate-900">No servers yet</p>
              <p className="text-xs text-slate-600 mt-1 mb-4">Add your first server to start deploying applications.</p>
              <div className="flex items-center justify-center gap-3">
                <button
                  onClick={() => setShowForm(true)}
                  className="inline-flex items-center gap-2 px-4 py-2 rounded-lg border border-border text-slate-700 hover:bg-slate-100 text-sm transition-colors"
                >
                  + Add Remote Server
                </button>
                <Link
                  to="/servers/local"
                  className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-red-700 hover:bg-red-800 text-white text-sm transition-colors border border-slate-800 shadow-[2px_2px_0_0_#1f2937]"
                >
                  💻 Use This PC
                </Link>
              </div>
            </div>
          )}

          {nodes.length > 0 && filteredNodes.length === 0 && (
            <div className="text-center py-10 text-xs text-slate-500">
              No servers match your search.
              <button onClick={() => { setSearch(''); setFilter('all'); }} className="ml-2 text-red-700 hover:underline">Clear filters</button>
            </div>
          )}

          <div className="space-y-3">
            {filteredNodes.map((node) => {
              const meta = STATUS_META[node.status] ?? STATUS_META.offline;
              return (
                <div key={node.id}
                  className="p-4 rounded-xl border border-border hover:border-red-300 bg-muted/20 hover:bg-red-50/40 transition-all">
                  <div className="flex items-start justify-between gap-4">
                    <div className="flex items-center gap-3 min-w-0 flex-1">
                      <span className={`w-2.5 h-2.5 rounded-full shrink-0 mt-1 ${meta.dot} ${node.status === 'healthy' ? 'status-pulse' : ''}`} />
                      <div className="min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          <p className="text-sm font-semibold text-slate-900 truncate" title={node.name}>{node.name}</p>
                          {node.is_primary && (
                            <span className="text-xs px-1.5 py-0.5 rounded border border-red-200 bg-red-50 text-red-700 shrink-0">Primary</span>
                          )}
                        </div>
                        <p className="text-xs text-slate-600 mt-0.5 font-mono truncate" title={`${node.user}@${node.host}:${node.port}`}>{node.user}@{node.host}:{node.port}</p>
                        {node.last_health_check && (
                          <p className="text-xs text-slate-600 mt-0.5">
                            Last check: {new Date(node.last_health_check).toLocaleString()}
                          </p>
                        )}
                      </div>
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      <StatusPill tone={nodeStatusTone(node.status)} label={meta.label} />
                      <button
                        onClick={() => void checkHealth(node.id)}
                        disabled={healthLoading === node.id}
                        className="px-3 py-1 text-xs rounded-lg border border-border text-slate-700 hover:bg-slate-100 hover:text-slate-900 transition-colors disabled:opacity-50"
                      >
                        {healthLoading === node.id ? 'Checking…' : 'Check Health'}
                      </button>
                      <button
                        onClick={() => void deleteNode(node.id)}
                        disabled={deleteLoading === node.id}
                        className="px-3 py-1 text-xs rounded-lg border border-red-200 text-red-600 hover:bg-red-50 hover:text-red-700 transition-colors disabled:opacity-50"
                        title="Remove server"
                      >
                        {deleteLoading === node.id ? '…' : '✕'}
                      </button>
                    </div>
                  </div>

                  {(node.cpu_usage != null || node.memory_usage != null || node.disk_usage != null) && (
                    <div className="grid grid-cols-3 gap-4 mt-4 pt-4 border-t border-border">
                      <UsageBar label="CPU" value={node.cpu_usage} />
                      <UsageBar label="Memory" value={node.memory_usage} />
                      <UsageBar label="Disk" value={node.disk_usage} />
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      </main>
    </div>
  );
};

export default Servers;
