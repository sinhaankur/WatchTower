import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@/lib/utils';

/**
 * Card — surface primitive, token-sourced.
 *
 * `retro` is the elevated panel (1px border + soft shadow) for hero/standalone
 * cards. `flat` is the quieter soft-border surface for dense layouts (lists,
 * settings rows). Both derive from tokens so the whole app recolors together.
 * (The `retro` name is kept for drop-in compatibility; it's no longer
 * neo-brutalist — just a gently elevated card.)
 */
const cardVariants = cva('bg-card text-card-foreground', {
  variants: {
    variant: {
      retro: 'rounded-lg border border-border shadow-retro',
      flat: 'rounded-lg border border-border-soft',
    },
  },
  defaultVariants: {
    variant: 'flat',
  },
});

export interface CardProps
  extends React.HTMLAttributes<HTMLDivElement>,
    VariantProps<typeof cardVariants> {}

const Card = React.forwardRef<HTMLDivElement, CardProps>(
  ({ className, variant, ...props }, ref) => (
    <div ref={ref} className={cn(cardVariants({ variant, className }))} {...props} />
  ),
);
Card.displayName = 'Card';

const CardHeader = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => (
    <div ref={ref} className={cn('flex flex-col space-y-1.5 p-5 sm:p-6', className)} {...props} />
  ),
);
CardHeader.displayName = 'CardHeader';

const CardTitle = React.forwardRef<HTMLHeadingElement, React.HTMLAttributes<HTMLHeadingElement>>(
  ({ className, ...props }, ref) => (
    <h2
      ref={ref}
      className={cn('text-lg font-semibold leading-none tracking-tight', className)}
      {...props}
    />
  ),
);
CardTitle.displayName = 'CardTitle';

const CardDescription = React.forwardRef<
  HTMLParagraphElement,
  React.HTMLAttributes<HTMLParagraphElement>
>(({ className, ...props }, ref) => (
  <p ref={ref} className={cn('text-sm text-muted-foreground', className)} {...props} />
));
CardDescription.displayName = 'CardDescription';

const CardContent = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => (
    <div ref={ref} className={cn('p-5 pt-0 sm:p-6 sm:pt-0', className)} {...props} />
  ),
);
CardContent.displayName = 'CardContent';

const CardFooter = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => (
    <div ref={ref} className={cn('flex items-center p-5 pt-0 sm:p-6 sm:pt-0', className)} {...props} />
  ),
);
CardFooter.displayName = 'CardFooter';

// cardVariants co-located per shadcn convention (see button.tsx note).
// eslint-disable-next-line react-refresh/only-export-components
export { Card, CardHeader, CardFooter, CardTitle, CardDescription, CardContent, cardVariants };
