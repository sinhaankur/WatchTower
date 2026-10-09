import type { ReactNode } from 'react';

/**
 * PageHeader — the one consistent header every screen uses.
 *
 * Built to the framework: a clear title (the page's identity), an optional
 * one-line description (recedes), and ONE primary-action slot plus an optional
 * secondary slot — so "one primary action per screen" is enforced by the shape
 * of the component, not left to each page. Sticky + translucent like a native
 * app chrome. Pure theme tokens → correct in both light and dark automatically.
 *
 * Usage:
 *   <PageHeader
 *     title="Servers"
 *     description="The machines WatchTower deploys to."
 *     primary={<Button>+ Add server</Button>}
 *     secondary={<Button variant="outline">Refresh</Button>}
 *   />
 */
export function PageHeader({
  title,
  description,
  primary,
  secondary,
  children,
}: {
  title: ReactNode;
  description?: ReactNode;
  /** The single dominant (amber) action for this screen. */
  primary?: ReactNode;
  /** Quiet supporting actions (outline/ghost). */
  secondary?: ReactNode;
  /** Extra content (e.g. a search field) between the title and the actions. */
  children?: ReactNode;
}) {
  return (
    <header className="sticky top-0 z-10 bg-background/80 backdrop-blur-sm border-b border-border">
      <div className="px-5 sm:px-8 lg:px-10 py-5 flex items-center justify-between gap-4">
        <div className="min-w-0">
          <h1 className="text-xl font-semibold text-foreground tracking-tight truncate">{title}</h1>
          {description && (
            <p className="text-sm text-muted-foreground mt-1 hidden sm:block">{description}</p>
          )}
        </div>
        {children && <div className="flex-1 min-w-0 flex justify-center">{children}</div>}
        {(secondary || primary) && (
          <div className="flex items-center gap-2 shrink-0">
            {secondary}
            {primary}
          </div>
        )}
      </div>
    </header>
  );
}
