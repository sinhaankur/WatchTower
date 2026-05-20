import { cn } from '@/lib/utils';

interface SpinnerProps {
  size?: 12 | 16 | 24 | 32;
  className?: string;
  /** Accessible label for screen readers. Falls back to "Loading". */
  label?: string;
}

/**
 * Brand-styled inline spinner used for short transient operations
 * where a layout-matching Skeleton wouldn't make sense (button
 * submission, OAuth round-trip, in-flight verify).
 *
 * Uses an SVG circular sweep — WatchTower red on a yellow ring —
 * with the same `animate-spin` Tailwind utility every other spinner
 * in the app used to use ad-hoc. Replaces the ⌛ emoji that the OAuth
 * callback pages were using.
 *
 * Sizes are pinned (12/16/24/32) so the component nests inside
 * buttons + cards predictably. Defaults to 16 px.
 */
export function Spinner({ size = 16, className, label = 'Loading' }: SpinnerProps) {
  const px = size;
  return (
    <span
      role="status"
      aria-label={label}
      className={cn('inline-flex items-center justify-center', className)}
      style={{ width: px, height: px }}
    >
      <svg
        viewBox="0 0 32 32"
        width={px}
        height={px}
        className="animate-spin motion-reduce:animate-none"
        aria-hidden="true"
      >
        {/* Yellow ring — soft track behind the active arc */}
        <circle
          cx="16"
          cy="16"
          r="13"
          fill="none"
          stroke="#fde68a"
          strokeWidth="3.5"
        />
        {/* WatchTower red active arc — ~120° of the circle */}
        <path
          d="M 16 3 A 13 13 0 0 1 29 16"
          fill="none"
          stroke="#b91c1c"
          strokeWidth="3.5"
          strokeLinecap="round"
        />
      </svg>
      <span className="sr-only">{label}…</span>
    </span>
  );
}

export default Spinner;
