/**
 * Phase 5 step 5c: provision-a-node wizard.
 *
 * Three logical phases:
 *   1. Setup    — pick credential → region → size → name
 *   2. Launching — POST /provision, then poll the returned job
 *   3. Done     — registered (with new node info) or failed (with error)
 *
 * The wizard is intentionally self-contained: it owns its API calls,
 * its polling loop, and its terminal state. The parent only sees an
 * `onRegistered(nodeId)` callback for refreshing its own node list.
 */
import { useEffect, useState } from 'react';
import { apiClient } from '@/lib/api';
import { Skeleton } from '@/components/Skeleton';

type CloudProviderCredential = {
  id: string;
  provider: 'digitalocean' | 'hetzner';
  label: string | null;
  account_email: string | null;
};

type Region = { id: string; name: string };
type Size = {
  id: string;
  vcpus: number;
  memory_gb: number;
  monthly_usd: number | null;
};

type ProvisioningJob = {
  id: string;
  provider: string;
  region: string;
  size: string;
  name: string;
  status:
    | 'queued'
    | 'creating_vm'
    | 'waiting_for_ready'
    | 'installing_stack'
    | 'verifying'
    | 'registered'
    | 'failed'
    | 'cancelled';
  error: string | null;
  provider_resource_id: string | null;
  public_ipv4: string | null;
  node_id: string | null;
  created_at: string;
  updated_at: string;
};

const STATUS_LABEL: Record<ProvisioningJob['status'], string> = {
  queued: 'Queued',
  creating_vm: 'Creating VM…',
  waiting_for_ready: 'Waiting for VM to boot…',
  installing_stack: 'Installing Podman + nginx…',
  verifying: 'Verifying install…',
  registered: 'Ready — registered as a deploy node',
  failed: 'Failed',
  cancelled: 'Cancelled',
};

const TERMINAL_STATUSES: ProvisioningJob['status'][] = ['registered', 'failed', 'cancelled'];

function extractDetail(err: unknown, fallback: string): string {
  const d = (err as { response?: { data?: { detail?: string } } })?.response?.data?.detail;
  return d || fallback;
}

interface Props {
  onClose: () => void;
  onRegistered: (nodeId: string) => void;
}

export function ProvisionNodeWizard({ onClose, onRegistered }: Props) {
  // Setup phase state.
  const [creds, setCreds] = useState<CloudProviderCredential[] | null>(null);
  const [credId, setCredId] = useState('');
  const [regions, setRegions] = useState<Region[] | null>(null);
  const [region, setRegion] = useState('');
  const [sizes, setSizes] = useState<Size[] | null>(null);
  const [size, setSize] = useState('');
  const [name, setName] = useState('');
  const [error, setError] = useState('');

  // Loading flags per step so the spinner appears next to the right control.
  const [loadingCreds, setLoadingCreds] = useState(true);
  const [loadingRegions, setLoadingRegions] = useState(false);
  const [loadingSizes, setLoadingSizes] = useState(false);

  // Phase tracking. The wizard transitions setup → launching once
  // POST /provision returns 202; from there `job` drives the UI.
  const [job, setJob] = useState<ProvisioningJob | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // ── 1. Load credentials on mount ──────────────────────────────────────
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const r = await apiClient.get<CloudProviderCredential[]>('/integrations/cloud-providers');
        if (cancelled) return;
        setCreds(r.data);
        // Auto-select if there's only one — saves a click.
        if (r.data.length === 1) setCredId(r.data[0].id);
      } catch (e) {
        if (!cancelled) setError(extractDetail(e, 'Failed to load cloud-provider credentials.'));
      } finally {
        if (!cancelled) setLoadingCreds(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  // ── 2. Load regions when credential changes ───────────────────────────
  useEffect(() => {
    if (!credId) { setRegions(null); setRegion(''); return; }
    let cancelled = false;
    setLoadingRegions(true);
    setRegion(''); setSizes(null); setSize('');
    void (async () => {
      try {
        const r = await apiClient.get<Region[]>(`/integrations/cloud-providers/${credId}/regions`);
        if (!cancelled) setRegions(r.data);
      } catch (e) {
        if (!cancelled) setError(extractDetail(e, 'Failed to load regions for this credential.'));
      } finally {
        if (!cancelled) setLoadingRegions(false);
      }
    })();
    return () => { cancelled = true; };
  }, [credId]);

  // ── 3. Load sizes when region changes ─────────────────────────────────
  useEffect(() => {
    if (!credId || !region) { setSizes(null); setSize(''); return; }
    let cancelled = false;
    setLoadingSizes(true);
    setSize('');
    void (async () => {
      try {
        const r = await apiClient.get<Size[]>(
          `/integrations/cloud-providers/${credId}/sizes?region=${encodeURIComponent(region)}`,
        );
        if (!cancelled) setSizes(r.data);
      } catch (e) {
        if (!cancelled) setError(extractDetail(e, 'Failed to load sizes for this region.'));
      } finally {
        if (!cancelled) setLoadingSizes(false);
      }
    })();
    return () => { cancelled = true; };
  }, [credId, region]);

  // ── 4. Poll the job once it's launched ────────────────────────────────
  useEffect(() => {
    if (!job || TERMINAL_STATUSES.includes(job.status)) return;
    const t = window.setTimeout(async () => {
      try {
        const r = await apiClient.get<ProvisioningJob>(`/integrations/cloud-providers/provisioning-jobs/${job.id}`);
        setJob(r.data);
        if (r.data.status === 'registered' && r.data.node_id) {
          onRegistered(r.data.node_id);
        }
      } catch (e) {
        setError(extractDetail(e, 'Failed to poll job status.'));
      }
    }, 3000);
    return () => window.clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [job?.id, job?.status]);

  const submit = async () => {
    setError('');
    setSubmitting(true);
    try {
      const r = await apiClient.post<ProvisioningJob>(
        '/integrations/cloud-providers/provision',
        { credential_id: credId, name: name.trim(), region, size },
      );
      setJob(r.data);
    } catch (e) {
      setError(extractDetail(e, 'Failed to start provisioning.'));
    } finally {
      setSubmitting(false);
    }
  };

  const canSubmit = !!(credId && region && size && name.trim().length > 0 && !submitting);

  // ── Polling / done view ───────────────────────────────────────────────
  if (job) {
    const terminal = TERMINAL_STATUSES.includes(job.status);
    const succeeded = job.status === 'registered';
    return (
      <div className="rounded-xl border border-border bg-card p-6 space-y-4">
        <div className="flex items-center justify-between gap-3">
          <h2 className="text-base font-semibold text-slate-900">
            {succeeded ? '✓ Server provisioned' : terminal ? '✗ Provisioning failed' : 'Provisioning…'}
          </h2>
          {terminal && (
            <button
              onClick={onClose}
              className="px-3 py-1.5 rounded-md border border-slate-300 text-xs text-slate-700 hover:bg-slate-100"
            >
              Close
            </button>
          )}
        </div>

        <div className="rounded-md bg-slate-50 border border-slate-200 px-4 py-3 text-sm space-y-1">
          <p><span className="text-slate-500">Name:</span> <span className="font-mono">{job.name}</span></p>
          <p><span className="text-slate-500">Provider:</span> {job.provider} · {job.region} · {job.size}</p>
          {job.public_ipv4 && <p><span className="text-slate-500">IP:</span> <code className="font-mono">{job.public_ipv4}</code></p>}
          <p>
            <span className="text-slate-500">Status:</span>{' '}
            <span className={
              succeeded ? 'text-emerald-700 font-medium'
              : job.status === 'failed' ? 'text-red-700 font-medium'
              : 'text-slate-700'
            }>{STATUS_LABEL[job.status]}</span>
          </p>
        </div>

        {job.error && (
          <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700 whitespace-pre-wrap">
            {job.error}
            <p className="mt-2 text-red-600">
              {job.provider_resource_id
                ? 'WatchTower tried to delete the partial VM — check your provider console to confirm no orphan was left.'
                : 'No VM was created; nothing to clean up on the provider side.'}
            </p>
          </div>
        )}

        {succeeded && (
          <p className="text-xs text-emerald-700">
            The node is registered in this org and ready to deploy to. You can close this dialog.
          </p>
        )}

        {!terminal && (
          <p className="text-xs text-slate-500">
            This usually takes 2–5 minutes (VM boot ~1 min, prep script ~1–3 min). Polling every 3s.
          </p>
        )}
      </div>
    );
  }

  // ── Setup view ────────────────────────────────────────────────────────
  return (
    <div className="rounded-xl border border-border bg-card p-6 space-y-5">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h2 className="text-base font-semibold text-slate-900">Provision a new server</h2>
          <p className="text-xs text-slate-600 mt-0.5">
            WatchTower creates a fresh Ubuntu VM on DigitalOcean or Hetzner, installs Podman + nginx, and registers it as a deploy node.
          </p>
        </div>
        <button
          onClick={onClose}
          className="px-3 py-1.5 rounded-md border border-slate-300 text-xs text-slate-700 hover:bg-slate-100"
        >
          Cancel
        </button>
      </div>

      {error && (
        <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
          {error}
        </div>
      )}

      {/* Credential picker */}
      <div>
        <label className="block text-xs font-medium text-slate-700 mb-1">Cloud provider credential</label>
        {loadingCreds ? (
          <Skeleton.Line className="h-9 w-full" />
        ) : creds && creds.length === 0 ? (
          <p className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded px-3 py-2">
            No credentials saved yet. Go to Integrations → Cloud providers to add one.
          </p>
        ) : (
          <select
            value={credId}
            onChange={(e) => setCredId(e.target.value)}
            className="w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm"
          >
            <option value="">— pick one —</option>
            {creds?.map((c) => (
              <option key={c.id} value={c.id}>
                {c.label || c.provider} ({c.provider}{c.account_email ? ` · ${c.account_email}` : ''})
              </option>
            ))}
          </select>
        )}
      </div>

      {/* Region picker */}
      {credId && (
        <div>
          <label className="block text-xs font-medium text-slate-700 mb-1">Region</label>
          {loadingRegions ? (
            <Skeleton.Line className="h-9 w-full" />
          ) : (
            <select
              value={region}
              onChange={(e) => setRegion(e.target.value)}
              className="w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm"
            >
              <option value="">— pick one —</option>
              {regions?.map((r) => (
                <option key={r.id} value={r.id}>{r.name} ({r.id})</option>
              ))}
            </select>
          )}
        </div>
      )}

      {/* Size picker */}
      {credId && region && (
        <div>
          <label className="block text-xs font-medium text-slate-700 mb-1">
            Size <span className="text-slate-500">— sorted cheapest first</span>
          </label>
          {loadingSizes ? (
            <Skeleton.Line className="h-9 w-full" />
          ) : (
            <select
              value={size}
              onChange={(e) => setSize(e.target.value)}
              className="w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm font-mono"
            >
              <option value="">— pick one —</option>
              {sizes?.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.id} — {s.vcpus} vCPU · {s.memory_gb.toFixed(1)} GB
                  {s.monthly_usd != null ? ` · $${s.monthly_usd.toFixed(2)}/mo` : ''}
                </option>
              ))}
            </select>
          )}
        </div>
      )}

      {/* Name */}
      {credId && region && size && (
        <div>
          <label className="block text-xs font-medium text-slate-700 mb-1">Server name</label>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="my-app-prod-1"
            maxLength={63}
            className="w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm font-mono"
          />
          <p className="text-[11px] text-slate-500 mt-1">
            Alphanumeric + hyphen/underscore. Becomes the VM hostname and the WatchTower node name.
          </p>
        </div>
      )}

      <div className="flex justify-end gap-2 pt-1">
        <button
          onClick={submit}
          disabled={!canSubmit}
          className="px-4 py-1.5 rounded-md bg-slate-900 hover:bg-slate-800 text-white text-sm font-medium disabled:opacity-50"
        >
          {submitting ? 'Launching…' : 'Launch'}
        </button>
      </div>
    </div>
  );
}
