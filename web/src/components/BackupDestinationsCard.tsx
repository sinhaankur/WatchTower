import { useEffect, useState } from 'react';
import axios from 'axios';
import apiClient from '@/lib/api';

/**
 * Off-host backup destinations (Settings card).
 *
 * Every managed-DB backup this machine produces is auto-pushed to each enabled
 * destination — an always-on peer over the tailnet (kind='peer', rsync/SSH) or
 * a mounted/cloud-synced folder (kind='folder'). Admin-only (the API gates on
 * can_manage_team); on 403 we hide the card so non-admins don't see a broken
 * control.
 */
type Kind = 'peer' | 'folder';

type Destination = {
  id: string;
  kind: Kind;
  label: string | null;
  is_enabled: boolean;
  node_id: string | null;
  remote_subdir: string | null;
  folder_path: string | null;
};

type NodeOption = { id: string; name: string | null; host: string | null };

export default function BackupDestinationsCard() {
  const [dests, setDests] = useState<Destination[]>([]);
  const [nodes, setNodes] = useState<NodeOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [forbidden, setForbidden] = useState(false);

  const [kind, setKind] = useState<Kind>('peer');
  const [nodeId, setNodeId] = useState('');
  const [folderPath, setFolderPath] = useState('');
  const [label, setLabel] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [testResult, setTestResult] = useState<{ id: string; ok: boolean; detail?: string } | null>(null);

  const load = async () => {
    setLoading(true);
    try {
      const [d, n] = await Promise.all([
        apiClient.get<Destination[]>('/backup-destinations'),
        apiClient.get<NodeOption[]>('/backup-destinations/nodes'),
      ]);
      setDests(Array.isArray(d.data) ? d.data : []);
      setNodes(Array.isArray(n.data) ? n.data : []);
      setForbidden(false);
    } catch (err) {
      if (axios.isAxiosError(err) && err.response?.status === 403) setForbidden(true);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, []);

  const add = async () => {
    setError(null);
    const payload =
      kind === 'peer'
        ? { kind, node_id: nodeId, label: label.trim() || undefined }
        : { kind, folder_path: folderPath.trim(), label: label.trim() || undefined };
    if (kind === 'peer' && !nodeId) return setError('Pick a server to back up to.');
    if (kind === 'folder' && !folderPath.trim()) return setError('Enter a folder path.');
    setSaving(true);
    try {
      await apiClient.post('/backup-destinations', payload);
      setNodeId('');
      setFolderPath('');
      setLabel('');
      await load();
    } catch (err) {
      const detail = axios.isAxiosError(err) ? (err.response?.data as { detail?: string })?.detail : null;
      setError(typeof detail === 'string' ? detail : 'Could not add the destination.');
    } finally {
      setSaving(false);
    }
  };

  const remove = async (id: string) => {
    try {
      await apiClient.delete(`/backup-destinations/${id}`);
      await load();
    } catch { /* non-fatal */ }
  };

  const toggle = async (d: Destination) => {
    try {
      await apiClient.patch(`/backup-destinations/${d.id}`, { is_enabled: !d.is_enabled });
      await load();
    } catch { /* non-fatal */ }
  };

  const test = async (id: string) => {
    setTestResult(null);
    try {
      const r = await apiClient.post<{ ok: boolean; detail?: string }>(`/backup-destinations/${id}/test`);
      setTestResult({ id, ok: r.data.ok, detail: r.data.detail });
    } catch (err) {
      const detail = axios.isAxiosError(err) ? (err.response?.data as { detail?: string })?.detail : null;
      setTestResult({ id, ok: false, detail: typeof detail === 'string' ? detail : 'Test failed.' });
    }
  };

  // Admins only — hide entirely for everyone else.
  if (forbidden) return null;

  return (
    <div className="rounded-xl border border-border bg-card p-5 shadow-retro">
      <div className="mb-4">
        <h2 className="text-sm font-semibold text-foreground">Off-host backups</h2>
        <p className="text-xs text-muted-foreground mt-0.5">
          Every managed-database backup is automatically copied to each destination below — an
          always-on server over your tailnet, or a cloud-synced / NAS folder. If a destination is
          offline when a backup runs, WatchTower retries in the background.
        </p>
      </div>

      {/* Existing destinations */}
      {loading ? (
        <p className="text-xs text-muted-foreground py-2">Loading…</p>
      ) : dests.length === 0 ? (
        <p className="text-xs text-muted-foreground py-2">No backup destinations yet.</p>
      ) : (
        <div className="space-y-1.5 mb-4">
          {dests.map((d) => (
            <div key={d.id} className="rounded-md border border-border-soft bg-surface-soft px-3 py-2">
              <div className="flex items-center gap-2 text-xs">
                <span className="font-medium text-foreground capitalize">{d.kind}</span>
                {d.label && <span className="text-muted-foreground">· {d.label}</span>}
                <span className="text-muted-foreground font-mono truncate flex-1">
                  {d.kind === 'folder' ? d.folder_path : (nodes.find((n) => n.id === d.node_id)?.host ?? d.node_id)}
                </span>
                {!d.is_enabled && <span className="text-amber-600 shrink-0">paused</span>}
                <button type="button" onClick={() => void test(d.id)} className="text-muted-foreground hover:text-foreground transition-colors shrink-0">Test</button>
                <button type="button" onClick={() => void toggle(d)} className="text-muted-foreground hover:text-foreground transition-colors shrink-0">{d.is_enabled ? 'Pause' : 'Enable'}</button>
                <button type="button" onClick={() => void remove(d.id)} className="text-muted-foreground hover:text-red-600 transition-colors shrink-0">Remove</button>
              </div>
              {testResult?.id === d.id && (
                <p className={`text-[11px] mt-1 ${testResult.ok ? 'text-emerald-600' : 'text-red-600'}`}>
                  {testResult.ok ? 'Connectivity OK — probe file delivered.' : (testResult.detail || 'Test failed.')}
                </p>
              )}
            </div>
          ))}
        </div>
      )}

      {/* Add form */}
      <div className="flex flex-col sm:flex-row gap-2">
        <select
          value={kind}
          onChange={(e) => { setKind(e.target.value as Kind); setError(null); }}
          className="rounded-md border border-input bg-card px-3 py-2 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-ring"
        >
          <option value="peer">Server (tailnet)</option>
          <option value="folder">Folder</option>
        </select>
        {kind === 'peer' ? (
          <select
            value={nodeId}
            onChange={(e) => setNodeId(e.target.value)}
            className="flex-1 rounded-md border border-input bg-card px-3 py-2 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-ring"
          >
            <option value="">{nodes.length ? 'Choose a server…' : 'No servers registered'}</option>
            {nodes.map((n) => (
              <option key={n.id} value={n.id}>{n.name || n.host || n.id}</option>
            ))}
          </select>
        ) : (
          <input
            value={folderPath}
            onChange={(e) => setFolderPath(e.target.value)}
            placeholder="/mnt/nas/backups · ~/Dropbox/wt · C:\Backups"
            className="flex-1 rounded-md border border-input bg-card px-3 py-2 text-sm font-mono text-foreground focus:outline-none focus:ring-2 focus:ring-ring"
          />
        )}
        <input
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          placeholder="Label (optional)"
          className="rounded-md border border-input bg-card px-3 py-2 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-ring sm:w-40"
        />
        <button
          type="button"
          onClick={() => void add()}
          disabled={saving}
          className="px-4 py-2 rounded-md bg-primary hover:bg-primary/90 text-primary-foreground text-sm font-semibold shadow-retro disabled:opacity-60"
        >
          {saving ? 'Adding…' : 'Add'}
        </button>
      </div>
      {error && <p className="text-xs text-red-600 mt-2">{error}</p>}
    </div>
  );
}
