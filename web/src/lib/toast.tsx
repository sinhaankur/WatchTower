/**
 * Tiny global toast/notification primitive.
 *
 * Why: pages had ad-hoc inline `msg` banners with copy-pasted styling for
 * success/error/info. That made every mutation a UX special-case. This
 * module exposes a single imperative API (`toast.success`, `toast.error`,
 * `toast.info`) plus a `<Toaster />` component mounted once at the app
 * root so any code path can publish a notification without prop-drilling.
 *
 * Implementation note: deliberately framework-light (no extra deps). A
 * module-level event bus + a small React subscriber. Safe to call from
 * anywhere (event handlers, query-client onError, fetch interceptors).
 */
import { useEffect, useState } from 'react';

export type ToastKind = 'success' | 'error' | 'info' | 'warning';

export type ToastMessage = {
  id: string;
  kind: ToastKind;
  text: string;
  /** Optional auto-dismiss override in ms. Defaults: success/info 4s, warning 6s, error 8s. */
  durationMs?: number;
};

type Listener = (toasts: ToastMessage[]) => void;

const _listeners = new Set<Listener>();
let _toasts: ToastMessage[] = [];
let _id = 0;

function _emit() {
  for (const l of _listeners) l(_toasts);
}

function _push(kind: ToastKind, text: string, durationMs?: number) {
  const id = `t${++_id}`;
  const t: ToastMessage = { id, kind, text, durationMs };
  _toasts = [..._toasts, t];
  _emit();
  // Auto-dismiss
  const ms = durationMs ?? (kind === 'error' ? 8000 : kind === 'warning' ? 6000 : 4000);
  setTimeout(() => dismiss(id), ms);
  return id;
}

export function dismiss(id: string) {
  _toasts = _toasts.filter((t) => t.id !== id);
  _emit();
}

export const toast = {
  success(text: string, durationMs?: number) { return _push('success', text, durationMs); },
  error(text: string, durationMs?: number) { return _push('error', text, durationMs); },
  info(text: string, durationMs?: number) { return _push('info', text, durationMs); },
  warning(text: string, durationMs?: number) { return _push('warning', text, durationMs); },
  /** Extract a useful message from an axios-style error and surface it. */
  fromError(err: unknown, fallback = 'Something went wrong') {
    const detail = (err as { response?: { data?: { detail?: unknown } } })?.response?.data?.detail;
    const msg = typeof detail === 'string' ? detail : (err as Error)?.message ?? fallback;
    return _push('error', msg);
  },
};

function Toast({ t }: { t: ToastMessage }) {
  const tone =
    t.kind === 'success' ? 'border-emerald-300 bg-emerald-50 text-emerald-800'
    : t.kind === 'error'   ? 'border-red-300 bg-red-50 text-red-800'
    : t.kind === 'warning' ? 'border-amber-300 bg-amber-50 text-amber-900'
    :                        'border-slate-300 bg-white text-slate-800';

  // Dual-cue: icon next to colored chrome so the message is parseable
  // without color (a11y).
  const icon =
    t.kind === 'success' ? (
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12" /></svg>
    ) : t.kind === 'error' ? (
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10" /><line x1="15" y1="9" x2="9" y2="15" /><line x1="9" y1="9" x2="15" y2="15" /></svg>
    ) : t.kind === 'warning' ? (
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" /><line x1="12" y1="9" x2="12" y2="13" /><line x1="12" y1="17" x2="12.01" y2="17" /></svg>
    ) : (
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10" /><line x1="12" y1="16" x2="12" y2="12" /><line x1="12" y1="8" x2="12.01" y2="8" /></svg>
    );

  return (
    <div
      role="status"
      aria-live="polite"
      className={`flex items-start gap-2 px-3 py-2 rounded-lg border shadow-[2px_2px_0_0_#1f2937] text-xs max-w-sm ${tone}`}
    >
      <span className="mt-0.5 shrink-0">{icon}</span>
      <span className="flex-1 leading-snug">{t.text}</span>
      <button
        onClick={() => dismiss(t.id)}
        aria-label="Dismiss"
        className="ml-1 opacity-60 hover:opacity-100 transition-opacity"
      >
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
          <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
        </svg>
      </button>
    </div>
  );
}

/**
 * Mount once near the app root. Renders a stack of active toasts in the
 * bottom-right corner. Safe to mount inside the auth-required Layout
 * because nothing here depends on auth state.
 */
export function Toaster() {
  const [toasts, setToasts] = useState<ToastMessage[]>(_toasts);

  useEffect(() => {
    const fn: Listener = (next) => setToasts(next);
    _listeners.add(fn);
    return () => { _listeners.delete(fn); };
  }, []);

  if (toasts.length === 0) return null;

  return (
    <div
      className="fixed bottom-4 right-4 z-[100] flex flex-col gap-2 pointer-events-none"
      aria-live="polite"
      aria-atomic="false"
    >
      {toasts.map((t) => (
        <div key={t.id} className="pointer-events-auto animate-in slide-in-from-right-4 fade-in duration-200">
          <Toast t={t} />
        </div>
      ))}
    </div>
  );
}
