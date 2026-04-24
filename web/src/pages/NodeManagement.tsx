import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
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

const NodeManagement = () => {
  const [orgId, setOrgId] = useState<string>('');
  const [orgName, setOrgName] = useState<string>('');
  const [nodes, setNodes] = useState<OrgNode[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [form, setForm] = useState({
    name: '',
    host: '',
    user: 'root',
    port: 22,
    remote_path: '/opt/apps/watchtower',
    ssh_key_path: '~/.ssh/id_rsa',
    reload_command: 'sudo systemctl reload caddy',
    is_primary: true,
    max_concurrent_deployments: 1,
  });

  const refreshNodes = async (currentOrgId: string) => {
    const nodesResp = await apiClient.get(`/orgs/${currentOrgId}/nodes`);
    setNodes(nodesResp.data as OrgNode[]);
  };

  useEffect(() => {
    const load = async () => {
      setLoading(true);
      setError('');
      try {
        const ctxResp = await apiClient.get('/context');
        const ctx = ctxResp.data as ContextResponse;
        setOrgId(ctx.organization.id);
        setOrgName(ctx.organization.name);
        await refreshNodes(ctx.organization.id);
      } catch {
        setError('Unable to load node management data.');
      } finally {
        setLoading(false);
      }
    };

    void load();
  }, []);

  const setField = (key: string, value: string | number | boolean) => {
    setForm((prev) => ({ ...prev, [key]: value }));
  };

  const addNode = async () => {
    if (!orgId || !form.name || !form.host) {
      return;
    }

    setLoading(true);
    setError('');
    try {
      await apiClient.post(`/orgs/${orgId}/nodes`, form);
      setForm((prev) => ({ ...prev, name: '', host: '' }));
      await refreshNodes(orgId);
    } catch {
      setError('Failed to add node.');
    } finally {
      setLoading(false);
    }
  };

  const checkHealth = async (nodeId: string) => {
    setLoading(true);
    setError('');
    try {
      await apiClient.get(`/org-nodes/${nodeId}/health`);
      await refreshNodes(orgId);
    } catch {
      setError('SSH health check failed for one or more nodes.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-white">
      <header className="border-b border-gray-100">
        <div className="max-w-6xl mx-auto px-6 py-8 flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-semibold text-gray-900">Node Management</h1>
            <p className="text-sm text-gray-500 mt-1">Organization: {orgName || 'Loading...'}</p>
          </div>
          <Link to="/">
            <Button variant="outline" className="rounded-none border-gray-300">Back to Dashboard</Button>
          </Link>
        </div>
      </header>

      <main className="max-w-6xl mx-auto px-6 py-8 space-y-6">
        {error && (
          <Card className="rounded-none border-red-200 bg-red-50 shadow-none">
            <CardContent className="py-4 text-sm text-red-700">{error}</CardContent>
          </Card>
        )}

        <Card className="rounded-none border-gray-200 shadow-none">
          <CardHeader>
            <CardTitle>Add Deployment Node</CardTitle>
            <CardDescription>Register a node and use SSH health checks to monitor it.</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="grid md:grid-cols-3 gap-4">
              <div>
                <Label htmlFor="name">Node Name</Label>
                <Input id="name" value={form.name} onChange={(e) => setField('name', e.target.value)} className="mt-2 rounded-none border-gray-300" />
              </div>
              <div>
                <Label htmlFor="host">Host</Label>
                <Input id="host" value={form.host} onChange={(e) => setField('host', e.target.value)} className="mt-2 rounded-none border-gray-300" />
              </div>
              <div>
                <Label htmlFor="user">SSH User</Label>
                <Input id="user" value={form.user} onChange={(e) => setField('user', e.target.value)} className="mt-2 rounded-none border-gray-300" />
              </div>
              <div>
                <Label htmlFor="port">SSH Port</Label>
                <Input id="port" type="number" value={form.port} onChange={(e) => setField('port', Number(e.target.value || 22))} className="mt-2 rounded-none border-gray-300" />
              </div>
              <div>
                <Label htmlFor="remote_path">Remote Path</Label>
                <Input id="remote_path" value={form.remote_path} onChange={(e) => setField('remote_path', e.target.value)} className="mt-2 rounded-none border-gray-300" />
              </div>
              <div>
                <Label htmlFor="ssh_key_path">SSH Key Path</Label>
                <Input id="ssh_key_path" value={form.ssh_key_path} onChange={(e) => setField('ssh_key_path', e.target.value)} className="mt-2 rounded-none border-gray-300" />
              </div>
              <div className="md:col-span-2">
                <Label htmlFor="reload_command">Reload Command</Label>
                <Input id="reload_command" value={form.reload_command} onChange={(e) => setField('reload_command', e.target.value)} className="mt-2 rounded-none border-gray-300" />
              </div>
              <div>
                <Label htmlFor="max_concurrent_deployments">Max Concurrent Deployments</Label>
                <Input
                  id="max_concurrent_deployments"
                  type="number"
                  min={1}
                  value={form.max_concurrent_deployments}
                  onChange={(e) => setField('max_concurrent_deployments', Number(e.target.value || 1))}
                  className="mt-2 rounded-none border-gray-300"
                />
              </div>
            </div>
            <label className="mt-4 flex items-center gap-2 text-sm text-gray-700">
              <input
                type="checkbox"
                checked={form.is_primary}
                onChange={(e) => setField('is_primary', e.target.checked)}
              />
              Mark as primary deployment node
            </label>
            <Button onClick={addNode} disabled={loading || !orgId} className="mt-4 bg-gray-900 text-white hover:bg-gray-800 rounded-none">
              Add Node
            </Button>
          </CardContent>
        </Card>

        <Card className="rounded-none border-gray-200 shadow-none">
          <CardHeader>
            <CardTitle>Registered Nodes</CardTitle>
            <CardDescription>{nodes.length} node(s) available for deployment selection.</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="space-y-3">
              {nodes.map((node) => (
                <div key={node.id} className="border border-gray-200 p-4">
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <p className="font-semibold text-sm text-gray-900">{node.name} ({node.host}:{node.port})</p>
                      <p className="text-xs text-gray-500 mt-1">
                        {node.user} · {node.is_primary ? 'primary' : 'secondary'} · status: {node.status}
                      </p>
                      <p className="text-xs text-gray-500 mt-1">
                        CPU: {node.cpu_usage ?? '--'}% · Memory: {node.memory_usage ?? '--'}% · Disk: {node.disk_usage ?? '--'}%
                      </p>
                    </div>
                    <Button
                      variant="outline"
                      className="rounded-none border-gray-300"
                      onClick={() => void checkHealth(node.id)}
                      disabled={loading}
                    >
                      SSH Health Check
                    </Button>
                  </div>
                </div>
              ))}
              {!loading && nodes.length === 0 && <p className="text-sm text-gray-500">No deployment nodes found.</p>}
            </div>
          </CardContent>
        </Card>
      </main>
    </div>
  );
};

export default NodeManagement;
