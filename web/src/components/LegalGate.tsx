import { useState, type ReactElement } from 'react';
import { useLegalStatus, useLegalDocuments, useAcceptTerms, type LegalDocument } from '@/hooks/queries';
import BrandLogo from '@/components/BrandLogo';

/**
 * Click-through legal gate. Sits inside RequireAuth: once a user is
 * authenticated, nothing else renders until they've accepted the
 * current terms version. Acceptance is recorded server-side
 * (append-only, with timestamp + IP) so there's an evidentiary trail;
 * a version bump in watchtower/legal_docs.py re-gates everyone.
 */

// Minimal markdown rendering for our own legal docs — headings, bold,
// lists, paragraphs. Not a general-purpose parser; the documents are
// first-party content, so there's no XSS surface and no need to pull
// in a markdown dependency for three static files.
function MarkdownLite({ text }: { text: string }) {
  const blocks = text.split(/\n\n+/);
  const inline = (s: string) =>
    s.split(/(\*\*[^*]+\*\*)/g).map((part, i) =>
      part.startsWith('**') && part.endsWith('**')
        ? <strong key={i}>{part.slice(2, -2)}</strong>
        : <span key={i}>{part}</span>,
    );
  return (
    <div className="space-y-3">
      {blocks.map((block, bi) => {
        const trimmed = block.trim();
        if (trimmed.startsWith('# ')) {
          return <h2 key={bi} className="text-base font-bold text-slate-900">{trimmed.slice(2)}</h2>;
        }
        if (trimmed.startsWith('## ')) {
          return <h3 key={bi} className="text-sm font-semibold text-slate-900 mt-2">{trimmed.slice(3)}</h3>;
        }
        const lines = trimmed.split('\n');
        const isList = lines.every((l) => /^(\s*[-*]|\s*\d+\.)\s/.test(l) || l.trim() === '');
        if (isList) {
          return (
            <ul key={bi} className="list-disc pl-5 space-y-1">
              {lines.filter((l) => l.trim()).map((l, li) => (
                <li key={li} className="text-xs text-slate-700 leading-relaxed">
                  {inline(l.replace(/^(\s*[-*]|\s*\d+\.)\s/, ''))}
                </li>
              ))}
            </ul>
          );
        }
        return (
          <p key={bi} className="text-xs text-slate-700 leading-relaxed">
            {inline(lines.join(' '))}
          </p>
        );
      })}
    </div>
  );
}

function DocTabs({ documents }: { documents: LegalDocument[] }) {
  const [active, setActive] = useState(documents[0]?.id);
  const current = documents.find((d) => d.id === active) ?? documents[0];
  return (
    <>
      <div className="flex gap-1 border-b border-slate-200 px-4">
        {documents.map((d) => (
          <button
            key={d.id}
            onClick={() => setActive(d.id)}
            className={`text-xs px-3 py-2 -mb-px border-b-2 transition-colors ${
              d.id === current?.id
                ? 'border-amber-500 text-slate-900 font-semibold'
                : 'border-transparent text-slate-500 hover:text-slate-800'
            }`}
          >
            {d.title}
          </button>
        ))}
      </div>
      <div className="overflow-y-auto px-5 py-4 flex-1">
        {current && <MarkdownLite text={current.content} />}
      </div>
    </>
  );
}

export default function LegalGate({ children }: { children: ReactElement }) {
  const { data: status, isLoading, isError } = useLegalStatus();
  const needsGate = !isLoading && !isError && status?.accepted === false;
  const { data: docs } = useLegalDocuments(needsGate);
  const accept = useAcceptTerms();
  const [agreed, setAgreed] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // While checking, render nothing rather than flashing the app to a
  // user who hasn't agreed yet. If the status check itself errors
  // (server restarting, transient network), let the app through — the
  // gate re-evaluates on next navigation, and the login screen's
  // consent line already covers the session.
  if (isLoading) return null;
  if (!needsGate) return children;

  const handleAccept = async () => {
    if (!docs) return;
    setError(null);
    try {
      await accept.mutateAsync(docs.terms_version);
    } catch (e: unknown) {
      const msg = (e as { response?: { data?: { detail?: string } } })?.response?.data?.detail
        ?? 'Could not record your acceptance. Check your connection and try again.';
      setError(msg);
    }
  };

  return (
    <div className="fixed inset-0 z-50 bg-slate-50 flex items-center justify-center p-4">
      <div className="w-full max-w-2xl max-h-[90vh] flex flex-col rounded-xl border border-border bg-white shadow-retro">
        <div className="px-5 py-4 border-b border-slate-200 flex items-center gap-3">
          <BrandLogo size="sm" />
          <div>
            <h1 className="text-sm font-semibold text-slate-900">Before you continue</h1>
            <p className="text-xs text-slate-500">
              Please review and accept the terms for using this WatchTower installation
              {docs ? ` (v${docs.terms_version})` : ''}.
            </p>
          </div>
        </div>

        {docs ? (
          <DocTabs documents={docs.documents} />
        ) : (
          <div className="px-5 py-8 text-xs text-slate-500">Loading documents…</div>
        )}

        <div className="px-5 py-4 border-t border-slate-200 space-y-3">
          <label className="flex items-start gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={agreed}
              onChange={(e) => setAgreed(e.target.checked)}
              className="mt-0.5 accent-amber-500"
            />
            <span className="text-xs text-slate-700">
              I have read and agree to the Terms of Use, Acceptable Use Policy, and Privacy
              Policy. I understand WatchTower is self-hosted software that acts on my
              infrastructure under my responsibility, including any automated or AI-assisted
              features I choose to enable.
            </span>
          </label>
          {error && <p className="text-xs text-red-600">{error}</p>}
          <div className="flex items-center justify-between gap-3">
            <button
              onClick={() => {
                localStorage.removeItem('authToken');
                window.location.href = '/login';
              }}
              className="text-xs px-3 py-1.5 rounded-lg border border-slate-300 text-slate-600 hover:text-slate-900 hover:border-slate-400"
            >
              Decline & sign out
            </button>
            <button
              onClick={() => void handleAccept()}
              disabled={!agreed || !docs || accept.isPending}
              className="text-xs px-5 py-2 rounded-lg border border-border bg-amber-400 hover:bg-amber-500 text-slate-900 font-semibold shadow-retro disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {accept.isPending ? 'Recording…' : 'I agree — continue'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
