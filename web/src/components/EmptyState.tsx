import { type ReactNode } from 'react';
import Mascot from './Mascot';

type EmptyStateProps = {
  title: string;
  description?: ReactNode;
  /** Action affordances rendered below the description (buttons, links, etc.). */
  action?: ReactNode;
  /** Show the owl mascot. Default true; pass false for terse contexts. */
  withMascot?: boolean;
  /** Smaller layout for inline empties (e.g. inside a card). */
  compact?: boolean;
};

/**
 * Standard friendly empty-state panel.
 *
 * Replaces the "No projects available." one-liner pattern across pages.
 * The mascot + a real prompt + an action gives users somewhere to go
 * instead of a dead end. Pages that already have rich onboarding (the
 * Setup wizard) can skip it.
 */
export function EmptyState({
  title,
  description,
  action,
  withMascot = true,
  compact = false,
}: EmptyStateProps) {
  return (
    <div
      className={
        compact
          ? 'flex flex-col items-center text-center py-6 gap-2'
          : 'flex flex-col items-center text-center py-12 gap-4'
      }
    >
      {withMascot && (
        <Mascot
          size={compact ? 64 : 112}
          mood="idle"
          className="opacity-90"
        />
      )}
      <h2
        className={
          compact
            ? 'text-sm font-semibold text-slate-800'
            : 'text-base font-semibold text-slate-900'
        }
      >
        {title}
      </h2>
      {description && (
        <p className="text-xs text-slate-600 max-w-md">{description}</p>
      )}
      {action && <div className="flex items-center gap-2 mt-1">{action}</div>}
    </div>
  );
}

export default EmptyState;
