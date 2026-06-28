import { useEffect, useState } from 'react';
import axios from 'axios';
import apiClient from '@/lib/api';

/**
 * Installation-wide Slack/Discord webhooks (Settings card).
 *
 * These fire on org-level events that aren't tied to a single project —
 * currently control-plane pairing/unpairing (see watchtower/notifier.notify_org).
 * Admin-only (the API gates on can_manage_team); on 403 we hide the card so
 * non-admins don't see a broken control.
 */
type OrgWebhook = {
  id: string;
  provider: 'slack' | 'discord';
  url: string;
  label: string | null;
  is_active: boolean;
};

export default function OrgWebhooksCard() {
  const [hooks, setHooks] = useState<OrgWebhook[]>([]);
  const [loading, setLoading] = useState(true);
  const [forbidden, setForbidden] = useState(false);
  const [provider, setProvider] = useState<'slack' | 'discord'>('slack');
  const [url, setUrl] = useState('');
  const [label, setLabel] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const load = async () => {
    setLoading(true);
    try {
      const r = await apiClient.get<OrgWebhook[]>('/org-webhooks');
      setHooks(r.data);
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
    if (!url.trim()) return setError('Webhook URL is required.');
    setSaving(true);
    try {
      await apiClient.post('/org-webhooks', { provider, url: url.trim(), label: label.trim() || undefined });
      setUrl('');
      setLabel('');
      await load();
    } catch (err) {
      const detail = axios.isAxiosError(err) ? (err.response?.data as { detail?: string })?.detail : null;
      setError(typeof detail === 'string' ? detail : 'Could not add the webhook.');
    } finally {
      setSaving(false);
    }
  };

  const remove = async (id: string) => {
    try {
      await apiClient.delete(`/org-webhooks/${id}`);
      await load();
    } catch { /* non-fatal */ }
  };

  // Admins only — hide entirely for everyone else.
  if (forbidden) return null;

  return (
    <div className="rounded-xl border border-border bg-card p-5 shadow-retro">
      <div className="mb-4">
        <h2 className="text-sm font-semibold text-foreground">Org notifications</h2>
        <p className="text-xs text-muted-foreground mt-0.5">
          Slack/Discord alerts for installation-wide events (e.g. control-plane pairing). Project
          deploy alerts are set per-project on the project page.
        </p>
      </div>

      {/* Existing hooks */}
      {loading ? (
        <p className="text-xs text-muted-foreground py-2">Loading…</p>
      ) : hooks.length === 0 ? (
        <p className="text-xs text-muted-foreground py-2">No org webhooks yet.</p>
      ) : (
        <div className="space-y-1.5 mb-4">
          {hooks.map((h) => (
            <div key={h.id} className="flex items-center gap-2 text-xs rounded-md border border-border-soft bg-surface-soft px-3 py-2">
              <span className="font-medium text-foreground capitalize">{h.provider}</span>
              {h.label && <span className="text-muted-foreground">· {h.label}</span>}
              <span className="text-muted-foreground font-mono truncate flex-1">{h.url.replace(/\/[^/]+$/, '/…')}</span>
              <button
                type="button"
                onClick={() => void remove(h.id)}
                className="text-muted-foreground hover:text-red-600 transition-colors shrink-0"
              >
                Remove
              </button>
            </div>
          ))}
        </div>
      )}

      {/* Add form */}
      <div className="flex flex-col sm:flex-row gap-2">
        <select
          value={provider}
          onChange={(e) => setProvider(e.target.value as 'slack' | 'discord')}
          className="rounded-md border border-input bg-card px-3 py-2 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-ring"
        >
          <option value="slack">Slack</option>
          <option value="discord">Discord</option>
        </select>
        <input
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder={provider === 'slack' ? 'https://hooks.slack.com/services/…' : 'https://discord.com/api/webhooks/…'}
          className="flex-1 rounded-md border border-input bg-card px-3 py-2 text-sm font-mono text-foreground focus:outline-none focus:ring-2 focus:ring-ring"
        />
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
