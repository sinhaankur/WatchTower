import * as React from 'react';
import { Slot } from '@radix-ui/react-slot';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@/lib/utils';

/**
 * Button — the WatchTower primitive (cva + Radix Slot).
 *
 * Calm, modern look: 1px borders, a subtle soft shadow that lifts gently on
 * hover (no hard offset, no toy bounce). Every value comes from design tokens
 * (`--primary`, `--border`, `--shadow`) so the whole app moves together when a
 * token changes.
 *
 * `asChild` lets a router <Link>/<a> inherit button styling via Radix Slot.
 * Variant names (default/outline/ghost/secondary/destructive/link) are
 * preserved for drop-in compatibility with existing call sites.
 */
const buttonVariants = cva(
  'inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-semibold ring-offset-background transition-[transform,box-shadow,background-color,border-color] duration-fast ease-out-soft select-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50 [&_svg]:size-4 [&_svg]:shrink-0',
  {
    variants: {
      variant: {
        default:
          'bg-primary text-primary-foreground shadow-retro hover:bg-primary/90 hover:shadow-retro-hover',
        secondary:
          'border border-border bg-secondary text-secondary-foreground hover:bg-muted',
        outline:
          'border border-border bg-card text-foreground shadow-retro hover:bg-muted hover:shadow-retro-hover',
        destructive:
          'bg-destructive text-destructive-foreground shadow-retro hover:bg-destructive/90 hover:shadow-retro-hover',
        ghost: 'text-foreground hover:bg-muted',
        link: 'text-primary underline-offset-4 hover:underline',
      },
      size: {
        default: 'h-10 px-4 py-2',
        sm: 'h-8 px-3 text-xs',
        lg: 'h-11 px-6 text-base',
        icon: 'h-10 w-10',
      },
    },
    defaultVariants: {
      variant: 'default',
      size: 'default',
    },
  },
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean;
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, ...props }, ref) => {
    const Comp = asChild ? Slot : 'button';
    return (
      <Comp className={cn(buttonVariants({ variant, size, className }))} ref={ref} {...props} />
    );
  },
);
Button.displayName = 'Button';

// buttonVariants is intentionally co-located (standard shadcn convention) so
// consumers can compose the variants onto <Link>/<a>. The fast-refresh lint
// only cares during HMR, which doesn't apply to this stable primitive.
// eslint-disable-next-line react-refresh/only-export-components
export { Button, buttonVariants };
