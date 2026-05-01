import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './index.css';
import './globals.css';

// ── Embedder token bootstrap ────────────────────────────────────────────────
// When the SPA is loaded inside an embedder (the VS Code extension's
// webview, an iframe in a desktop wrapper, a CI smoke test) the
// embedder can pass `?wt_token=...` on the URL. We persist it to
// localStorage before React mounts so the apiClient's existing token
// resolution path (localStorage.authToken → VITE_API_TOKEN → dev
// fallback) just works.
//
// Done synchronously here, not in App, because some hooks fire on
// first render and they expect the token to already be in storage.
//
// We strip the token from the URL after persisting so it doesn't leak
// into history, bookmarks, or referrer headers. Same pattern Slack /
// GitHub use for their magic-link bootstraps.
(function bootstrapTokenFromQueryParam() {
  try {
    const url = new URL(window.location.href);
    const tokenFromQuery = url.searchParams.get('wt_token');
    if (tokenFromQuery) {
      window.localStorage.setItem('authToken', tokenFromQuery);
      url.searchParams.delete('wt_token');
      // Use replaceState so we don't add a new history entry for the
      // pre-stripped URL — a back button press shouldn't take the user
      // to a pre-token state.
      window.history.replaceState({}, '', url.toString());
    }
  } catch {
    // URL parsing failed (very old browser) — fall through. The user
    // can still sign in via the regular flow.
  }
})();

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
