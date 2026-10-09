import { Component, type ErrorInfo, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { getLastRequestId } from '@/lib/api';

type Props = {
  /** Human-readable page name shown in the error UI and copied diagnostics. */
  pageName: string;
  children: ReactNode;
};

type State = {
  error: Error | null;
  componentStack: string | null;
  copied: boolean;
};

/**
 * Per-route error boundary.
 *
 * The top-level <ErrorBoundary> catches anything but renders a generic
 * "Something went wrong" panel that gives users (and us) no useful
 * diagnostics. This wrapper sits inside each route, so:
 *   - failures in one page don't unmount the rest of the app shell
 *   - the user sees the actual error message + stack
 *   - the last X-Request-ID is surfaced so server logs can be cross-
 *     referenced end-to-end
 *   - "Copy diagnostics" puts a paste-ready bug report on the clipboard
 *
 * Caveat (same as the parent): error boundaries don't catch async
 * exceptions or event-handler errors. Those still need try/catch.
 */
export class RouteErrorBoundary extends Component<Props, State> {
  state: State = { error: null, componentStack: null, copied: false };

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    this.setState({ componentStack: info.componentStack ?? null });

    console.error(`[RouteErrorBoundary:${this.props.pageName}]`, error, info.componentStack);
  }

  reset = (): void => {
    this.setState({ error: null, componentStack: null, copied: false });
  };

  buildDiagnostics(): string {
    const { error, componentStack } = this.state;
    const reqId = getLastRequestId();
    const lines = [
      `Page: ${this.props.pageName}`,
      `URL: ${typeof window !== 'undefined' ? window.location.href : '(no window)'}`,
      `When: ${new Date().toISOString()}`,
      `Last X-Request-ID: ${reqId ?? '(none captured)'}`,
      `User agent: ${typeof navigator !== 'undefined' ? navigator.userAgent : '(no navigator)'}`,
      '',
      `Error: ${error?.name ?? 'Error'}: ${error?.message ?? '(no message)'}`,
      '',
      'Stack:',
      error?.stack ?? '(no stack)',
      '',
      'Component stack:',
      componentStack ?? '(no component stack)',
    ];
    return lines.join('\n');
  }

  copyDiagnostics = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(this.buildDiagnostics());
      this.setState({ copied: true });
      window.setTimeout(() => this.setState({ copied: false }), 2000);
    } catch {
      // Some contexts (file://, non-secure) block clipboard. The textarea
      // below stays user-selectable so they can copy by hand.
    }
  };

  render(): ReactNode {
    const { error, componentStack, copied } = this.state;
    if (!error) return this.props.children;

    const reqId = getLastRequestId();
    return (
      <div className="flex-1 overflow-auto bg-muted p-6">
        <div className="max-w-3xl mx-auto rounded-xl border border-destructive/30 bg-card p-6 shadow-sm">
          <div className="flex items-start justify-between gap-3 mb-3">
            <div>
              <h1 className="text-lg font-semibold text-foreground">
                {this.props.pageName} hit an error
              </h1>
              <p className="text-xs text-muted-foreground mt-0.5">
                The rest of the app is fine — only this page failed to render.
              </p>
            </div>
            <span className="shrink-0 inline-flex text-xs px-2 py-0.5 rounded-full border border-destructive/40 bg-destructive/10 text-destructive font-medium uppercase tracking-wide">
              Render error
            </span>
          </div>

          <div className="text-xs text-muted-foreground mb-3 space-y-0.5">
            {reqId && (
              <p>
                Request ID:{' '}
                <code className="font-mono text-foreground">{reqId}</code>{' '}
                <span className="text-muted-foreground">
                  (use this when reporting; backend logs are searchable by it)
                </span>
              </p>
            )}
            <p>
              When:{' '}
              <code className="font-mono text-foreground">
                {new Date().toISOString()}
              </code>
            </p>
          </div>

          <div className="rounded-md bg-muted border border-border p-3 mb-3">
            <p className="text-xs uppercase tracking-wide text-muted-foreground mb-1">
              {error.name || 'Error'}
            </p>
            <p className="text-sm font-mono text-foreground break-all">
              {error.message || '(no message)'}
            </p>
          </div>

          <details className="mb-3">
            <summary className="text-xs text-foreground/90 cursor-pointer select-none hover:text-foreground">
              Stack trace
            </summary>
            <pre className="mt-2 text-xs bg-foreground text-slate-100 rounded-md p-3 overflow-auto max-h-64 font-mono whitespace-pre-wrap">
              {error.stack || '(no stack)'}
            </pre>
          </details>

          {componentStack && (
            <details className="mb-3">
              <summary className="text-xs text-foreground/90 cursor-pointer select-none hover:text-foreground">
                Component stack
              </summary>
              <pre className="mt-2 text-xs bg-foreground text-slate-100 rounded-md p-3 overflow-auto max-h-48 font-mono whitespace-pre-wrap">
                {componentStack}
              </pre>
            </details>
          )}

          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={this.copyDiagnostics}
              className="px-3 py-1.5 rounded-md bg-foreground hover:bg-slate-800 text-white text-xs font-medium"
            >
              {copied ? 'Copied to clipboard' : 'Copy diagnostics'}
            </button>
            <button
              type="button"
              onClick={this.reset}
              className="px-3 py-1.5 rounded-md border border-border hover:bg-muted text-xs font-medium text-foreground"
            >
              Try again
            </button>
            <button
              type="button"
              onClick={() => window.location.reload()}
              className="px-3 py-1.5 rounded-md border border-border hover:bg-muted text-xs font-medium text-foreground"
            >
              Reload app
            </button>
            <Link
              to="/"
              className="px-3 py-1.5 rounded-md border border-border hover:bg-muted text-xs font-medium text-foreground"
            >
              Go to dashboard
            </Link>
          </div>
        </div>
      </div>
    );
  }
}

export default RouteErrorBoundary;
