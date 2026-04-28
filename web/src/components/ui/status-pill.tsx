/**
 * StatusPill — a small color + icon + label badge.
 *
 * Why: many places across the app use color-only status (a green dot,
 * a red dot) which fails WCAG 1.4.1 (use of color) and is hostile to
 * colorblind users. This component pairs each tone with a glyph so the
 * status reads even without color.
 *
 * Use the convenience `<StatusPill tone="…" />` for the common cases
 * (healthy, warning, error, idle, running, info). Pass `label` only if
 * you want to override the default tone-derived label.
 */
import type { ReactNode } from 'react';

export type StatusTone =
  | 'healthy'   // up / live / success
  | 'running'   // in-progress
  | 'warning'   // degraded / pending action
  | 'error'     // down / failed
  | 'idle'      // stopped / inactive
  | 'info';     // informational

const TONE: Record<
  StatusTone,
  { label: string; bg: string; text: string; border: string; icon: ReactNode }
> = {
  healthy: {
    label: 'Healthy',
    bg: 'bg-emerald-50', text: 'text-emerald-800', border: 'border-emerald-300',
    icon: (
      <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
        <polyline points="20 6 9 17 4 12" />
      </svg>
    ),
  },
  running: {
    label: 'Running',
    bg: 'bg-blue-50', text: 'text-blue-800', border: 'border-blue-300',
    icon: (
      <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="animate-spin">
        <path d="M21 12a9 9 0 1 1-6.22-8.56" />
      </svg>
    ),
  },
  warning: {
    label: 'Warning',
    bg: 'bg-amber-50', text: 'text-amber-900', border: 'border-amber-300',
    icon: (
      <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
        <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
        <line x1="12" y1="9" x2="12" y2="13" />
        <line x1="12" y1="17" x2="12.01" y2="17" />
      </svg>
    ),
  },
  error: {
    label: 'Failed',
    bg: 'bg-red-50', text: 'text-red-700', border: 'border-red-300',
    icon: (
      <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
        <line x1="18" y1="6" x2="6" y2="18" />
        <line x1="6" y1="6" x2="18" y2="18" />
      </svg>
    ),
  },
  idle: {
    label: 'Idle',
    bg: 'bg-slate-100', text: 'text-slate-700', border: 'border-slate-300',
    icon: (
      <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
        <rect x="6" y="4" width="4" height="16" /><rect x="14" y="4" width="4" height="16" />
      </svg>
    ),
  },
  info: {
    label: 'Info',
    bg: 'bg-slate-50', text: 'text-slate-700', border: 'border-slate-300',
    icon: (
      <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="12" cy="12" r="10" />
        <line x1="12" y1="16" x2="12" y2="12" />
        <line x1="12" y1="8" x2="12.01" y2="8" />
      </svg>
    ),
  },
};

export function StatusPill({
  tone,
  label,
  size = 'sm',
  className = '',
}: {
  tone: StatusTone;
  label?: string;
  size?: 'xs' | 'sm';
  className?: string;
}) {
  const t = TONE[tone];
  const padding = size === 'xs' ? 'px-1.5 py-0' : 'px-2 py-0.5';
  const text = size === 'xs' ? 'text-[10px]' : 'text-xs';
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full border font-medium ${padding} ${text} ${t.bg} ${t.text} ${t.border} ${className}`}
      role="status"
      aria-label={label ?? t.label}
    >
      <span className="shrink-0" aria-hidden="true">{t.icon}</span>
      {label ?? t.label}
    </span>
  );
}

/** Map a backend deployment status string to a StatusTone. */
export function deploymentStatusTone(status: string | null | undefined): StatusTone {
  switch ((status ?? '').toLowerCase()) {
    case 'live':
    case 'success':
    case 'succeeded':
    case 'deployed':
      return 'healthy';
    case 'building':
    case 'pending':
    case 'in_progress':
    case 'queued':
      return 'running';
    case 'failed':
    case 'error':
    case 'errored':
      return 'error';
    case 'rolled_back':
    case 'cancelled':
    case 'canceled':
      return 'warning';
    default:
      return 'idle';
  }
}

/** Map a backend node-health status to a StatusTone. */
export function nodeStatusTone(status: string | null | undefined): StatusTone {
  switch ((status ?? '').toLowerCase()) {
    case 'healthy':
    case 'online':
    case 'ready':
      return 'healthy';
    case 'degraded':
    case 'unhealthy':
      return 'warning';
    case 'unreachable':
    case 'offline':
    case 'down':
      return 'error';
    default:
      return 'idle';
  }
}
