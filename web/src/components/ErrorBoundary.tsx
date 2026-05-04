import { Component, type ErrorInfo, type ReactNode } from 'react';

type Props = {
  children: ReactNode;
  /** Optional override for the rendered fallback UI. */
  fallback?: (error: Error, reset: () => void) => ReactNode;
};

type State = {
  error: Error | null;
};

/**
 * Catches uncaught render-time exceptions in the subtree.
 *
 * Without this, a single thrown error in any page component white-screens
 * the whole app — there is no other layer in the SPA that recovers from
 * render exceptions. Wrap routes (or the whole app) with this so users see
 * a recoverable error UI instead of an empty viewport.
 *
 * Note: error boundaries do NOT catch errors in event handlers, async code,
 * server-side rendering, or in the boundary itself. Those still need
 * try/catch in the call site.
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // Surface the failure to the console so devtools shows the stack.
    // (When metrics arrive, replace this with a real reporter.)
     
    console.error('[ErrorBoundary]', error, info.componentStack);
  }

  reset = (): void => {
    this.setState({ error: null });
  };

  render(): ReactNode {
    const { error } = this.state;
    if (error) {
      if (this.props.fallback) return this.props.fallback(error, this.reset);
      return (
        <div className="min-h-screen flex items-center justify-center bg-background p-8">
          <div className="max-w-lg w-full rounded-xl border border-border bg-card p-8 shadow-sm">
            <h1 className="text-xl font-semibold mb-2">Something went wrong</h1>
            <p className="text-sm text-muted-foreground mb-4">
              The page hit an unexpected error. You can try recovering, or reload the app.
            </p>
            <pre className="text-xs bg-muted rounded-md p-3 mb-4 overflow-auto max-h-48 font-mono">
              {error.message}
            </pre>
            <div className="flex gap-2">
              <button
                onClick={this.reset}
                className="px-4 py-2 rounded-lg bg-red-600 hover:bg-red-700 text-white text-sm font-medium transition-colors"
              >
                Try again
              </button>
              <button
                onClick={() => window.location.reload()}
                className="px-4 py-2 rounded-lg border border-border hover:bg-muted text-sm font-medium transition-colors"
              >
                Reload app
              </button>
            </div>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

export default ErrorBoundary;
