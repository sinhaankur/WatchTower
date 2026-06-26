import * as React from 'react';
import { Slot } from '@radix-ui/react-slot';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@/lib/utils';

/**
 * Button — the WatchTower primitive (cva + Radix Slot).
 *
 * Preserves the brand's neo-brutalist character — hard 2px border, offset
 * "lift" shadow that grows on hover and presses in on click, spring-eased —
 * but sources every value from design tokens (`--border`, `--shadow`, the
 * brand red/amber via primary/secondary) instead of hardcoded hex, so the
 * whole app moves together when a token changes.
 *
 * `asChild` lets a router <Link>/<a> inherit button styling via Radix Slot.
 * Existing variant names (default/outline/ghost/secondary) are preserved for
 * drop-in compatibility; `lift` is the explicit name for the signature CTA.
 */
const liftShadow =
  'shadow-[4px_4px_0_0_hsl(var(--border))] hover:shadow-[6px_6px_0_0_hsl(var(--border))] hover:-translate-x-0.5 hover:-translate-y-0.5 active:translate-x-0.5 active:translate-y-0.5 active:shadow-none';

const buttonVariants = cva(
  'inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-bold ring-offset-background transition-[transform,box-shadow,background-color] duration-fast ease-spring select-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50 [&_svg]:size-4 [&_svg]:shrink-0',
  {
    variants: {
      variant: {
        default: `border-2 border-border bg-primary text-primary-foreground ${liftShadow}`,
        secondary: `border-2 border-border bg-secondary text-secondary-foreground ${liftShadow}`,
        outline: `border-2 border-border bg-card text-foreground ${liftShadow}`,
        destructive: `border-2 border-border bg-destructive text-destructive-foreground ${liftShadow}`,
        ghost: 'text-foreground hover:bg-muted hover:text-primary',
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
