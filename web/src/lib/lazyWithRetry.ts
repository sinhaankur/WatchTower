import { lazy, type ComponentType } from 'react';

/**
 * `React.lazy` that survives a stale chunk after a deploy.
 *
 * The problem this solves: the backend serves `index.html` as `no-cache`
 * and the hashed `/assets/*` chunks as `immutable`. That's the correct
 * caching contract — but it means a user with an ALREADY-OPEN tab is
 * holding an old `index.html` that references chunk hashes which no longer
 * exist after a new deploy. The moment they navigate to a lazy route, the
 * dynamic `import()` requests a deleted file, gets a 404/MIME error, and
 * the promise rejects. Plain `React.lazy` surfaces that as a hard render
 * error (blank route / error boundary) even though the fix is trivial:
 * reload to pick up the fresh `index.html` + its current chunk hashes.
 *
 * Strategy:
 *   1. Retry the import once after a short delay — clears a genuinely
 *      transient network blip without a full reload.
 *   2. If it still fails, treat it as a stale-chunk deploy and force a
 *      one-time hard reload. A `sessionStorage` flag guards against an
 *      infinite reload loop: if we've already reloaded once for this
 *      failure and it's STILL failing, the problem isn't a stale chunk
 *      (e.g. the asset is genuinely broken / offline) — so we rethrow and
 *      let the ErrorBoundary show its recoverable UI instead of looping.
 */
export function lazyWithRetry<T extends ComponentType<unknown>>(
  factory: () => Promise<{ default: T }>,
  key: string,
) {
  const flag = `wt:chunk-reload:${key}`;

  return lazy(async () => {
    try {
      const mod = await factory();
      // Success — clear any prior reload flag so a future stale chunk on
      // the same route can trigger its own one-shot reload.
      window.sessionStorage.removeItem(flag);
      return mod;
    } catch {
      // One in-place retry for a transient network failure.
      try {
        await new Promise((r) => setTimeout(r, 400));
        const mod = await factory();
        window.sessionStorage.removeItem(flag);
        return mod;
      } catch (retryErr) {
        const alreadyReloaded = window.sessionStorage.getItem(flag) === '1';
        if (!alreadyReloaded) {
          // First failure for this chunk since load — most likely a stale
          // chunk from a deploy. Force a fresh index.html + chunk hashes.
          window.sessionStorage.setItem(flag, '1');
          window.location.reload();
          // Return a never-resolving promise so Suspense keeps the fallback
          // up during the reload rather than flashing an error frame.
          return new Promise<{ default: T }>(() => {});
        }
        // Already reloaded once and it's still failing — not a stale-chunk
        // problem. Let the ErrorBoundary handle it.
        throw retryErr;
      }
    }
  });
}
