import { useEffect, useState } from 'react';
import {
  useEmailConfig,
  useUpdateEmailConfig,
  useTestEmailConfig,
} from '@/hooks/queries';
import { toast } from '@/lib/toast';

function extractDetail(err: unknown, fallback: string): string {
  return (err as { response?: { data?: { detail?: string } } })?.response?.data?.detail ?? fallback;
}

// One-click presets for the mail providers beginners actually reach for.
// Selecting one only pre-fills host/port/TLS — nothing is saved until Save,
// so exploring is free. Gmail/Outlook need an *app password*, not the account
// password; the hint links straight to where you make one.
const PRESETS = [
  {
    id: 'gmail',
    label: 'Gmail',
    host: 'smtp.gmail.com',
    port: 587,
    tls: true,
    hint: 'Use a Google App Password (not your login password).',
    help: 'https://myaccount.google.com/apppasswords',
  },
  {
    id: 'outlook',
    label: 'Outlook',
    host: 'smtp-mail.outlook.com',
    port: 587,
    tls: true,
    hint: 'Use an Outlook app password if you have 2FA enabled.',
    help: 'https://account.microsoft.com/security',
  },
  {
    id: 'sendgrid',
    label: 'SendGrid',
    host: 'smtp.sendgrid.net',
    port: 587,
    tls: true,
    hint: "Username is literally 'apikey'; password is your SendGrid API key.",
    help: 'https://app.sendgrid.com/settings/api_keys',
  },
  {
    id: 'custom',
    label: 'Custom',
    host: '',
    port: 587,
    tls: true,
    hint: 'Any SMTP server — a local relay on port 25 works too (TLS off).',
    help: '',
  },
] as const;

export default function EmailCard() {
  const { data: config, isLoading } = useEmailConfig();
  const updateConfig = useUpdateEmailConfig();
  const testEmail = useTestEmailConfig();

  const [host, setHost] = useState('');
  const [port, setPort] = useState(587);
  const [user, setUser] = useState('');
  const [password, setPassword] = useState('');
  const [from, setFrom] = useState('');
  const [useTls, setUseTls] = useState(true);
  const [dirty, setDirty] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; msg: string } | null>(null);

  // Seed from saved config once it arrives — never clobber in-progress edits.
  useEffect(() => {
    if (config && !dirty) {
      setHost(config.smtp_host ?? '');
      setPort(config.smtp_port ?? 587);
      setUser(config.smtp_user ?? '');
      setFrom(config.smtp_from ?? '');
      setUseTls(config.use_tls);
    }
  }, [config, dirty]);

  const activePreset =
    PRESETS.find((p) => p.id !== 'custom' && p.host === host) ?? PRESETS[PRESETS.length - 1];

  const applyPreset = (p: (typeof PRESETS)[number]) => {
    if (p.host) setHost(p.host);
    setPort(p.port);
    setUseTls(p.tls);
    setDirty(true);
    setTestResult(null);
  };

  const handleSave = async () => {
    if (!host.trim()) {
      toast.error('Enter an SMTP host, or pick a provider above.');
      return;
    }
    try {
      await updateConfig.mutateAsync({
        smtp_host: host,
        smtp_port: port,
        smtp_user: user,
        // Only send the password when the user typed one — an empty field
        // means "keep what's stored", not "delete it".
        ...(password ? { smtp_password: password } : {}),
        smtp_from: from,
        use_tls: useTls,
      });
      setDirty(false);
      setPassword('');
      toast.success('Email settings saved — invitations will now send automatically');
    } catch (err) {
      toast.error(extractDetail(err, 'Could not save email settings'));
    }
  };

  const handleTest = async () => {
    setTestResult(null);
    // Save first if there are unsaved edits — the test uses the *saved* config,
    // so testing dirty edits would silently probe the old values.
    if (dirty) {
      toast.error('Save your changes first, then send a test.');
      return;
    }
    try {
      const result = await testEmail.mutateAsync({});
      if (result.ok) {
        setTestResult({ ok: true, msg: `Test email sent to ${result.to}. Check the inbox.` });
      } else {
        setTestResult({ ok: false, msg: result.error ?? 'Send failed' });
      }
    } catch (err) {
      setTestResult({ ok: false, msg: extractDetail(err, 'Test send failed') });
    }
  };

  return (
    <div className="rounded-xl border border-border bg-card p-5 shadow-retro">
      {/* Header */}
      <div className="flex items-center gap-3 mb-4">
        <div className="w-9 h-9 rounded-lg border border-border bg-sky-600 flex items-center justify-center shadow-retro">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <rect x="2" y="4" width="20" height="16" rx="2" />
            <path d="m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7" />
          </svg>
        </div>
        <div className="flex-1 min-w-0">
          <h2 className="text-sm font-semibold text-slate-900">Email (SMTP)</h2>
          <p className="text-xs text-slate-500">
            Connect a mail server so team invitations send automatically instead of you sharing a link.
          </p>
        </div>
        {config?.configured && (
          <span className="text-[10px] font-semibold text-emerald-800 bg-emerald-100 border border-emerald-300 rounded-full px-2 py-0.5">
            Auto-send on
          </span>
        )}
      </div>

      <div className="space-y-3">
        {/* Provider presets */}
        <div className="flex flex-wrap gap-2">
          {PRESETS.map((p) => (
            <button
              key={p.id}
              title={p.hint}
              onClick={() => applyPreset(p)}
              className={`text-xs px-3 py-1 rounded-full border transition-colors ${
                activePreset.id === p.id
                  ? 'border-border bg-slate-900 text-white'
                  : 'border-slate-300 text-slate-600 hover:border-slate-500 hover:text-slate-900'
              }`}
            >
              {p.label}
            </button>
          ))}
        </div>

        {activePreset.hint && (
          <p className="text-[11px] text-slate-500">
            {activePreset.hint}{' '}
            {activePreset.help && (
              <a href={activePreset.help} target="_blank" rel="noopener noreferrer" className="underline hover:text-slate-700">
                Set one up →
              </a>
            )}
          </p>
        )}

        {/* Host + port */}
        <div className="grid sm:grid-cols-3 gap-3">
          <label className="block sm:col-span-2">
            <span className="text-[11px] text-slate-600">SMTP host</span>
            <input
              type="text"
              value={host}
              placeholder="smtp.gmail.com"
              onChange={(e) => { setHost(e.target.value); setDirty(true); setTestResult(null); }}
              className="mt-1 w-full text-xs font-mono rounded-lg border border-slate-300 px-3 py-2 focus:outline-none focus:border-slate-700"
            />
          </label>
          <label className="block">
            <span className="text-[11px] text-slate-600">Port</span>
            <input
              type="number"
              value={port}
              onChange={(e) => { setPort(Number(e.target.value) || 0); setDirty(true); setTestResult(null); }}
              className="mt-1 w-full text-xs font-mono rounded-lg border border-slate-300 px-3 py-2 focus:outline-none focus:border-slate-700"
            />
          </label>
        </div>

        {/* User + password */}
        <div className="grid sm:grid-cols-2 gap-3">
          <label className="block">
            <span className="text-[11px] text-slate-600">Username</span>
            <input
              type="text"
              value={user}
              placeholder="you@example.com"
              autoComplete="off"
              onChange={(e) => { setUser(e.target.value); setDirty(true); setTestResult(null); }}
              className="mt-1 w-full text-xs font-mono rounded-lg border border-slate-300 px-3 py-2 focus:outline-none focus:border-slate-700"
            />
          </label>
          <label className="block">
            <span className="text-[11px] text-slate-600">
              Password {config?.has_password ? '(saved — leave blank to keep)' : '(app password)'}
            </span>
            <input
              type="password"
              value={password}
              placeholder={config?.has_password ? '••••••••' : 'app password'}
              autoComplete="new-password"
              onChange={(e) => { setPassword(e.target.value); setDirty(true); setTestResult(null); }}
              className="mt-1 w-full text-xs font-mono rounded-lg border border-slate-300 px-3 py-2 focus:outline-none focus:border-slate-700"
            />
          </label>
        </div>

        {/* From + TLS */}
        <div className="grid sm:grid-cols-2 gap-3 items-end">
          <label className="block">
            <span className="text-[11px] text-slate-600">From address</span>
            <input
              type="text"
              value={from}
              placeholder="you@example.com"
              onChange={(e) => { setFrom(e.target.value); setDirty(true); setTestResult(null); }}
              className="mt-1 w-full text-xs font-mono rounded-lg border border-slate-300 px-3 py-2 focus:outline-none focus:border-slate-700"
            />
          </label>
          <label className="flex items-center gap-2 cursor-pointer pb-2">
            <input
              type="checkbox"
              checked={useTls}
              onChange={(e) => { setUseTls(e.target.checked); setDirty(true); setTestResult(null); }}
              className="accent-sky-500"
            />
            <span className="text-xs text-slate-700">Use STARTTLS (leave on unless using a port-25 relay)</span>
          </label>
        </div>

        {/* Actions */}
        <div className="flex gap-2">
          <button
            onClick={() => void handleTest()}
            disabled={testEmail.isPending || !config?.configured || dirty}
            title={dirty ? 'Save your changes first' : 'Send yourself a test email'}
            className="text-xs px-3 py-2 rounded-lg border border-slate-300 text-slate-700 hover:border-slate-500 hover:text-slate-900 disabled:opacity-50"
          >
            {testEmail.isPending ? 'Sending…' : 'Send test email'}
          </button>
          <button
            onClick={() => void handleSave()}
            disabled={updateConfig.isPending || !dirty}
            className="text-xs px-4 py-2 rounded-lg border border-border bg-amber-400 hover:bg-amber-500 text-slate-900 font-semibold shadow-retro disabled:opacity-50"
          >
            {updateConfig.isPending ? 'Saving…' : 'Save'}
          </button>
        </div>

        {testResult && (
          <p className={`text-xs rounded px-3 py-2 border ${
            testResult.ok
              ? 'text-emerald-700 bg-emerald-50 border-emerald-200'
              : 'text-red-700 bg-red-50 border-red-200'
          }`}>
            {testResult.msg}
          </p>
        )}

        {!isLoading && !config?.configured && !testResult && (
          <p className="text-xs text-slate-500 bg-slate-50 border border-slate-200 rounded px-3 py-2">
            No mail server connected yet. Until you add one, team invitations still work — WatchTower
            gives you a secure link to share manually. Add SMTP here to have invitations delivered by
            email automatically. Pick a provider above, fill in your credentials, then Save → Send test email.
          </p>
        )}
        {config?.source === 'env' && (
          <p className="text-[11px] text-slate-400">
            Currently configured via environment variables — saving here overrides them.
          </p>
        )}
      </div>
    </div>
  );
}
