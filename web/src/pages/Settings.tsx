import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import apiClient from '@/lib/api';
import {
  useVSCodeStatus,
  useUpdateCheck,
  isAutoUpdateCheckEnabled,
  setAutoUpdateCheckEnabled,
  queryKeys,
} from '@/hooks/queries';

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
  // React Query handles fetch / cache / loading / error / unmount-cancel.
  // status is undefined while loading, then either the payload or undefined on error.
  const { data: status, isLoading: loading } = useVSCodeStatus();
  const [openLoading, setOpenLoading] = useState(false);
  const [openResult, setOpenResult] = useState<{ ok: boolean; msg: string } | null>(null);

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

function UpdateCheckCard() {
  const [autoCheck, setAutoCheckState] = useState<boolean>(() => isAutoUpdateCheckEnabled());
  const qc = useQueryClient();
  const { data, isFetching, refetch, error } = useUpdateCheck({ autoCheck });

  const handleToggleAuto = (next: boolean) => {
    setAutoCheckState(next);
    setAutoUpdateCheckEnabled(next);
    if (next) void refetch();
  };

  const handleCheckNow = async () => {
    // Force a live re-fetch from GitHub (backend bypasses its hourly cache
    // when force=true), then warm the regular query so the banner / card
    // update without an extra round-trip.
    const fresh = (await apiClient.get(`/runtime/version?force=true`)).data;
    qc.setQueryData(queryKeys.updateCheck, fresh);
  };

  const current = data?.current ?? '—';
  const latest = data?.latest;
  const checked = data?.checked_at ? new Date(data.checked_at).toLocaleString() : null;

  return (
    <div className="rounded-xl border border-slate-800 bg-card p-5 shadow-[2px_2px_0_0_#1f2937]">
      <div className="flex items-center gap-3 mb-4">
        <div className="w-9 h-9 rounded-lg border border-slate-800 bg-slate-900 flex items-center justify-center shadow-[1px_1px_0_0_#1f2937]">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="23 4 23 10 17 10" />
            <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
          </svg>
        </div>
        <div className="flex-1 min-w-0">
          <h2 className="text-sm font-semibold text-slate-900">WatchTower Updates</h2>
          <p className="text-xs text-slate-500">
            Current version <span className="font-mono text-slate-700">{current}</span>
            {latest && latest !== current && (
              <> · Latest <span className="font-mono text-slate-700">{latest}</span></>
            )}
          </p>
        </div>
        {data?.has_update ? (
          <span className="text-xs px-2 py-0.5 rounded-full border font-medium border-amber-300 bg-amber-50 text-amber-800">
            Update available
          </span>
        ) : data?.latest ? (
          <span className="text-xs px-2 py-0.5 rounded-full border font-medium border-emerald-300 bg-emerald-50 text-emerald-700">
            Up to date
          </span>
        ) : null}
      </div>

      {data?.has_update && data.release_url && (
        <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 mb-3 flex items-start gap-3">
          <div className="flex-1">
            <p className="text-xs text-amber-900">
              <strong>{data.release_name ?? `v${data.latest}`}</strong> is available.
            </p>
            <p className="text-[11px] text-amber-800 mt-0.5">
              Review the release notes before updating.
            </p>
          </div>
          <a
            href={data.release_url}
            target="_blank"
            rel="noopener noreferrer"
            className="text-xs px-3 py-1.5 rounded-lg border border-amber-700 bg-white text-amber-800 hover:bg-amber-100 font-medium"
          >
            Release notes →
          </a>
        </div>
      )}

      {error && (
        <p className="text-xs text-red-600 mb-3">
          Could not reach GitHub to check for updates.
        </p>
      )}
      {data?.error && (
        <p className="text-xs text-amber-700 mb-3">{data.error}</p>
      )}

      <div className="flex flex-wrap items-center justify-between gap-3">
        <label className="flex items-center gap-2 text-xs text-slate-700 cursor-pointer select-none">
          <input
            type="checkbox"
            checked={autoCheck}
            onChange={(e) => handleToggleAuto(e.target.checked)}
            className="w-3.5 h-3.5 accent-slate-800"
          />
          Check for updates automatically
        </label>
        <div className="flex items-center gap-3">
          {checked && (
            <span className="text-[11px] text-slate-500" title={`Last checked ${checked}`}>
              Checked {checked}
            </span>
          )}
          <button
            onClick={() => void handleCheckNow()}
            disabled={isFetching}
            className="text-xs px-3 py-1.5 rounded-lg border border-slate-800 bg-white hover:bg-slate-50 text-slate-800 font-medium shadow-[1px_1px_0_0_#1f2937] disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {isFetching ? 'Checking…' : 'Check for Updates'}
          </button>
        </div>
      </div>
    </div>
  );
}

const Settings = () => {
  const [showReportModal, setShowReportModal] = useState(false);

  return (
    <div className="flex-1 overflow-auto bg-slate-50">
      <header
        className="px-4 sm:px-6 lg:px-8 py-4 border-b flex items-center justify-between"
        style={{ borderColor: 'hsl(214 32% 88%)' }}
      >
        <div>
          <h1 className="text-lg font-semibold text-slate-900">Settings</h1>
          <p className="text-xs text-slate-600 mt-0.5">Configure your WatchTower instance</p>
        </div>
        <button
          onClick={() => setShowReportModal(true)}
          className="text-xs px-3 py-1.5 rounded border border-slate-300 text-slate-600 hover:text-slate-900 hover:border-slate-400 transition-colors"
          title="Report a problem or send feedback"
        >
          Report Problem
        </button>
      </header>

      <main className="px-4 sm:px-6 lg:px-8 py-6 max-w-4xl mx-auto w-full space-y-4">

        {/* WatchTower version + update check */}
        <UpdateCheckCard />

        {/* VS Code Integration — prominent card */}
        <VSCodeCard />

      </main>

      {/* Report Problem Modal */}
      {showReportModal && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center p-4 z-50">
          <div className="bg-white rounded-lg shadow-lg max-w-md w-full p-6 space-y-4">
            <div className="flex items-start gap-3">
              <div className="w-10 h-10 rounded-lg border border-slate-800 bg-red-700 flex items-center justify-center flex-shrink-0">
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2">
                  <path d="M10 19l-7-7m0 0l7-7m-7 7h18.5" />
                </svg>
              </div>
              <div>
                <h3 className="font-semibold text-slate-900">Report Problem</h3>
                <p className="text-xs text-slate-500 mt-0.5">Help us improve WatchTower</p>
              </div>
            </div>

            <p className="text-sm text-slate-700">
              Found an issue or have feedback? We'd love to hear from you.
            </p>

            <div className="bg-slate-50 rounded-lg p-3 space-y-2">
              <p className="text-xs font-medium text-slate-900">Contact Support:</p>
              <a
                href="mailto:sinhaankur827@gmail.com?subject=WatchTower%20Problem%20Report"
                className="flex items-center gap-2 text-sm text-red-700 hover:text-red-800 font-medium"
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z" />
                  <polyline points="22,6 12,13 2,6" />
                </svg>
                sinhaankur827@gmail.com
              </a>
            </div>

            <div className="flex gap-2 pt-2">
              <button
                onClick={() => setShowReportModal(false)}
                className="flex-1 py-2 px-3 rounded-lg border border-slate-300 text-slate-700 hover:bg-slate-50 text-sm font-medium transition-colors"
              >
                Close
              </button>
              <a
                href="mailto:sinhaankur827@gmail.com?subject=WatchTower%20Problem%20Report"
                className="flex-1 py-2 px-3 rounded-lg bg-red-700 text-white hover:bg-red-800 text-sm font-medium transition-colors text-center"
              >
                Send Report
              </a>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default Settings;
