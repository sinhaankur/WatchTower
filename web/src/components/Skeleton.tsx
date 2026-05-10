import { cn } from '@/lib/utils';

type SkeletonProps = React.HTMLAttributes<HTMLDivElement>;

/**
 * Shimmer placeholder used while content loads.
 *
 * Pair with the same dimensions as the real content so the layout
 * doesn't reflow when the data lands — that's what a skeleton is
 * for, vs. spinning text. Style with Tailwind utilities (h-, w-,
 * rounded-, etc.) on the consumer.
 *
 * Honours `prefers-reduced-motion` via the `.anim-skeleton` rule.
 */
export function Skeleton({ className, ...rest }: SkeletonProps) {
  return (
    <div
      aria-hidden="true"
      className={cn('anim-skeleton rounded-md', className)}
      {...rest}
    />
  );
}

export default Skeleton;
