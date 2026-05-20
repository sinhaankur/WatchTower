import { cn } from '@/lib/utils';

type SkeletonProps = React.HTMLAttributes<HTMLDivElement>;

/**
 * Shimmer placeholder used while content loads.
 *
 * Use one of the named variants below — Line / Card / Row / Stat — so
 * the loading state matches the shape of the data that's about to land
 * and the layout doesn't reflow when it does. The shimmer animation
 * comes from `.anim-skeleton` in App.css and honours
 * `prefers-reduced-motion` automatically.
 *
 * The bare `Skeleton` export is the line variant — kept as default so
 * existing call sites (`<Skeleton className="h-4 w-20" />`) keep working.
 */
function Line({ className, ...rest }: SkeletonProps) {
  return (
    <div
      aria-hidden="true"
      className={cn('anim-skeleton rounded-md', className)}
      {...rest}
    />
  );
}

/**
 * Card-shaped skeleton — matches the rounded-xl bordered card shells
 * used across the app's pages (Integrations, ProjectDetail, etc.).
 * Renders a header line and two body lines inside the card so the
 * shimmer looks like "data about to arrive" rather than a single
 * featureless block.
 */
function Card({ className, ...rest }: SkeletonProps) {
  return (
    <div
      aria-hidden="true"
      className={cn(
        'rounded-xl border border-border bg-card overflow-hidden',
        className,
      )}
      {...rest}
    >
      <div className="px-5 py-4 border-b border-border bg-muted/30">
        <Line className="h-4 w-32" />
      </div>
      <div className="px-5 py-4 flex flex-col gap-3">
        <Line className="h-3 w-full" />
        <Line className="h-3 w-4/5" />
        <Line className="h-3 w-2/3" />
      </div>
    </div>
  );
}

/**
 * Single row in a list/table — used in Servers, AuditLog, etc. while
 * the rows themselves are being fetched. Default width breakpoints
 * roughly match a name + status pill + meta column.
 */
function Row({ className, ...rest }: SkeletonProps) {
  return (
    <div
      aria-hidden="true"
      className={cn(
        'flex items-center gap-3 px-4 py-3 border-b border-border last:border-b-0',
        className,
      )}
      {...rest}
    >
      <Line className="h-9 w-9 rounded-lg shrink-0" />
      <div className="flex-1 flex flex-col gap-1.5 min-w-0">
        <Line className="h-3.5 w-40 max-w-full" />
        <Line className="h-3 w-24 max-w-full" />
      </div>
      <Line className="h-6 w-16 rounded-full shrink-0" />
    </div>
  );
}

/**
 * Stat tile — used on the Dashboard while the project/deploy counts
 * load. Mirrors the existing stat-card shape (rounded-xl, bordered,
 * one big number + one small label).
 */
function Stat({ className, ...rest }: SkeletonProps) {
  return (
    <div
      aria-hidden="true"
      className={cn(
        'rounded-xl border border-border bg-card px-5 py-4 flex flex-col gap-3',
        className,
      )}
      {...rest}
    >
      <Line className="h-3 w-20" />
      <Line className="h-7 w-16" />
    </div>
  );
}

// Composite export so consumers do `<Skeleton.Card />`, `<Skeleton.Row />`,
// etc. Bare `Skeleton` and `<Skeleton.Line />` are the same call.
export const Skeleton = Object.assign(Line, { Line, Card, Row, Stat });
export default Skeleton;
