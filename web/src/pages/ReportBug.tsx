import { useMemo, useState } from 'react';
import { getLastRequestId } from '@/lib/api';

type ElectronBridge = {
  openErrorReport?: (payload: { message?: string }) => Promise<{ ok: boolean; error?: string }>;
};

function IconBug() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M8 2h8" />
      <path d="M9 2v2.5" />
      <path d="M15 2v2.5" />
      <rect x="7" y="4.5" width="10" height="14" rx="4" />
      <path d="M3 9h4" />
      <path d="M17 9h4" />
      <path d="M2 14h5" />
      <path d="M17 14h5" />
      <path d="M10 9h4" />
    </svg>
  );
}

function IconMail() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M4 4h16v16H4z" />
      <path d="M4 8l8 6 8-6" />
    </svg>
  );
}

function IconClipboard() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="8" y="2" width="8" height="4" rx="1" />
      <path d="M9 4H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2h-3" />
    </svg>
  );
}

function IconGithub() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M12 .5a12 12 0 0 0-3.79 23.39c.6.11.82-.26.82-.57v-2.24c-3.34.72-4.04-1.42-4.04-1.42-.55-1.4-1.33-1.78-1.33-1.78-1.08-.74.08-.73.08-.73 1.2.08 1.83 1.23 1.83 1.23 1.06 1.82 2.79 1.3 3.47.99.11-.78.42-1.3.76-1.6-2.67-.3-5.47-1.34-5.47-5.95 0-1.31.47-2.38 1.23-3.22-.13-.3-.53-1.53.12-3.19 0 0 1.01-.32 3.3 1.23a11.45 11.45 0 0 1 6.01 0c2.29-1.55 3.29-1.23 3.29-1.23.66 1.66.26 2.89.13 3.19.77.84 1.23 1.91 1.23 3.22 0 4.62-2.8 5.65-5.49 5.95.43.37.82 1.1.82 2.21v3.28c0 .31.21.68.83.57A12 12 0 0 0 12 .5Z" />
    </svg>
  );
}

const SUPPORT_EMAIL = 'sinhaankur@ymail.com';

const AREAS = [
  'Desktop app',
  'Web UI',
  'Deployments',
  'Databases',
  'Integrations',
  'Authentication',
  'Other',
] as const;

const SEVERITIES = ['Critical', 'High', 'Medium', 'Low'] as const;

type Area = (typeof AREAS)[number];
type Severity = (typeof SEVERITIES)[number];

function buildMessage(details: {
  area: Area;
  severity: Severity;
  title: string;
  whatHappened: string;
  expected: string;
  reproduce: string;
  requestId: string | null;
}) {
  const lines = [
    `Area: ${details.area}`,
    `Severity: ${details.severity}`,
    `Title: ${details.title || '(please add a short title)'}`,
    '',
    'What happened:',
    details.whatHappened || '(describe the problem)',
    '',
    'What did you expect:',
    details.expected || '(describe expected behavior)',
    '',
    'Steps to reproduce:',
    details.reproduce || '(add numbered steps)',
    '',
    `Last X-Request-ID: ${details.requestId ?? '(none captured)'}`,
    `URL: ${typeof window !== 'undefined' ? window.location.href : '(no window)'}`,
    `User agent: ${typeof navigator !== 'undefined' ? navigator.userAgent : '(no navigator)'}`,
    `Timestamp: ${new Date().toISOString()}`,
  ];
  return lines.join('\n');
}

function ReportBug() {
  const electron = (typeof window !== 'undefined'
    ? (window as unknown as { electronAPI?: ElectronBridge }).electronAPI
    : undefined);

  const [title, setTitle] = useState('');
  const [area, setArea] = useState<Area>('Web UI');
  const [severity, setSeverity] = useState<Severity>('Medium');
  const [whatHappened, setWhatHappened] = useState('');
  const [expected, setExpected] = useState('');
  const [reproduce, setReproduce] = useState('');
  const [confirmLatest, setConfirmLatest] = useState(false);
  const [confirmSearched, setConfirmSearched] = useState(false);
  const [sending, setSending] = useState(false);
  const [copied, setCopied] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; msg: string } | null>(null);

  const requestId = getLastRequestId();
  const canSubmit = title.trim().length > 0
    && whatHappened.trim().length > 0
    && reproduce.trim().length > 0
    && confirmLatest
    && confirmSearched;

  const message = useMemo(
    () => buildMessage({ area, severity, title, whatHappened, expected, reproduce, requestId }),
    [area, severity, title, whatHappened, expected, reproduce, requestId],
  );

  const githubIssueUrl = useMemo(() => {
    const issueTitle = encodeURIComponent(`[Bug] ${title || 'Untitled issue'}`);
    const issueBody = encodeURIComponent(message);
    return `https://github.com/sinhaankur/WatchTower/issues/new?template=bug_report.md&title=${issueTitle}&body=${issueBody}`;
  }, [title, message]);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(message);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1800);
    } catch {
      setResult({ ok: false, msg: 'Clipboard access blocked in this browser context.' });
    }
  };

  const handleSend = async () => {
    if (!canSubmit) {
      setResult({ ok: false, msg: 'Please complete required fields and checklist items before submitting.' });
      return;
    }
    setSending(true);
    setResult(null);
    try {
      if (electron?.openErrorReport) {
        const res = await electron.openErrorReport({ message });
        setResult(
          res.ok
            ? { ok: true, msg: 'Mail client opened with diagnostics attached. Review and send.' }
            : { ok: false, msg: res.error ?? 'Could not open mail client.' },
        );
        return;
      }

      const subject = encodeURIComponent(`WatchTower bug report: ${title || 'Untitled issue'}`);
      const body = encodeURIComponent(message);
      window.open(`mailto:${SUPPORT_EMAIL}?subject=${subject}&body=${body}`, '_blank', 'noopener,noreferrer');
      setResult({ ok: true, msg: 'Mail client opened. Review the report and send it.' });
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="flex-1 overflow-auto bg-slate-50">
      <header
        className="px-4 sm:px-6 lg:px-8 py-4 border-b"
        style={{ borderColor: 'hsl(var(--border-soft))' }}
      >
        <div className="max-w-4xl mx-auto w-full flex items-start gap-3">
          <div className="w-10 h-10 rounded-lg border border-slate-800 bg-red-700 text-white flex items-center justify-center shadow-[2px_2px_0_0_#1f2937]">
            <IconBug />
          </div>
          <div>
            <h1 className="text-lg font-semibold text-slate-900">Report a Bug</h1>
            <p className="text-xs text-slate-600 mt-0.5">
              High-signal report with request id and diagnostics so issues can be fixed faster.
            </p>
          </div>
        </div>
      </header>

      <main className="px-4 sm:px-6 lg:px-8 py-6 max-w-4xl mx-auto w-full space-y-4">
        <section className="rounded-xl border border-slate-800 bg-white p-5 shadow-[2px_2px_0_0_#1f2937] space-y-4">
          <div className="rounded-lg border border-slate-200 bg-slate-50 p-3 text-[11px] text-slate-600">
            <p className="font-medium text-slate-800">Before submitting</p>
            <div className="mt-2 space-y-1.5">
              <label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={confirmLatest}
                  onChange={(e) => setConfirmLatest(e.target.checked)}
                  className="w-3.5 h-3.5 accent-slate-800"
                />
                <span>I verified this on the latest WatchTower version.</span>
              </label>
              <label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={confirmSearched}
                  onChange={(e) => setConfirmSearched(e.target.checked)}
                  className="w-3.5 h-3.5 accent-slate-800"
                />
                <span>I checked open and closed issues for duplicates.</span>
              </label>
            </div>
          </div>

          <div className="grid sm:grid-cols-2 gap-3">
            <label className="block">
              <span className="text-xs font-medium text-slate-700">Area</span>
              <select
                value={area}
                onChange={(e) => setArea(e.target.value as Area)}
                className="mt-1 w-full text-sm px-3 py-2 rounded-lg border border-slate-300 focus:border-slate-800 focus:outline-none bg-white"
              >
                {AREAS.map((option) => (
                  <option key={option} value={option}>{option}</option>
                ))}
              </select>
            </label>

            <label className="block">
              <span className="text-xs font-medium text-slate-700">Severity</span>
              <select
                value={severity}
                onChange={(e) => setSeverity(e.target.value as Severity)}
                className="mt-1 w-full text-sm px-3 py-2 rounded-lg border border-slate-300 focus:border-slate-800 focus:outline-none bg-white"
              >
                {SEVERITIES.map((option) => (
                  <option key={option} value={option}>{option}</option>
                ))}
              </select>
            </label>

            <label className="block sm:col-span-2">
              <span className="text-xs font-medium text-slate-700">Short title *</span>
              <input
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="Example: Auto-update restarts repeatedly after install"
                className="mt-1 w-full text-sm px-3 py-2 rounded-lg border border-slate-300 focus:border-slate-800 focus:outline-none"
              />
            </label>

            <label className="block">
              <span className="text-xs font-medium text-slate-700">What happened *</span>
              <textarea
                value={whatHappened}
                onChange={(e) => setWhatHappened(e.target.value)}
                rows={4}
                placeholder="What did you see?"
                className="mt-1 w-full text-sm px-3 py-2 rounded-lg border border-slate-300 focus:border-slate-800 focus:outline-none resize-y"
              />
            </label>

            <label className="block">
              <span className="text-xs font-medium text-slate-700">Expected behavior</span>
              <textarea
                value={expected}
                onChange={(e) => setExpected(e.target.value)}
                rows={4}
                placeholder="What should have happened instead?"
                className="mt-1 w-full text-sm px-3 py-2 rounded-lg border border-slate-300 focus:border-slate-800 focus:outline-none resize-y"
              />
            </label>

            <label className="block sm:col-span-2">
              <span className="text-xs font-medium text-slate-700">Steps to reproduce *</span>
              <textarea
                value={reproduce}
                onChange={(e) => setReproduce(e.target.value)}
                rows={4}
                placeholder="1. Open Settings\n2. Click Update\n3. App restarts twice"
                className="mt-1 w-full text-sm px-3 py-2 rounded-lg border border-slate-300 focus:border-slate-800 focus:outline-none resize-y"
              />
            </label>
          </div>

          <div className="rounded-lg border border-slate-200 bg-slate-50 p-3 text-[11px] text-slate-600">
            <p>
              Last X-Request-ID:{' '}
              <span className="font-mono text-slate-800">{requestId ?? '(none captured yet)'}</span>
            </p>
            <p className="mt-1">
              In desktop mode, the report email automatically includes log snippets and diagnostics.
            </p>
            <p className="mt-1">
              Privacy note: report content is only sent through your mail client or your GitHub issue submission.
            </p>
          </div>

          {result && (
            <p className={`text-xs ${result.ok ? 'text-emerald-700' : 'text-red-600'}`}>
              {result.msg}
            </p>
          )}

          <div className="flex flex-wrap items-center gap-2 pt-1">
            <button
              type="button"
              onClick={() => void handleSend()}
              disabled={sending || !canSubmit}
              className="inline-flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg border border-slate-800 bg-red-700 hover:bg-red-800 text-white font-semibold shadow-[1px_1px_0_0_#1f2937] disabled:opacity-60"
            >
              <IconMail />
              {sending ? 'Opening…' : 'Open Mail Report'}
            </button>
            <button
              type="button"
              onClick={() => void handleCopy()}
              className="inline-flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg border border-slate-300 bg-white hover:bg-slate-50 text-slate-800 font-medium"
            >
              <IconClipboard />
              {copied ? 'Copied' : 'Copy Report Text'}
            </button>
            <a
              href={githubIssueUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg border border-slate-300 bg-white hover:bg-slate-50 text-slate-800 font-medium"
            >
              <IconGithub />
              Open Prefilled GitHub Issue
            </a>
          </div>
        </section>
      </main>
    </div>
  );
}

export default ReportBug;