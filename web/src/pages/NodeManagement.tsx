import { useEffect, useState } from 'react';
import axios from 'axios';
import apiClient from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

type ContextResponse = {
  organization: {
    id: string;
    name: string;
  };
};

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

const STEP_LABELS = ['Basic Info', 'SSH Access', 'Deployment Config'];

const STATUS_STYLES: Record<string, { dot: string; badge: string; label: string }> = {
  healthy: { dot: 'bg-green-500', badge: 'bg-green-50 text-green-700 border-green-200', label: 'Healthy' },
  unhealthy: { dot: 'bg-red-400', badge: 'bg-red-50 text-red-700 border-red-200', label: 'Unhealthy' },
  offline: { dot: 'bg-gray-400', badge: 'bg-gray-50 text-gray-600 border-gray-200', label: 'Offline' },
  maintenance: { dot: 'bg-yellow-400', badge: 'bg-yellow-50 text-yellow-700 border-yellow-200', label: 'Maintenance' },
};

function UsageBar({ value, label, color }: { value?: number; label: string; color: string }) {
  const pct = value ?? 0;
  return (
    <div className="flex-1 min-w-0">
      <div className="flex justify-between text-xs text-gray-500 mb-1">
        <span>{label}</span>
        <span>{value != null ? `${pct}%` : '—'}</span>
      </div>
      <div className="h-1.5 bg-gray-100 rounded-full overflow-hidden">
        <div
          className={`h-full rounded-full transition-all ${color}`}
          style={{ width: value != null ? `${Math.min(pct, 100)}%` : '0%' }}
        />
      </div>
    </div>
  );
}

const NodeManagement = () => {
  const [orgId, setOrgId] = useState<string>('');
  const [orgName, setOrgName] = useState<string>('');
  const [nodes, setNodes] = useState<OrgNode[]>([]);
  const [loading, setLoading] = useState(false);
  const [pageError, setPageError] = useState('');
  const [actionError, setActionError] = useState('');
  const [actionSuccess, setActionSuccess] = useState('');
  const [healthLoading, setHealthLoading] = useState<string | null>(null);
  const [step, setStep] = useState(0);
  const [addingNode, setAddingNode] = useState(false);
  const [offlineMode, setOfflineMode] = useState(false);

  const [form, setForm] = useState({
    name: '',
    host: '',
    user: 'deploy',
    port: 22,
    remote_path: '/opt/apps/watchtower',
    ssh_key_path: '~/.ssh/id_rsa',
    reload_command: 'sudo systemctl reload caddy',
    is_primary: true,
    max_concurrent_deployments: 1,
  });

  const refreshNodes = async (currentOrgId: string) => {
    try {
      const nodesResp = await apiClient.get(`/orgs/${currentOrgId}/nodes`);
      setNodes(nodesResp.data as OrgNode[]);
    } catch {
      // nodes list failure is non-fatal; keep existing list
    }
  };

  const loadContext = async () => {
    setLoading(true);
    setPageError('');
    setOfflineMode(false);
    try {
      const ctxResp = await apiClient.get('/context');
      const ctx = ctxResp.data as ContextResponse;
      setOrgId(ctx.organization.id);
      setOrgName(ctx.organization.name);
      await refreshNodes(ctx.organization.id);
    } catch (error) {
      setOfflineMode(true);
      if (axios.isAxiosError(error)) {
        const status = error.response?.status;
        if (status === 401) {
          setPageError('Authentication failed. Set VITE_API_TOKEN (or localStorage authToken) and ensure it matches WATCHTOWER_API_TOKEN on the server.');
        } else if (status === 503) {
          setPageError('Server authentication is not configured yet. Set WATCHTOWER_API_TOKEN, or enable WATCHTOWER_ALLOW_INSECURE_DEV_AUTH=true for local development.');
        } else {
          setPageError('Could not connect to the WatchTower server. You can still review the form below and add nodes once the server is reachable.');
        }
      } else {
        setPageError('Could not connect to the WatchTower server. You can still review the form below and add nodes once the server is reachable.');
      }
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadContext();
  }, []);

  const setField = (key: string, value: string | number | boolean) => {
    setForm((prev) => ({ ...prev, [key]: value }));
  };

  const isStepValid = (s: number) => {
    if (s === 0) return form.name.trim().length > 0 && form.host.trim().length > 0;
    return true;
  };

  const addNode = async () => {
    if (!orgId || !form.name || !form.host) return;
    setAddingNode(true);
    setActionError('');
    setActionSuccess('');
    try {
      await apiClient.post(`/orgs/${orgId}/nodes`, form);
      setForm({
        name: '',
        host: '',
        user: 'deploy',
        port: 22,
        remote_path: '/opt/apps/watchtower',
        ssh_key_path: '~/.ssh/id_rsa',
        reload_command: 'sudo systemctl reload caddy',
        is_primary: true,
        max_concurrent_deployments: 1,
      });
      setStep(0);
      setActionSuccess('Node added successfully!');
      await refreshNodes(orgId);
    } catch {
      setActionError('Failed to add node. Check the server connection and try again.');
    } finally {
      setAddingNode(false);
    }
  };

  const checkHealth = async (nodeId: string) => {
    setHealthLoading(nodeId);
    setActionError('');
    setActionSuccess('');
    try {
      await apiClient.get(`/org-nodes/${nodeId}/health`);
      await refreshNodes(orgId);
      setActionSuccess('Health check completed.');
    } catch {
      setActionError('SSH health check failed. Ensure the node is reachable and SSH credentials are correct.');
    } finally {
      setHealthLoading(null);
    }
  };

  return (
    <div className="flex-1 overflow-auto bg-gray-50">
      <header className="bg-white border-b border-gray-100">
        <div className="px-8 py-5 flex items-center justify-between">
          <div>
            <h1 className="text-base font-semibold text-gray-900">Nodes</h1>
            <p className="text-xs text-gray-400 mt-0.5">
              {loading ? 'Loading…' : orgName ? `Organization: ${orgName}` : offlineMode ? 'Server offline — some features unavailable' : 'Manage deployment nodes'}
            </p>
          </div>
          {offlineMode && (
            <Button
              variant="outline"
              onClick={() => void loadContext()}
              className="rounded-none border-gray-300 text-sm"
            >
              ↺ Retry Connection
            </Button>
          )}
        </div>
      </header>

      <main className="px-8 py-6 space-y-6 max-w-4xl">

        {/* Page-level notice */}
        {pageError && (
          <div className="flex items-start gap-3 rounded-none border border-amber-200 bg-amber-50 px-4 py-3">
            <span className="text-amber-500 mt-0.5">⚠</span>
            <div>
              <p className="text-sm font-medium text-amber-800">Connection issue</p>
              <p className="text-sm text-amber-700 mt-0.5">{pageError}</p>
            </div>
          </div>
        )}

        {/* Action feedback */}
        {actionSuccess && (
          <div className="flex items-center gap-2 rounded-none border border-green-200 bg-green-50 px-4 py-3">
            <span className="text-green-500">✓</span>
            <p className="text-sm text-green-700">{actionSuccess}</p>
          </div>
        )}
        {actionError && (
          <div className="flex items-start gap-2 rounded-none border border-red-200 bg-red-50 px-4 py-3">
            <span className="text-red-500 mt-0.5">✗</span>
            <p className="text-sm text-red-700">{actionError}</p>
          </div>
        )}

        {/* Add Node — Step-by-step form */}
        <Card className="rounded-none border-gray-200 shadow-none bg-white">
          <CardHeader className="pb-4">
            <CardTitle className="text-base">Add a Deployment Node</CardTitle>
            <CardDescription>Complete 3 quick steps to register a node for deployment.</CardDescription>
          </CardHeader>
          <CardContent>
            {/* Step indicator */}
            <div className="flex items-center gap-0 mb-6">
              {STEP_LABELS.map((label, i) => (
                <div key={i} className="flex items-center flex-1 last:flex-none">
                  <button
                    type="button"
                    onClick={() => i < step && setStep(i)}
                    className={`flex items-center gap-2 text-sm font-medium transition-colors ${
                      i === step ? 'text-gray-900' : i < step ? 'text-gray-500 cursor-pointer hover:text-gray-700' : 'text-gray-300 cursor-default'
                    }`}
                  >
                    <span className={`w-6 h-6 rounded-full flex items-center justify-center text-xs border ${
                      i < step ? 'bg-gray-900 border-gray-900 text-white' :
                      i === step ? 'border-gray-900 text-gray-900' :
                      'border-gray-200 text-gray-300'
                    }`}>
                      {i < step ? '✓' : i + 1}
                    </span>
                    {label}
                  </button>
                  {i < STEP_LABELS.length - 1 && (
                    <div className={`flex-1 h-px mx-3 ${i < step ? 'bg-gray-900' : 'bg-gray-200'}`} />
                  )}
                </div>
              ))}
            </div>

            {/* Step 0: Basic Info */}
            {step === 0 && (
              <div className="space-y-4">
                <p className="text-xs text-gray-500 mb-2">Give this node a recognizable name and enter its hostname or IP address.</p>
                <div className="grid sm:grid-cols-2 gap-4">
                  <div>
                    <Label htmlFor="name">Node Name <span className="text-red-400">*</span></Label>
                    <Input
                      id="name"
                      placeholder="e.g. web-node-1"
                      value={form.name}
                      onChange={(e) => setField('name', e.target.value)}
                      className="mt-1.5 rounded-none border-gray-300"
                    />
                  </div>
                  <div>
                    <Label htmlFor="host">Host / IP Address <span className="text-red-400">*</span></Label>
                    <Input
                      id="host"
                      placeholder="e.g. 192.168.1.101 or server.example.com"
                      value={form.host}
                      onChange={(e) => setField('host', e.target.value)}
                      className="mt-1.5 rounded-none border-gray-300"
                    />
                  </div>
                </div>
                <label className="flex items-center gap-2 text-sm text-gray-700 cursor-pointer mt-2">
                  <input
                    type="checkbox"
                    checked={form.is_primary}
                    onChange={(e) => setField('is_primary', e.target.checked)}
                    className="cursor-pointer"
                  />
                  Mark as <strong>primary</strong> deployment node
                </label>
              </div>
            )}

            {/* Step 1: SSH Access */}
            {step === 1 && (
              <div className="space-y-4">
                <p className="text-xs text-gray-500 mb-2">How should WatchTower connect to this node via SSH?</p>
                <div className="grid sm:grid-cols-3 gap-4">
                  <div>
                    <Label htmlFor="user">SSH User</Label>
                    <Input
                      id="user"
                      value={form.user}
                      onChange={(e) => setField('user', e.target.value)}
                      className="mt-1.5 rounded-none border-gray-300"
                    />
                  </div>
                  <div>
                    <Label htmlFor="port">SSH Port</Label>
                    <Input
                      id="port"
                      type="number"
                      value={form.port}
                      onChange={(e) => setField('port', Number(e.target.value || 22))}
                      className="mt-1.5 rounded-none border-gray-300"
                    />
                  </div>
                  <div>
                    <Label htmlFor="ssh_key_path">SSH Key Path</Label>
                    <Input
                      id="ssh_key_path"
                      placeholder="~/.ssh/id_rsa"
                      value={form.ssh_key_path}
                      onChange={(e) => setField('ssh_key_path', e.target.value)}
                      className="mt-1.5 rounded-none border-gray-300"
                    />
                  </div>
                </div>
                <p className="text-xs text-gray-400">The SSH key must be accessible on the WatchTower server, not your local machine.</p>
              </div>
            )}

            {/* Step 2: Deployment Config */}
            {step === 2 && (
              <div className="space-y-4">
                <p className="text-xs text-gray-500 mb-2">Configure deployment paths and the command that reloads your service.</p>
                <div className="grid sm:grid-cols-2 gap-4">
                  <div>
                    <Label htmlFor="remote_path">Remote Deploy Path</Label>
                    <Input
                      id="remote_path"
                      value={form.remote_path}
                      onChange={(e) => setField('remote_path', e.target.value)}
                      className="mt-1.5 rounded-none border-gray-300"
                    />
                  </div>
                  <div>
                    <Label htmlFor="max_concurrent_deployments">Max Concurrent Deployments</Label>
                    <Input
                      id="max_concurrent_deployments"
                      type="number"
                      min={1}
                      value={form.max_concurrent_deployments}
                      onChange={(e) => setField('max_concurrent_deployments', Number(e.target.value || 1))}
                      className="mt-1.5 rounded-none border-gray-300"
                    />
                  </div>
                  <div className="sm:col-span-2">
                    <Label htmlFor="reload_command">Service Reload Command</Label>
                    <Input
                      id="reload_command"
                      placeholder="e.g. sudo systemctl reload nginx"
                      value={form.reload_command}
                      onChange={(e) => setField('reload_command', e.target.value)}
                      className="mt-1.5 rounded-none border-gray-300"
                    />
                    <p className="text-xs text-gray-400 mt-1">Run after each deployment to apply the new build.</p>
                  </div>
                </div>
              </div>
            )}

            {/* Navigation */}
            <div className="flex items-center justify-between mt-6 pt-4 border-t border-gray-100">
              <Button
                variant="outline"
                disabled={step === 0}
                onClick={() => setStep((s) => s - 1)}
                className="rounded-none border-gray-300 text-sm"
              >
                ← Back
              </Button>
              {step < STEP_LABELS.length - 1 ? (
                <Button
                  onClick={() => isStepValid(step) && setStep((s) => s + 1)}
                  disabled={!isStepValid(step)}
                  className="bg-gray-900 text-white hover:bg-gray-800 rounded-none text-sm"
                >
                  Continue →
                </Button>
              ) : (
                <Button
                  onClick={() => void addNode()}
                  disabled={addingNode || offlineMode || !orgId}
                  className="bg-gray-900 text-white hover:bg-gray-800 rounded-none text-sm"
                >
                  {addingNode ? 'Adding…' : offlineMode ? 'Server offline' : 'Add Node'}
                </Button>
              )}
            </div>
          </CardContent>
        </Card>

        {/* Registered Nodes */}
        <Card className="rounded-none border-gray-200 shadow-none bg-white">
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Registered Nodes</CardTitle>
            <CardDescription>
              {loading ? 'Loading nodes…' : `${nodes.length} node${nodes.length !== 1 ? 's' : ''} available for deployments`}
            </CardDescription>
          </CardHeader>
          <CardContent>
            {loading && (
              <div className="flex items-center gap-2 py-6 text-sm text-gray-400">
                <span className="animate-spin">⌛</span> Loading nodes…
              </div>
            )}

            {!loading && nodes.length === 0 && (
              <div className="py-10 text-center border border-dashed border-gray-200 text-gray-400">
                <p className="text-3xl mb-2">🖥</p>
                <p className="text-sm font-medium text-gray-600">No nodes registered yet</p>
                <p className="text-xs text-gray-400 mt-1">Use the form above to add your first deployment node.</p>
              </div>
            )}

            <div className="space-y-3">
              {nodes.map((node) => {
                const s = STATUS_STYLES[node.status] ?? STATUS_STYLES.offline;
                return (
                  <div key={node.id} className="border border-gray-200 bg-gray-50 p-4">
                    <div className="flex items-start justify-between gap-4">
                      <div className="flex-1 min-w-0">
                        {/* Title row */}
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="font-semibold text-sm text-gray-900">{node.name}</span>
                          <span className={`inline-flex items-center gap-1.5 text-xs px-2 py-0.5 border rounded-full ${s.badge}`}>
                            <span className={`w-1.5 h-1.5 rounded-full ${s.dot}`} />
                            {s.label}
                          </span>
                          {node.is_primary && (
                            <span className="text-xs px-2 py-0.5 border border-blue-200 bg-blue-50 text-blue-700 rounded-full">Primary</span>
                          )}
                        </div>

                        {/* Connection info */}
                        <p className="text-xs text-gray-500 mt-1 font-mono">
                          {node.user}@{node.host}:{node.port} · {node.remote_path}
                        </p>

                        {/* Resource usage bars */}
                        <div className="flex gap-4 mt-3">
                          <UsageBar value={node.cpu_usage} label="CPU" color="bg-blue-400" />
                          <UsageBar value={node.memory_usage} label="Memory" color="bg-purple-400" />
                          <UsageBar value={node.disk_usage} label="Disk" color="bg-orange-400" />
                        </div>

                        {node.last_health_check && (
                          <p className="text-xs text-gray-400 mt-2">Last checked: {node.last_health_check}</p>
                        )}
                      </div>

                      <Button
                        variant="outline"
                        className="rounded-none border-gray-300 text-xs shrink-0"
                        onClick={() => void checkHealth(node.id)}
                        disabled={healthLoading === node.id}
                      >
                        {healthLoading === node.id ? 'Checking…' : 'Health Check'}
                      </Button>
                    </div>
                  </div>
                );
              })}
            </div>
          </CardContent>
        </Card>

        {/* Help section */}
        <Card className="rounded-none border-gray-100 shadow-none bg-white">
          <CardContent className="py-4">
            <p className="text-xs text-gray-500 font-medium mb-2">Quick tips</p>
            <ul className="text-xs text-gray-400 space-y-1 list-disc list-inside">
              <li>The WatchTower server must have SSH access to each node using the key path you provide.</li>
              <li>Use <code className="bg-gray-100 px-1">sudo systemctl reload &lt;service&gt;</code> as the reload command for zero-downtime reloads.</li>
              <li>Run a <strong>Health Check</strong> after adding a node to verify SSH connectivity.</li>
              <li>Only one node can be primary — it is used as the default deployment target.</li>
            </ul>
          </CardContent>
        </Card>
      </main>
    </div>
  );
};

export default NodeManagement;
