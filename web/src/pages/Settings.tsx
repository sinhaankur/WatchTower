import { useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import apiClient from '@/lib/api';
import {
  useVSCodeStatus,
  useUpdateCheck,
  isAutoUpdateCheckEnabled,
  setAutoUpdateCheckEnabled,
  queryKeys,
} from '@/hooks/queries';

type DependencyStatus = {
  platform: string;
  arch: string;
  appVersion: string;
  python: { found: boolean; command: string | null; version: string | null; isStub: boolean };
  podman: { found: boolean; version: string | null; source: string | null };
  dataDir: string;
  backendLogPath: string | null;
};

type NixpacksStatus = {
  available: boolean;
  source: string;
  path: string | null;
  version: string | null;
  expected_version: string;
  version_drift: boolean;
  platform_supported: boolean;
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
  const [updating, setUpdating] = useState(false);
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

  const handleUpdateNow = async () => {
    if (!data?.has_update) return;
    const electron = (window as any).electronAPI;
    if (electron?.updateNow) {
      setUpdating(true);
      try {
        await electron.updateNow(data.release_url);
      } finally {
        setUpdating(false);
      }
      return;
    }
    // Browser / non-Electron: send the user to the release page.
    if (data.release_url) window.open(data.release_url, '_blank', 'noopener,noreferrer');
  };

  const isElectron = typeof window !== 'undefined' && Boolean((window as any).electronAPI);

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

      {data?.has_update && (
        <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 mb-3 flex items-start gap-3">
          <div className="flex-1">
            <p className="text-xs text-amber-900">
              <strong>{data.release_name ?? `v${data.latest}`}</strong> is available.
            </p>
            <p className="text-[11px] text-amber-800 mt-0.5">
              {isElectron
                ? 'Click Update Now to download and install in the background — the app will restart when ready.'
                : 'Open the release page to download the new build.'}
            </p>
          </div>
          {data.release_url && (
            <a
              href={data.release_url}
              target="_blank"
              rel="noopener noreferrer"
              className="text-xs px-3 py-1.5 rounded-lg border border-amber-700 bg-white text-amber-800 hover:bg-amber-100 font-medium shrink-0"
            >
              Release notes →
            </a>
          )}
          <button
            type="button"
            onClick={() => void handleUpdateNow()}
            disabled={updating}
            className="text-xs px-3 py-1.5 rounded-lg border border-amber-800 bg-amber-700 hover:bg-amber-800 text-white font-semibold shadow-[1px_1px_0_0_#92400e] disabled:opacity-60 disabled:cursor-wait shrink-0"
          >
            {updating ? 'Updating…' : isElectron ? 'Update Now' : 'Open release →'}
          </button>
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

// Install commands surfaced in the System tab when Python is missing
// or the watchtower-podman package isn't importable.
//
// We use pipx on macOS + Linux because raw `pip install --user` fails
// on PEP 668 systems (Ubuntu 24.04+, Debian 12+, Fedora 38+, brew
// Python 3.13+) with "externally-managed-environment". pipx is the
// modern recommended path for installing Python applications without
// touching the system Python — same isolation, same end result, but
// works on every distro since 2023.
//
// Windows is unchanged; the python.org installer doesn't enforce PEP 668.
function pythonInstallCommand(platform: string): string {
  if (platform === 'darwin') return 'brew install pipx && pipx install watchtower-podman';
  if (platform === 'win32') return 'py -3 -m pip install watchtower-podman';
  return 'sudo apt install -y python3 pipx && pipx install watchtower-podman';
}

function podmanInstallCommand(platform: string): string {
  if (platform === 'darwin') return 'brew install podman && podman machine init && podman machine start';
  if (platform === 'win32') return 'winget install -e --id RedHat.Podman';
  return 'sudo apt install -y podman';
}

function nixpacksInstallCommand(platform: string): string {
  if (platform === 'darwin') return 'brew install nixpacks';
  if (platform === 'win32') return '# Nixpacks does not ship a Windows binary — use WSL2 or run from a Linux/macOS host.';
  return 'curl -sSL https://nixpacks.com/install.sh | bash';
}

type DepRowProps = {
  label: string;
  found: boolean;
  detail?: string | null;
  installCmd?: string;
  hint?: string;
  required: boolean;
};

function DepRow({ label, found, detail, installCmd, hint, required }: DepRowProps) {
  const okBadge = (
    <span className="text-[10px] px-2 py-0.5 rounded-full border font-medium border-emerald-300 bg-emerald-50 text-emerald-700">
      Found
    </span>
  );
  const missingBadge = (
    <span className={`text-[10px] px-2 py-0.5 rounded-full border font-medium ${
      required
        ? 'border-red-300 bg-red-50 text-red-700'
        : 'border-amber-300 bg-amber-50 text-amber-700'
    }`}>
      {required ? 'Missing (required)' : 'Missing (optional)'}
    </span>
  );

  return (
    <div className="rounded-lg border border-border bg-muted/20 p-4 space-y-2">
      <div className="flex items-center gap-2">
        <p className="text-xs font-semibold text-slate-800 uppercase tracking-wide flex-1">{label}</p>
        {found ? okBadge : missingBadge}
      </div>
      {detail && <p className="text-[11px] font-mono text-slate-700 truncate" title={detail}>{detail}</p>}
      {hint && <p className="text-[11px] text-slate-600">{hint}</p>}
      {!found && installCmd && (
        <div className="flex items-center gap-2 p-2 rounded bg-slate-50 border border-border">
          <code className="text-[11px] font-mono text-slate-700 flex-1 truncate" title={installCmd}>
            {installCmd}
          </code>
          <CopyButton text={installCmd} />
        </div>
      )}
    </div>
  );
}

function SystemCard() {
  const electron = (typeof window !== 'undefined' ? (window as unknown as { electronAPI?: {
    getDependencyStatus?: () => Promise<DependencyStatus>;
    relaunchApp?: () => Promise<unknown>;
    openErrorReport?: (payload: { message?: string }) => Promise<{ ok: boolean; error?: string }>;
  } }).electronAPI : undefined);

  const [dep, setDep] = useState<DependencyStatus | null>(null);
  const [nixpacks, setNixpacks] = useState<NixpacksStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [reportSending, setReportSending] = useState(false);
  const [reportResult, setReportResult] = useState<{ ok: boolean; msg: string } | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const [d, n] = await Promise.all([
          electron?.getDependencyStatus?.() ?? Promise.resolve(null),
          apiClient.get('/runtime/nixpacks-status').then(r => r.data as NixpacksStatus).catch(() => null),
        ]);
        if (cancelled) return;
        setDep(d ?? null);
        setNixpacks(n);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [electron]);

  const handleRecheck = async () => {
    if (electron?.relaunchApp) {
      await electron.relaunchApp();
      // App will quit; nothing else to do.
      return;
    }
    // Browser fallback: just reload, it's the closest thing to a relaunch we have.
    window.location.reload();
  };

  const handleSendReport = async () => {
    setReportSending(true);
    setReportResult(null);
    try {
      if (electron?.openErrorReport) {
        const res = await electron.openErrorReport({});
        setReportResult(res.ok
          ? { ok: true, msg: 'Mail client opened with diagnostics — review and send.' }
          : { ok: false, msg: res.error ?? 'Could not open mail client.' });
      } else {
        // Browser fallback: plain mailto without diagnostics.
        window.open('mailto:sinhaankur@ymail.com?subject=WatchTower%20bug%20report', '_blank');
        setReportResult({ ok: true, msg: 'Mail client opened.' });
      }
    } finally {
      setReportSending(false);
    }
  };

  const platform = dep?.platform ?? (
    typeof navigator !== 'undefined'
      ? (navigator.userAgent.includes('Mac') ? 'darwin' : navigator.userAgent.includes('Win') ? 'win32' : 'linux')
      : 'linux'
  );

  return (
    <div className="rounded-xl border border-slate-800 bg-card p-5 shadow-[2px_2px_0_0_#1f2937]">
      <div className="flex items-center gap-3 mb-4">
        <div className="w-9 h-9 rounded-lg border border-slate-800 bg-slate-900 flex items-center justify-center shadow-[1px_1px_0_0_#1f2937]">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
            <rect x="3" y="3" width="18" height="18" rx="2" />
            <path d="M9 9h6v6H9z" />
          </svg>
        </div>
        <div className="flex-1 min-w-0">
          <h2 className="text-sm font-semibold text-slate-900">System</h2>
          <p className="text-xs text-slate-500">
            {dep
              ? <>WatchTower {dep.appVersion} · {dep.platform} ({dep.arch})</>
              : 'Dependencies and diagnostics'}
          </p>
        </div>
        {!electron && (
          <span className="text-[10px] px-2 py-0.5 rounded-full border font-medium border-slate-300 bg-slate-50 text-slate-600">
            Browser mode
          </span>
        )}
      </div>

      {loading && <p className="text-xs text-slate-500">Probing system…</p>}

      {!loading && (
        <>
          <div className="grid md:grid-cols-2 gap-3 mb-4">
            <DepRow
              label="Python 3.8+"
              required
              found={dep?.python.found ?? false}
              detail={dep?.python.command ? `${dep.python.command}${dep.python.version ? ` · ${dep.python.version}` : ''}` : null}
              hint={dep?.python.isStub
                ? 'macOS Command Line Tools placeholder detected — install a real Python below.'
                : !dep?.python.found ? 'Required to run the WatchTower backend.' : undefined}
              installCmd={pythonInstallCommand(platform)}
            />

            <DepRow
              label="Container runtime"
              required={false}
              found={dep?.podman.found ?? false}
              detail={dep?.podman.found ? `${dep.podman.source} · ${dep.podman.version}` : null}
              hint={!dep?.podman.found ? 'Optional. Needed for local container builds and the App Center deploy flow.' : undefined}
              installCmd={podmanInstallCommand(platform)}
            />

            <DepRow
              label="Nixpacks"
              required={false}
              found={nixpacks?.available ?? false}
              detail={nixpacks?.available
                ? `${nixpacks.source}${nixpacks.version ? ` · ${nixpacks.version}` : ''}${nixpacks.version_drift ? ` (expected ${nixpacks.expected_version})` : ''}`
                : null}
              hint={!nixpacks?.platform_supported
                ? 'Nixpacks does not publish a Windows binary — use WSL2 or run from Linux/macOS.'
                : !nixpacks?.available
                  ? 'Optional. Auto-detects buildpacks for projects without a Dockerfile.'
                  : undefined}
              installCmd={nixpacks?.platform_supported === false ? undefined : nixpacksInstallCommand(platform)}
            />

            {dep?.backendLogPath && (
              <div className="rounded-lg border border-border bg-muted/20 p-4 space-y-2">
                <p className="text-xs font-semibold text-slate-800 uppercase tracking-wide">Backend log</p>
                <div className="flex items-center gap-2 p-2 rounded bg-slate-50 border border-border">
                  <code className="text-[11px] font-mono text-slate-700 flex-1 truncate" title={dep.backendLogPath}>
                    {dep.backendLogPath}
                  </code>
                  <CopyButton text={dep.backendLogPath} />
                </div>
                <p className="text-[11px] text-slate-600">
                  Attached automatically when you send an error report.
                </p>
              </div>
            )}
          </div>

          <div className="flex flex-wrap items-center justify-between gap-3 pt-3 border-t border-slate-200">
            <div className="flex flex-col">
              <p className="text-xs text-slate-700">
                Installed something just now? Recheck restarts the app so PATH refreshes.
              </p>
              {reportResult && (
                <p className={`text-[11px] mt-1 ${reportResult.ok ? 'text-emerald-700' : 'text-red-600'}`}>
                  {reportResult.msg}
                </p>
              )}
            </div>
            <div className="flex items-center gap-2">
              <button
                onClick={() => void handleSendReport()}
                disabled={reportSending}
                className="text-xs px-3 py-1.5 rounded-lg border border-slate-800 bg-white hover:bg-slate-50 text-slate-800 font-medium shadow-[1px_1px_0_0_#1f2937] disabled:opacity-50"
                title="Open mail client with diagnostics pre-filled — sent to the maintainer for fixing."
              >
                {reportSending ? 'Opening…' : 'Send Error Report'}
              </button>
              <button
                onClick={() => void handleRecheck()}
                className="text-xs px-3 py-1.5 rounded-lg border border-slate-800 bg-amber-400 hover:bg-amber-500 text-slate-900 font-semibold shadow-[1px_1px_0_0_#1f2937]"
              >
                Recheck (restarts app)
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

type BackupStatus = {
  supported: boolean;
  reason_unsupported: string | null;
  has_secret_key: boolean;
  has_database_file: boolean;
  ready_for_backup: boolean;
  can_export: boolean;
};

function BackupCard() {
  const [status, setStatus] = useState<BackupStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [downloading, setDownloading] = useState(false);
  const [downloadError, setDownloadError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void apiClient
      .get('/runtime/backup/status')
      .then(r => { if (!cancelled) setStatus(r.data); })
      .catch(() => { if (!cancelled) setStatus(null); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, []);

  const handleDownload = async () => {
    setDownloading(true);
    setDownloadError(null);
    try {
      // Need responseType: blob so axios doesn't try to JSON-parse the
      // gzip stream. Filename comes from the Content-Disposition header
      // the backend sets.
      const r = await apiClient.get('/runtime/backup/export', { responseType: 'blob' });
      const disposition = r.headers['content-disposition'] as string | undefined;
      const match = disposition?.match(/filename="?([^"]+)"?/);
      const filename = match?.[1] ?? 'watchtower-backup.tar.gz';
      const blob = new Blob([r.data], { type: 'application/gzip' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (e) {
      const msg = (e as { response?: { data?: { detail?: string } } })?.response?.data?.detail
        ?? 'Could not download backup. Check the System log.';
      setDownloadError(msg);
    } finally {
      setDownloading(false);
    }
  };

  return (
    <div className="rounded-xl border border-slate-800 bg-card p-5 shadow-[2px_2px_0_0_#1f2937]">
      <div className="flex items-center gap-3 mb-4">
        <div className="w-9 h-9 rounded-lg border border-slate-800 bg-slate-900 flex items-center justify-center shadow-[1px_1px_0_0_#1f2937]">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
            <polyline points="7 10 12 15 17 10" />
            <line x1="12" y1="15" x2="12" y2="3" />
          </svg>
        </div>
        <div className="flex-1 min-w-0">
          <h2 className="text-sm font-semibold text-slate-900">Backup & Restore</h2>
          <p className="text-xs text-slate-500">
            Export the encryption key + database so you can recover from disk loss.
          </p>
        </div>
      </div>

      {loading && <p className="text-xs text-slate-500">Checking backup status…</p>}

      {!loading && status && !status.supported && (
        <div className="rounded-lg border border-amber-300 bg-amber-50 p-3">
          <p className="text-xs text-amber-800">
            This install uses a non-SQLite database. Use your database's native backup tool
            (e.g. <code className="font-mono bg-white px-1 rounded">pg_dump</code>) and back up
            <code className="font-mono bg-white px-1 rounded">~/.watchtower/secret.key</code> separately.
            In-app backup is SQLite-only in v1.
          </p>
        </div>
      )}

      {!loading && status && status.supported && (
        <>
          <div className="rounded-lg border border-amber-300 bg-amber-50 p-3 mb-3">
            <p className="text-xs text-amber-900 font-medium">⚠ Contains credentials</p>
            <p className="text-[11px] text-amber-800 mt-0.5">
              The backup file contains your Fernet encryption key plus the SQLite database
              with all encrypted secrets (GitHub PATs, SSH keys, env var values). Store it
              somewhere as secure as your password manager — anyone with this file can
              decrypt every secret on this install.
            </p>
          </div>

          <div className="grid sm:grid-cols-2 gap-3">
            <div className="rounded-lg border border-border bg-muted/20 p-3 space-y-2">
              <p className="text-xs font-semibold text-slate-800 uppercase tracking-wide">Backup contents</p>
              <ul className="text-[11px] text-slate-700 space-y-1">
                <li>{status.has_secret_key ? '✓' : '○'} <code className="font-mono">secret.key</code> (Fernet master key)</li>
                <li>{status.has_database_file ? '✓' : '○'} <code className="font-mono">watchtower.db</code> (SQLite database)</li>
              </ul>
              {!status.ready_for_backup && (
                <p className="text-[11px] text-slate-500 italic">
                  Fresh install — nothing to back up yet. Create a project or sign in to populate state.
                </p>
              )}
            </div>

            <div className="rounded-lg border border-border bg-muted/20 p-3 space-y-2">
              <p className="text-xs font-semibold text-slate-800 uppercase tracking-wide">Restore (manual)</p>
              <p className="text-[11px] text-slate-700">
                Restore is manual in v1. Stop WatchTower, extract the tarball over your{' '}
                <code className="font-mono">~/.watchtower/</code> directory, restart.
              </p>
              <code className="block text-[10px] font-mono bg-slate-100 rounded px-2 py-1 text-slate-700">
                tar -xzf watchtower-backup-*.tar.gz -C ~/.watchtower/
              </code>
            </div>
          </div>

          <div className="flex flex-wrap items-center justify-between gap-3 pt-3 border-t border-slate-200 mt-3">
            {downloadError && <p className="text-xs text-red-600 flex-1">{downloadError}</p>}
            {!downloadError && (
              <p className="text-xs text-slate-500 flex-1">
                Suggested cadence: once a week, or after every major project change.
              </p>
            )}
            <button
              onClick={() => void handleDownload()}
              disabled={downloading || !status.ready_for_backup || !status.can_export}
              className="text-xs px-3 py-1.5 rounded-lg border border-slate-800 bg-amber-400 hover:bg-amber-500 text-slate-900 font-semibold shadow-[1px_1px_0_0_#1f2937] disabled:opacity-50 disabled:cursor-not-allowed"
              title={
                !status.can_export
                  ? "Requires can_manage_team permission on this org"
                  : !status.ready_for_backup
                    ? "No state to back up yet — create a project first"
                    : "Download a tarball with secret.key + watchtower.db"
              }
            >
              {downloading ? 'Preparing…' : 'Download backup'}
            </button>
          </div>
        </>
      )}
    </div>
  );
}

const Settings = () => {
  const [showReportModal, setShowReportModal] = useState(false);
  const [reportNote, setReportNote] = useState('');
  const [reportSending, setReportSending] = useState(false);

  const electron = (typeof window !== 'undefined' ? (window as unknown as { electronAPI?: {
    openErrorReport?: (payload: { message?: string }) => Promise<{ ok: boolean; error?: string }>;
  } }).electronAPI : undefined);

  const handleSendReport = async () => {
    setReportSending(true);
    try {
      if (electron?.openErrorReport) {
        await electron.openErrorReport({ message: reportNote });
      } else {
        const subject = encodeURIComponent('WatchTower bug report');
        const body = encodeURIComponent(reportNote || '');
        window.open(`mailto:sinhaankur@ymail.com?subject=${subject}&body=${body}`, '_blank');
      }
      setShowReportModal(false);
      setReportNote('');
    } finally {
      setReportSending(false);
    }
  };

  return (
    <div className="flex-1 overflow-auto bg-slate-50">
      <header
        className="px-4 sm:px-6 lg:px-8 py-4 border-b flex items-center justify-between"
        style={{ borderColor: 'hsl(var(--border-soft))' }}
      >
        <div>
          <h1 className="text-lg font-semibold text-slate-900">Settings</h1>
          <p className="text-xs text-slate-600 mt-0.5">Configure your WatchTower instance</p>
        </div>
        <button
          onClick={() => setShowReportModal(true)}
          className="text-xs px-3 py-1.5 rounded border border-slate-300 text-slate-600 hover:text-slate-900 hover:border-slate-400 transition-colors"
          title="Send a bug report with diagnostics attached"
        >
          Send Error Report
        </button>
      </header>

      <main className="px-4 sm:px-6 lg:px-8 py-6 max-w-4xl mx-auto w-full space-y-4">

        {/* WatchTower version + update check */}
        <UpdateCheckCard />

        {/* System dependencies + diagnostics */}
        <SystemCard />

        {/* Backup & restore for ~/.watchtower/ */}
        <BackupCard />

        {/* VS Code Integration — prominent card */}
        <VSCodeCard />

      </main>

      {/* Report Problem Modal — opens user's mail client with diagnostics
          pre-filled (Electron) or a plain mailto (browser). Sends to
          sinhaankur@ymail.com so the maintainer gets the bug + system
          info in one go. */}
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
                <h3 className="font-semibold text-slate-900">Send Error Report</h3>
                <p className="text-xs text-slate-500 mt-0.5">
                  {electron
                    ? 'System info + recent backend log are attached automatically.'
                    : 'Opens your mail client with a pre-filled report.'}
                </p>
              </div>
            </div>

            <label className="block">
              <span className="text-xs font-medium text-slate-700">What happened? (optional)</span>
              <textarea
                value={reportNote}
                onChange={(e) => setReportNote(e.target.value)}
                rows={4}
                placeholder="A short description helps me reproduce and fix the issue."
                className="mt-1 w-full text-sm px-3 py-2 rounded-lg border border-slate-300 focus:border-slate-800 focus:outline-none resize-none"
              />
            </label>

            <p className="text-[11px] text-slate-500">
              Goes to <span className="font-mono">sinhaankur@ymail.com</span>. You'll see the
              email before it sends — review and click send in your mail client.
            </p>

            <div className="flex gap-2 pt-2">
              <button
                onClick={() => setShowReportModal(false)}
                className="flex-1 py-2 px-3 rounded-lg border border-slate-300 text-slate-700 hover:bg-slate-50 text-sm font-medium transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={() => void handleSendReport()}
                disabled={reportSending}
                className="flex-1 py-2 px-3 rounded-lg bg-red-700 text-white hover:bg-red-800 text-sm font-medium transition-colors disabled:opacity-60"
              >
                {reportSending ? 'Opening…' : 'Open in mail client'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default Settings;
