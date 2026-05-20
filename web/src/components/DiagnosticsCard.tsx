import { useEffect, useState } from 'react';
import apiClient from '@/lib/api';
import { Skeleton } from '@/components/Skeleton';

type CheckStatus = 'ok' | 'warn' | 'fail';

type DiagnosticCheck = {
  id: string;
  name: string;
  status: CheckStatus;
  detail?: string | null;
  hint?: string | null;
};

type DiagnosticReport = {
  checks: DiagnosticCheck[];
  summary: { ok: number; warn: number; fail: number };
  version: string;
  checked_at: string;
};

const STATUS_DOT: Record<CheckStatus, string> = {
  ok:   'bg-emerald-500',
  warn: 'bg-amber-500',
  fail: 'bg-red-500',
};

const STATUS_LABEL: Record<CheckStatus, string> = {
  ok:   'OK',
  warn: 'Warning',
  fail: 'Failing',
};

const STATUS_BADGE: Record<CheckStatus, string> = {
  ok:   'border-emerald-200 bg-emerald-50 text-emerald-700',
  warn: 'border-amber-200 bg-amber-50 text-amber-700',
  fail: 'border-red-200 bg-red-50 text-red-700',
};

/**
 * Diagnostics card for Settings.
 *
 * Calls GET /api/diagnose and renders one row per subsystem with a
 * red/amber/green dot, a one-line detail, and a hint when something
 * is missing or misconfigured. The copy button puts a plain-text
 * version of the whole report on the clipboard so users can paste
 * it into a bug report or chat.
 *
 * Designed so that "why isn't X working?" usually has an answer
 * inside this card without anyone having to open DevTools or shell
 * into the host. When something here is wrong, the hint tells the
 * operator what env var to set or what command to run.
 */
export function DiagnosticsCard() {
  const [report, setReport] = useState<DiagnosticReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [copied, setCopied] = useState(false);

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const r = await apiClient.get<DiagnosticReport>('/diagnose');
      // Validate the shape rather than trusting the type assertion.
      // An older backend without this route returns HTML via the SPA
      // fallback, which axios happily parses as a "200 success". Without
      // a check the next render crashes on `report.summary.fail`.
      const ok =
        r.data
        && typeof r.data === 'object'
        && Array.isArray((r.data as DiagnosticReport).checks)
        && (r.data as DiagnosticReport).summary
        && typeof (r.data as DiagnosticReport).summary === 'object';
      if (!ok) {
        setError('Diagnostics endpoint not available on this server. Restart the API to pick up the new /api/diagnose route.');
        return;
      }
      setReport(r.data);
    } catch (e) {
      const detail = (e as { response?: { data?: { detail?: string } } })?.response?.data?.detail;
      setError(detail || 'Could not run diagnostics.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, []);

  const copyReport = async () => {
    if (!report) return;
    const lines: string[] = [
      `WatchTower diagnostics (${report.version})`,
      `When: ${report.checked_at}`,
      `Summary: ${report.summary.ok} ok, ${report.summary.warn} warn, ${report.summary.fail} fail`,
      '',
    ];
    for (const c of report.checks) {
      const tag = c.status.toUpperCase();
      lines.push(`[${tag}] ${c.name}${c.detail ? ` — ${c.detail}` : ''}`);
      if (c.hint) lines.push(`       hint: ${c.hint}`);
    }
    try {
      await navigator.clipboard.writeText(lines.join('\n'));
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      // Some contexts block clipboard access; the dot list itself is selectable.
    }
  };

  return (
    <section
      className="rounded-lg border bg-white p-4 sm:p-5"
      style={{ borderColor: 'hsl(var(--border-soft))' }}
    >
      <header className="flex items-start justify-between gap-3 mb-3">
        <div>
          <h2 className="text-sm font-semibold text-slate-900">Diagnostics</h2>
          <p className="text-xs text-slate-600 mt-0.5">
            Live state of every subsystem. If something doesn't work,
            check here first — the fix is usually setting an env var.
          </p>
        </div>
        {report?.summary && (
          <div className="shrink-0 flex items-center gap-1 text-[10px] font-medium uppercase tracking-wide">
            {(report.summary.fail ?? 0) > 0 && (
              <span className={`px-2 py-0.5 rounded-full border ${STATUS_BADGE.fail}`}>
                {report.summary.fail} fail
              </span>
            )}
            {(report.summary.warn ?? 0) > 0 && (
              <span className={`px-2 py-0.5 rounded-full border ${STATUS_BADGE.warn}`}>
                {report.summary.warn} warn
              </span>
            )}
            {(report.summary.ok ?? 0) > 0 && (
              <span className={`px-2 py-0.5 rounded-full border ${STATUS_BADGE.ok}`}>
                {report.summary.ok} ok
              </span>
            )}
          </div>
        )}
      </header>

      {error && (
        <div className="text-xs text-red-700 bg-red-50 border border-red-200 rounded-md p-2 mb-3">
          {error}
        </div>
      )}

      {loading && !report && (
        <ul className="space-y-2" aria-busy="true">
          {[0, 1, 2, 3, 4].map((i) => (
            <li key={i} className="flex items-center gap-2.5 py-1">
              <Skeleton.Line className="h-3 w-3 rounded-full shrink-0" />
              <Skeleton.Line className="h-3.5 flex-1 max-w-72" />
            </li>
          ))}
        </ul>
      )}

      {report && Array.isArray(report.checks) && (
        <ul className="space-y-1.5">
          {report.checks.map((c) => (
            <li key={c.id} className="flex items-start gap-2.5 py-1">
              <span
                aria-label={STATUS_LABEL[c.status]}
                title={STATUS_LABEL[c.status]}
                className={`mt-1.5 inline-block w-2 h-2 rounded-full shrink-0 ${STATUS_DOT[c.status]}`}
              />
              <div className="flex-1 min-w-0">
                <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                  <span className="text-xs font-medium text-slate-900">{c.name}</span>
                  {c.detail && (
                    <span className="text-[11px] text-slate-500 font-mono break-all">
                      {c.detail}
                    </span>
                  )}
                </div>
                {c.hint && (
                  <p className="text-[11px] text-slate-600 mt-0.5">
                    <span className="text-slate-400">↳ </span>
                    {c.hint}
                  </p>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}

      <div className="flex items-center gap-2 mt-4 pt-3 border-t border-slate-100">
        <button
          type="button"
          onClick={() => void load()}
          disabled={loading}
          className="text-[11px] px-2.5 py-1 rounded border border-slate-300 text-slate-700 hover:bg-slate-50 disabled:opacity-50"
        >
          {loading ? 'Re-running…' : 'Re-run'}
        </button>
        <button
          type="button"
          onClick={() => void copyReport()}
          disabled={!report}
          className="text-[11px] px-2.5 py-1 rounded border border-slate-300 text-slate-700 hover:bg-slate-50 disabled:opacity-50"
        >
          {copied ? 'Copied' : 'Copy report'}
        </button>
        {report && (
          <span className="ml-auto text-[10px] text-slate-400 font-mono">
            v{report.version}
          </span>
        )}
      </div>
    </section>
  );
}

export default DiagnosticsCard;
