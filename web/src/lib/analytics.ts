/**
 * Thin wrapper around Google Analytics 4 (gtag.js).
 *
 * Set VITE_GA_ID=G-XXXXXXXXXX in web/.env.local (never commit the real ID).
 * When VITE_GA_ID is absent the module is a no-op so local dev stays clean.
 *
 * Usage:
 *   import { trackPageView, trackEvent } from '@/lib/analytics';
 *   trackPageView('/dashboard');
 *   trackEvent('deploy_triggered', { project_id: '...' });
 */

const GA_ID = (import.meta as any).env?.VITE_GA_ID as string | undefined;

/** True once gtag.js has been injected. */
let initialized = false;

function init() {
  if (initialized || !GA_ID) return;
  initialized = true;

  // Inject the gtag loader script
  const script = document.createElement('script');
  script.src = `https://www.googletagmanager.com/gtag/js?id=${GA_ID}`;
  script.async = true;
  document.head.appendChild(script);

  // Bootstrap the dataLayer queue
  (window as any).dataLayer = (window as any).dataLayer ?? [];
  (window as any).gtag = function gtag(...args: unknown[]) {
    (window as any).dataLayer.push(args);
  };
  (window as any).gtag('js', new Date());
  (window as any).gtag('config', GA_ID, {
    // Don't send the full URL; only the path so PII in query strings is dropped.
    send_page_view: false,
  });
}

/**
 * Record a page-view. Call this on every React Router navigation.
 * @param path  e.g. '/dashboard', '/projects/abc123'
 */
export function trackPageView(path: string) {
  if (!GA_ID) return;
  init();
  (window as any).gtag?.('event', 'page_view', {
    page_location: path,
    page_title: document.title,
  });
}

/**
 * Record a custom event.
 * @param name    snake_case event name, e.g. 'deploy_triggered'
 * @param params  optional extra dimensions (avoid PII)
 */
export function trackEvent(name: string, params?: Record<string, string | number | boolean>) {
  if (!GA_ID) return;
  init();
  (window as any).gtag?.('event', name, params);
}
