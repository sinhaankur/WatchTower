import { useEffect, useState } from 'react';
import apiClient from '@/lib/api';

type VSCodeStatus = {
  installed: boolean;
  version: string | null;
  root_dir: string;
  install_instructions: { linux: string; macos: string; windows: string };
};

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      onClick={() => { void navigator.clipboard.writeText(text); setCopied(true); setTimeout(() => setCopied(false), 1800); }}
      className="text-[10px] px-2 py-0.5 rounded border border-slate-300 hover:border-slate-500 text-slate-500 hover:text-slate-800 transition-colors"
    >
      {copied ? 'Copied!' : 'Copy'}
    </button>
  );
}

function VSCodeCard() {
  const [status, setStatus] = useState<VSCodeStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [openLoading, setOpenLoading] = useState(false);
  const [openResult, setOpenResult] = useState<{ ok: boolean; msg: string } | null>(null);

  useEffect(() => {
    apiClient.get<VSCodeStatus>('/runtime/integrations/vscode/status')
      .then((r) => setStatus(r.data))
      .catch(() => setStatus(null))
      .finally(() => setLoading(false));
  }, []);

  const openRoot = async () => {
    if (!status) return;
    setOpenLoading(true);
    setOpenResult(null);
    try {
      await apiClient.post('/runtime/integrations/vscode/open', { path: status.root_dir });
      setOpenResult({ ok: true, msg: `Opened ${status.root_dir} in VS Code` });
    } catch (e: unknown) {
      const msg = (e as { response?: { data?: { detail?: string } } })?.response?.data?.detail ?? 'Failed to open VS Code';
      setOpenResult({ ok: false, msg });
    } finally {
      setOpenLoading(false);
    }
  };

  const os = navigator.userAgent.includes('Mac') ? 'macos' : navigator.userAgent.includes('Win') ? 'windows' : 'linux';

  return (
    <div className="rounded-xl border border-slate-800 bg-card p-5 shadow-[2px_2px_0_0_#1f2937]">
      {/* Header */}
      <div className="flex items-center gap-3 mb-4">
        <div className="w-9 h-9 rounded-lg border border-slate-800 bg-[#007ACC] flex items-center justify-center shadow-[1px_1px_0_0_#1f2937]">
          <svg width="18" height="18" viewBox="0 0 100 100" fill="none">
            <path d="M74.9 13.3L51.7 38.6 31.4 22.6 13.3 33.2v33.6l18.1 10.6 20.3-16 23.2 25.3L87 75.5V24.5L74.9 13.3zM31.4 60.8l-9-5.4V44.6l9-5.4 13 10.8-13 10.8z" fill="white"/>
          </svg>
        </div>
        <div>
          <h2 className="text-sm font-semibold text-slate-900">VS Code Integration</h2>
          <p className="text-xs text-slate-500">Connect your editor to WatchTower projects</p>
        </div>
        {!loading && (
          <span className={`ml-auto text-xs px-2 py-0.5 rounded-full border font-medium ${
            status?.installed
              ? 'border-emerald-300 bg-emerald-50 text-emerald-700'
              : 'border-amber-300 bg-amber-50 text-amber-700'
          }`}>
            {status?.installed ? `Installed · ${status.version ?? 'VS Code'}` : 'Not detected on host'}
          </span>
        )}
      </div>

      {/* Two-column grid */}
      <div className="grid md:grid-cols-2 gap-4">

        {/* Open project on server */}
        <div className="rounded-lg border border-border bg-muted/20 p-4 space-y-3">
          <p className="text-xs font-semibold text-slate-800 uppercase tracking-wide">Open on Server</p>
          <p className="text-xs text-slate-600">
            Launch VS Code on the WatchTower host machine via the <code className="font-mono bg-slate-100 px-1 rounded">code</code> CLI.
            Works when VS Code is installed server-side (e.g., SSH session or local machine).
          </p>
          {status && (
            <div className="flex items-center gap-2 p-2 rounded bg-slate-50 border border-border">
              <code className="text-[11px] font-mono text-slate-700 flex-1 truncate">{status.root_dir}</code>
              <CopyButton text={`code ${status.root_dir}`} />
            </div>
          )}
          <button
            onClick={() => void openRoot()}
            disabled={openLoading || !status?.installed}
            className="w-full py-2 rounded-lg border border-slate-800 bg-red-700 hover:bg-red-800 text-white text-xs font-semibold shadow-[2px_2px_0_0_#1f2937] transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {openLoading ? 'Opening…' : 'Open WatchTower in VS Code'}
          </button>
          {openResult && (
            <p className={`text-xs ${openResult.ok ? 'text-emerald-700' : 'text-red-600'}`}>{openResult.msg}</p>
          )}
        </div>

        {/* Deep link / client-side */}
        <div className="rounded-lg border border-border bg-muted/20 p-4 space-y-3">
          <p className="text-xs font-semibold text-slate-800 uppercase tracking-wide">Open via Browser Deep Link</p>
          <p className="text-xs text-slate-600">
            Open any GitHub repo or local folder directly in your <em>local</em> VS Code
            using the <code className="font-mono bg-slate-100 px-1 rounded">vscode://</code> URL scheme.
          </p>
          <div className="space-y-2">
            <div>
              <p className="text-[10px] text-slate-500 mb-1">Repo → Clone in VS Code</p>
              <div className="flex items-center gap-2 p-2 rounded bg-slate-50 border border-border">
                <code className="text-[10px] font-mono text-slate-600 flex-1 truncate">vscode://vscode.git/clone?url=https://github.com/…</code>
                <CopyButton text="vscode://vscode.git/clone?url=https://github.com/owner/repo" />
              </div>
            </div>
            <div>
              <p className="text-[10px] text-slate-500 mb-1">Local folder</p>
              <div className="flex items-center gap-2 p-2 rounded bg-slate-50 border border-border">
                <code className="text-[10px] font-mono text-slate-600 flex-1 truncate">vscode://file/path/to/folder</code>
                <CopyButton text="vscode://file/path/to/folder" />
              </div>
            </div>
          </div>
          <p className="text-[10px] text-slate-500">
            Your project cards show an <strong>"Open in VS Code"</strong> button using these links automatically.
          </p>
        </div>

        {/* Remote SSH */}
        <div className="rounded-lg border border-border bg-muted/20 p-4 space-y-3">
          <p className="text-xs font-semibold text-slate-800 uppercase tracking-wide">Remote — SSH</p>
          <p className="text-xs text-slate-600">
            Edit files directly on the WatchTower host using VS Code Remote — SSH extension.
            Install it from the VS Code marketplace, then connect to your host.
          </p>
          <div className="space-y-1.5">
            {[
              { step: '1', text: 'Install "Remote - SSH" extension in VS Code' },
              { step: '2', text: 'Press ⌘/Ctrl+Shift+P → "Remote-SSH: Connect to Host"' },
              { step: '3', text: 'Enter: user@your-watchtower-host' },
              { step: '4', text: 'Open /path/to/your/project in the remote window' },
            ].map(({ step, text }) => (
              <div key={step} className="flex items-start gap-2">
                <span className="w-4 h-4 rounded bg-amber-400 text-slate-900 text-[10px] font-bold flex items-center justify-center shrink-0 mt-0.5">{step}</span>
                <p className="text-xs text-slate-700">{text}</p>
              </div>
            ))}
          </div>
          <a
            href="vscode:extension/ms-vscode-remote.remote-ssh"
            className="inline-flex items-center gap-1.5 text-xs text-red-700 hover:text-red-800 font-medium"
          >
            Install Remote — SSH →
          </a>
        </div>

        {/* Install instructions */}
        {!loading && !status?.installed && (
          <div className="rounded-lg border border-amber-300 bg-amber-50 p-4 space-y-2">
            <p className="text-xs font-semibold text-amber-800 uppercase tracking-wide">Install VS Code on Host</p>
            <p className="text-xs text-amber-700">{status?.install_instructions[os] ?? 'Visit https://code.visualstudio.com/download'}</p>
            <div className="flex items-center gap-2 p-2 rounded bg-white border border-amber-200 mt-1">
              <code className="text-[11px] font-mono text-slate-700 flex-1">sudo snap install --classic code</code>
              <CopyButton text="sudo snap install --classic code" />
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

const Settings = () => (
  <div className="flex-1 overflow-auto bg-slate-50">
    <header
      className="px-4 sm:px-6 lg:px-8 py-4 border-b"
      style={{ borderColor: 'hsl(214 32% 88%)' }}
    >
      <h1 className="text-lg font-semibold text-slate-900">Settings</h1>
      <p className="text-xs text-slate-600 mt-0.5">Configure your WatchTower instance</p>
    </header>

    <main className="px-4 sm:px-6 lg:px-8 py-6 max-w-4xl mx-auto w-full space-y-4">

      {/* VS Code Integration — prominent card */}
      <VSCodeCard />

      {/* Other settings groups */}
      {[
        { title: 'General', items: ['Instance name', 'Default branch', 'Build timeout'] },
        { title: 'Authentication', items: ['GitHub OAuth', 'API tokens', 'Team access'] },
        { title: 'Notifications', items: ['Email alerts', 'Discord webhook', 'Slack webhook'] },
        { title: 'Backups', items: ['S3-compatible backup', 'Backup schedule', 'Retention policy'] },
      ].map(({ title, items }) => (
        <div key={title} className="rounded-xl border border-border bg-card p-5">
          <h2 className="text-sm font-semibold text-slate-900 mb-3">{title}</h2>
          <div className="space-y-2">
            {items.map((item) => (
              <div key={item}
                className="flex items-center justify-between p-3 rounded-lg bg-muted/30 hover:bg-muted/50 transition-colors cursor-pointer">
                <span className="text-sm text-slate-900">{item}</span>
                <span className="text-xs text-slate-600">Configure →</span>
              </div>
            ))}
          </div>
        </div>
      ))}
    </main>
  </div>
);

export default Settings;
