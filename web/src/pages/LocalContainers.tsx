import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import apiClient from '@/lib/api';
import { toast } from '@/lib/toast';

/**
 * /local-containers — cross-project view of every WatchTower-managed
 * Podman container running on this machine. Sidebar Admin entry, polls
 * every 5s while the page is mounted so a stop / restart elsewhere
 * reflects here without a manual refresh.
 *
 * Backed by GET /api/local-containers, which walks the JSON state
 * sidecar dir + light-probes each container and clears stale state
 * inline. Polling this endpoint is therefore self-healing.
 */

type LocalContainer = {
  project_id: string;
  project_name: string;
  url: string;
  port: number;
  container_id: string;
  container_name: string;
  image: string;
  serving_path: string | null;
  started_at: string | null;
};

function uptimeLabel(startedAtIso: string | null): string {
  if (!startedAtIso) return '—';
  const t = Date.parse(startedAtIso);
  if (Number.isNaN(t)) return '—';
  const sec = Math.max(0, Math.floor((Date.now() - t) / 1000));
  if (sec < 60) return `${sec}s`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m`;
  if (sec < 86400) return `${Math.floor(sec / 3600)}h ${Math.floor((sec % 3600) / 60)}m`;
  return `${Math.floor(sec / 86400)}d ${Math.floor((sec % 86400) / 3600)}h`;
}

export default function LocalContainers() {
  const [items, setItems] = useState<LocalContainer[] | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Tick the uptime column every 10s without re-fetching the API.
  const [, setTick] = useState(0);

  const load = async () => {
    setError(null);
    try {
      const r = await apiClient.get<LocalContainer[]>('/local-containers');
      setItems(r.data);
    } catch (e) {
      const detail = (e as { response?: { data?: { detail?: string } } })?.response?.data?.detail;
      setError(typeof detail === 'string' ? detail : 'Could not load running containers');
      setItems([]);
    }
  };

  useEffect(() => {
    void load();
    const id = setInterval(() => void load(), 5000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    const id = setInterval(() => setTick((n) => n + 1), 10000);
    return () => clearInterval(id);
  }, []);

  const restart = async (projectId: string) => {
    setBusyId(projectId);
    try {
      await apiClient.post(`/projects/${projectId}/run-locally/restart`, {});
      toast.success('Container restarted');
      void load();
    } catch (e) {
      const detail = (e as { response?: { data?: { detail?: string } } })?.response?.data?.detail;
      toast.error(typeof detail === 'string' ? detail : 'Restart failed');
    } finally {
      setBusyId(null);
    }
  };

  const stop = async (projectId: string) => {
    setBusyId(projectId);
    try {
      await apiClient.delete(`/projects/${projectId}/run-locally`);
      toast.success('Container stopped');
      void load();
    } catch (e) {
      const detail = (e as { response?: { data?: { detail?: string } } })?.response?.data?.detail;
      toast.error(typeof detail === 'string' ? detail : 'Stop failed');
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="max-w-5xl mx-auto px-6 py-8">
      <header className="mb-6 flex items-start justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold text-slate-900">Local containers</h1>
          <p className="mt-1 text-sm text-slate-500">
            Every WatchTower-managed Podman container currently running on this machine.
            Auto-refreshes every 5 seconds. Click a project name to manage it in detail.
          </p>
        </div>
        <button
          type="button"
          onClick={() => void load()}
          className="text-xs px-3 py-1.5 rounded-md border border-slate-300 hover:bg-slate-50"
        >
          Refresh
        </button>
      </header>

      {error && (
        <div className="rounded-lg border border-red-300 bg-red-50 p-3 mb-4 text-xs text-red-800">
          {error}
        </div>
      )}

      {items === null ? (
        <div className="rounded-xl border border-slate-200 bg-white p-8 text-center text-sm text-slate-500">
          Loading…
        </div>
      ) : items.length === 0 ? (
        <div className="rounded-xl border border-slate-200 bg-white p-8 text-center">
          <p className="text-sm font-medium text-slate-900">No containers running</p>
          <p className="mt-1 text-xs text-slate-500">
            Open any project's detail page and click <strong>Run Locally</strong> to spin up a Podman container here.
          </p>
        </div>
      ) : (
        <div className="rounded-xl border border-slate-200 bg-white overflow-hidden shadow-[2px_2px_0_0_#1f2937]">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 border-b border-slate-200">
              <tr className="text-left">
                <th className="px-4 py-2.5 text-[11px] font-semibold uppercase tracking-wider text-slate-500">Project</th>
                <th className="px-4 py-2.5 text-[11px] font-semibold uppercase tracking-wider text-slate-500">URL</th>
                <th className="px-4 py-2.5 text-[11px] font-semibold uppercase tracking-wider text-slate-500">Image</th>
                <th className="px-4 py-2.5 text-[11px] font-semibold uppercase tracking-wider text-slate-500">Up</th>
                <th className="px-4 py-2.5 text-right text-[11px] font-semibold uppercase tracking-wider text-slate-500">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {items.map((c) => (
                <tr key={c.project_id} className="hover:bg-slate-50/50">
                  <td className="px-4 py-3">
                    <Link
                      to={`/projects/${c.project_id}`}
                      className="text-slate-900 font-medium hover:underline"
                    >
                      {c.project_name}
                    </Link>
                    <p className="text-[10.5px] text-slate-500 font-mono mt-0.5">
                      {c.container_name}
                    </p>
                  </td>
                  <td className="px-4 py-3">
                    <a
                      href={c.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-blue-700 hover:underline font-mono text-[12px]"
                    >
                      {c.url} ↗
                    </a>
                  </td>
                  <td className="px-4 py-3">
                    <code
                      className="text-[11px] text-slate-700 font-mono truncate inline-block max-w-[280px]"
                      title={c.image}
                    >
                      {c.image}
                    </code>
                  </td>
                  <td className="px-4 py-3 text-xs text-slate-600 tabular-nums">
                    {uptimeLabel(c.started_at)}
                  </td>
                  <td className="px-4 py-3 text-right">
                    <div className="inline-flex items-center gap-1.5">
                      <button
                        type="button"
                        onClick={() => void restart(c.project_id)}
                        disabled={busyId === c.project_id}
                        className="text-[11px] px-2 py-1 rounded-md border border-slate-300 hover:bg-slate-100 disabled:opacity-50"
                      >
                        Restart
                      </button>
                      <button
                        type="button"
                        onClick={() => void stop(c.project_id)}
                        disabled={busyId === c.project_id}
                        className="text-[11px] px-2 py-1 rounded-md border border-red-300 text-red-700 hover:bg-red-50 disabled:opacity-50"
                      >
                        Stop
                      </button>
                    </div>
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
