import { useEffect, useState } from 'react';
import { useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import apiClient from '@/lib/api';
import { trackEvent } from '@/lib/analytics';
import { Button } from '@/components/ui/button';
import BrandLogo from '@/components/BrandLogo';

type AuthStatus = {
  oauth?: {
    github_configured?: boolean;
    missing?: string[];
  };
  device_flow?: {
    github_configured?: boolean;
  };
  api_token?: {
    configured?: boolean;
  };
  dev_auth?: {
    allow_insecure?: boolean;
  };
  installation?: {
    owner_mode_enabled?: boolean;
  };
  recommended?: 'oauth' | 'device_flow' | 'api_token';
};

type ContextResponse = {
  user?: {
    name?: string | null;
    email?: string | null;
  };
};

type LoggedInUser = {
  name?: string;
  email?: string;
  isTest?: boolean;
  // Distinguishes which auth method actually completed. Was previously
  // hardcoded as "GitHub" in the success screen, which lied for users
  // who signed in via API token, dev mode, or device flow.
  method?: 'github_oauth' | 'github_device_flow' | 'api_token' | 'guest' | 'dev';
};

// Debug-only affordances (e.g. "Test logged-in success screen") only
// appear in dev builds. Production bundles strip them.
const IS_DEV: boolean = Boolean((import.meta as unknown as { env?: { DEV?: boolean } }).env?.DEV);

/**
 * Live countdown for the GitHub Device Flow code.
 * GitHub gives a 15-minute window; without a visible timer, users
 * walk away and discover the expiration only at the moment the
 * polling silently fails.
 */
function DeviceFlowCountdown({ started, expiresIn }: { started: number; expiresIn: number }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  const remaining = Math.max(0, Math.floor(expiresIn - (now - started) / 1000));
  const m = Math.floor(remaining / 60);
  const s = String(remaining % 60).padStart(2, '0');
  // Last 60 seconds gets a red highlight so the user knows time's running out.
  const tone = remaining <= 60 ? 'text-red-600 font-semibold' : 'text-slate-500';
  return (
    <span className={`tabular-nums ${tone}`}>
      {remaining > 0 ? `expires in ${m}:${s}` : 'expired'}
    </span>
  );
}

const Login = () => {
  const navigate = useNavigate();
  const location = useLocation();
  const [searchParams] = useSearchParams();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [tokenInput, setTokenInput] = useState('');
  const [authStatus, setAuthStatus] = useState<AuthStatus | null>(null);
  const [statusLoading, setStatusLoading] = useState(true);
  const oauthReady = Boolean(authStatus?.oauth?.github_configured);
  const deviceFlowReady = Boolean(authStatus?.device_flow?.github_configured);

  // Device Flow state
  const [deviceFlow, setDeviceFlow] = useState<null | {
    user_code: string;
    verification_uri: string;
    verification_uri_complete?: string;
    device_code: string;
    expires_in: number;
    interval: number;
    started: number;
  }>(null);
  const [devicePolling, setDevicePolling] = useState(false);

  const [loggedInUser, setLoggedInUser] = useState<LoggedInUser | null>(null);

  const resolveNextPath = () => {
    const fromState = (location.state as { from?: string } | null)?.from;
    const fromQuery = searchParams.get('next') || undefined;
    const candidate = fromQuery || fromState || '/';
    if (!candidate.startsWith('/') || candidate.startsWith('//')) return '/';
    if (candidate === '/login') return '/';
    return candidate;
  };

  const showSuccessAndRedirect = (user: LoggedInUser, delayMs = 1600, nextPath?: string) => {
    setLoggedInUser(user);
    const target = nextPath || '/';
    window.setTimeout(() => navigate(target, { replace: true }), delayMs);
  };

  const resolveUserFromContext = async (): Promise<LoggedInUser> => {
    try {
      const resp = await apiClient.get<ContextResponse>('/context');
      const name = resp.data?.user?.name || undefined;
      const email = resp.data?.user?.email || undefined;
      return { name, email };
    } catch {
      return { name: 'Authenticated user' };
    }
  };

  useEffect(() => {
    const testLoginEnabled = searchParams.get('test_login') === '1';
    const nextPath = resolveNextPath();
    if (testLoginEnabled) {
      setLoggedInUser({ name: 'Test User', email: 'test@example.com', isTest: true });
      return;
    }

    // Respect explicit sign-out: if the user just clicked "Sign out", the
    // sentinel sits in localStorage and we DO NOT auto-re-authenticate
    // from VITE_API_TOKEN — that would silently bounce them back to the
    // dashboard and make sign-out feel broken. Sentinel persists until
    // a new sign-in succeeds.
    const explicitlySignedOut = localStorage.getItem('wt:explicitlySignedOut') === '1';

    const hydrateExistingSession = async (token: string) => {
      localStorage.setItem('authToken', token);
      // Hydration counts as a successful sign-in — clear the sign-out
      // sentinel so the next launch can auto-login again.
      localStorage.removeItem('wt:explicitlySignedOut');
      const user = await resolveUserFromContext();
      showSuccessAndRedirect(user, 1800, nextPath);
    };

    if (explicitlySignedOut) {
      // Don't auto-login. The user must click an explicit sign-in button,
      // which clears the sentinel via hydrateExistingSession.
      return;
    }

    // Auto-login: Electron injects VITE_API_TOKEN into the Vite process at launch.
    // If present, store it and go straight to the dashboard.
    const injectedToken = (import.meta as any).env?.VITE_API_TOKEN as string | undefined;
    if (injectedToken && injectedToken.trim()) {
      void hydrateExistingSession(injectedToken.trim());
      return;
    }

    const existing = localStorage.getItem('authToken');
    if (existing) {
      void hydrateExistingSession(existing);
    }
  }, [location.state, navigate, searchParams]);

  useEffect(() => {
    const loadAuthStatus = async () => {
      setStatusLoading(true);
      try {
        const resp = await apiClient.get('/auth/status');
        const status = resp.data as AuthStatus;
        setAuthStatus(status);
      } catch {
        setAuthStatus(null);
      } finally {
        setStatusLoading(false);
      }
    };

    void loadAuthStatus();
  }, [navigate]);

  const continueWithToken = async () => {
    const trimmed = tokenInput.trim();
    if (!trimmed) {
      setError('Enter an API token first.');
      return;
    }

    setLoading(true);
    setError('');
    try {
      localStorage.setItem('authToken', trimmed);
      localStorage.removeItem('wt:explicitlySignedOut');
      const user = await resolveUserFromContext();
      trackEvent('login', { method: 'api_token' });
      showSuccessAndRedirect({ ...user, method: 'api_token' }, 1600, resolveNextPath());
    } catch {
      localStorage.removeItem('authToken');
      // Specific error guidance — the most common cause is users
      // pasting a GitHub PAT (because the field used to be labeled
      // that way). Tell them what shape the token should take.
      setError(
        'Token did not authenticate. This field accepts the server\'s ' +
        '`WATCHTOWER_API_TOKEN` (set when WatchTower was installed) — ' +
        'NOT a GitHub Personal Access Token. If you need GitHub auth, ' +
        'use the "Sign in with GitHub" button above instead.'
      );
      setLoading(false);
    }
  };

  const devAutoLogin = async () => {
    setLoading(true);
    setError('');
    try {
      const devToken = 'dev-' + Math.random().toString(36).slice(2, 10);
      localStorage.setItem('authToken', devToken);
      localStorage.removeItem('wt:explicitlySignedOut');
      const user = await resolveUserFromContext();
      trackEvent('login', { method: 'dev_auto' });
      showSuccessAndRedirect({ ...user, method: 'dev' }, 1600, resolveNextPath());
    } catch {
      localStorage.removeItem('authToken');
      setError('Dev auto-login failed. Check that WATCHTOWER_ALLOW_INSECURE_DEV_AUTH=true on the server.');
      setLoading(false);
    }
  };

  const continueAsGuest = async () => {
    setLoading(true);
    setError('');
    try {
      // The guest endpoint mints a signed session for the shared local
      // "Guest" identity. No GitHub OAuth required, but the server gates
      // privileged operations (remote node creation, etc.) on the
      // is_github_authenticated flag.
      const resp = await apiClient.post<{ token: string; user: { name?: string; email?: string } }>(
        '/auth/guest'
      );
      const token = resp.data?.token;
      if (!token) throw new Error('Guest session token missing');
      localStorage.setItem('authToken', token);
      localStorage.removeItem('wt:explicitlySignedOut');
      trackEvent('login', { method: 'guest' });
      showSuccessAndRedirect(
        { name: resp.data.user?.name ?? 'Guest', email: resp.data.user?.email, method: 'guest' },
        1200,
        resolveNextPath(),
      );
    } catch (e: unknown) {
      localStorage.removeItem('authToken');
      const detail = (e as { response?: { data?: { detail?: string } } })?.response?.data?.detail;
      setError(detail || 'Guest mode is unavailable. Sign in with GitHub or use an API token.');
      setLoading(false);
    }
  };

  const loginWithGitHub = async () => {
    setLoading(true);
    setError('');
    try {
      const redirectUri = `${window.location.origin}/oauth/github/login/callback`;
      const fromState = (location.state as { from?: string } | null)?.from;
      const fromQuery = searchParams.get('next') || undefined;
      const nextPath = fromQuery || fromState || '/';

      const baseUrl = (import.meta as any).env?.VITE_API_URL || '/api';
      const cleanBase = String(baseUrl).replace(/\/+$/, '');

      let loginUrl = `${cleanBase}/auth/github/login`;
      if (!cleanBase.endsWith('/api')) {
        loginUrl = `${cleanBase}/api/auth/github/login`;
      }

      const params = new URLSearchParams({
        redirect_uri: redirectUri,
        next_path: nextPath,
      });
      const oauthUrl = `${loginUrl}?${params.toString()}`;

      // Inside Electron: open a popup BrowserWindow so the main window stays alive.
      const electron = (window as any).electronAPI;
      if (electron?.openOAuth) {
        electron.openOAuth(oauthUrl);
        trackEvent('login', { method: 'github_oauth' });
        setLoading(false);
      } else {
        trackEvent('login', { method: 'github_oauth' });
        window.location.assign(oauthUrl);
      }
    } catch {
      setError('Unable to start GitHub login. Ask your administrator to configure GitHub OAuth on the server, or use Device Flow / API token sign-in below.');
      setLoading(false);
    }
  };

  const startGitHubDeviceFlow = async () => {
    setError('');
    setLoading(true);
    try {
      const resp = await apiClient.post('/auth/github/device/start', {});
      const data = resp.data as {
        user_code: string;
        verification_uri: string;
        verification_uri_complete?: string;
        device_code: string;
        expires_in: number;
        interval: number;
      };
      setDeviceFlow({ ...data, started: Date.now() });
      trackEvent('login', { method: 'github_device_flow_start' });
      // Open the GitHub verification page automatically
      const url = data.verification_uri_complete || data.verification_uri;
      const electron = (window as any).electronAPI;
      if (electron?.openOAuth) {
        electron.openOAuth(url);
      } else {
        window.open(url, '_blank', 'noopener,noreferrer');
      }
    } catch (e: any) {
      const detail = e?.response?.data?.detail || 'Could not start GitHub Device Flow.';
      setError(detail);
    } finally {
      setLoading(false);
    }
  };

  const cancelDeviceFlow = () => {
    setDeviceFlow(null);
    setDevicePolling(false);
  };

  const copyUserCode = async () => {
    if (!deviceFlow?.user_code) return;
    try {
      await navigator.clipboard.writeText(deviceFlow.user_code);
    } catch {
      // ignore
    }
  };

  // Poll the device flow endpoint while we have an active flow
  useEffect(() => {
    if (!deviceFlow) return;
    let cancelled = false;
    setDevicePolling(true);

    const poll = async () => {
      if (cancelled) return;
      const elapsed = (Date.now() - deviceFlow.started) / 1000;
      if (elapsed > deviceFlow.expires_in) {
        setDevicePolling(false);
        setError('Device code expired. Click "Sign in with GitHub" again.');
        setDeviceFlow(null);
        return;
      }
      try {
        const resp = await apiClient.post('/auth/github/device/poll', {
          device_code: deviceFlow.device_code,
        });
        const data = resp.data as {
          status?: string;
          token?: string;
          interval?: number;
          user?: { name?: string; email?: string };
        };
        if (cancelled) return;
        if (data.status === 'success' && data.token) {
          localStorage.setItem('authToken', data.token);
          localStorage.removeItem('wt:explicitlySignedOut');
          setDevicePolling(false);
          setDeviceFlow(null);
          trackEvent('login', { method: 'github_device_flow_success' });
          showSuccessAndRedirect(
            { name: data.user?.name, email: data.user?.email, method: 'github_device_flow' },
            1400,
            resolveNextPath()
          );
          return;
        }
        if (data.status === 'access_denied') {
          setDevicePolling(false);
          setDeviceFlow(null);
          setError('GitHub authorization was denied.');
          return;
        }
        // authorization_pending or slow_down — wait then poll again
        const wait = (data.status === 'slow_down' && data.interval ? data.interval : deviceFlow.interval) * 1000;
        setTimeout(poll, wait);
      } catch (e: any) {
        if (cancelled) return;
        const detail = e?.response?.data?.detail || 'Polling failed.';
        setError(detail);
        setDevicePolling(false);
        setDeviceFlow(null);
      }
    };

    const t = setTimeout(poll, deviceFlow.interval * 1000);
    return () => {
      cancelled = true;
      clearTimeout(t);
      setDevicePolling(false);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deviceFlow?.device_code]);

  // Note: GitHub PAT generation buttons used to live above the API
  // token input. They were misleading (the API token field is for
  // WATCHTOWER_API_TOKEN, NOT for a GitHub PAT) and have been removed.
  // Users who need a GitHub PAT for private-repo access link it from
  // Settings → Integrations after signing in via OAuth/Device Flow.

  // Determine if the server has anything configured at all
  const apiTokenConfigured = Boolean(authStatus?.api_token?.configured);
  const nothingConfigured = !statusLoading && authStatus && !oauthReady && !deviceFlowReady && !apiTokenConfigured && !authStatus?.dev_auth?.allow_insecure;

  return (
    <div className="min-h-screen flex items-center justify-center px-6 bg-transparent">
      <div className="w-full max-w-md rounded-2xl px-8 py-10 text-center border border-border bg-white/95 backdrop-blur-sm shadow-sm fade-in-up">
        {loggedInUser ? (
          <div className="space-y-6 py-8">
            <div className="flex justify-center">
              <div className="w-16 h-16 rounded-full bg-emerald-100 flex items-center justify-center animate-pulse">
                <svg viewBox="0 0 16 16" width="32" height="32" fill="#047857" aria-hidden="true">
                  <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/>
                </svg>
              </div>
            </div>
            <div>
              <h2 className="text-2xl font-bold text-slate-900 mb-2">✓ Logged In</h2>
              <p className="text-sm text-slate-600">
                {loggedInUser.name
                  ? `Welcome, ${loggedInUser.name}!`
                  : (() => {
                      // Truthful default: reflect the actual auth method
                      // instead of hardcoding "GitHub" for paths that
                      // weren't (api_token, dev, guest).
                      switch (loggedInUser.method) {
                        case 'github_oauth':
                        case 'github_device_flow':
                          return 'Successfully authenticated with GitHub';
                        case 'api_token':
                          return 'Signed in with API token';
                        case 'guest':
                          return 'Signed in as Guest';
                        case 'dev':
                          return 'Signed in via dev-mode auto-login';
                        default:
                          return 'Authenticated';
                      }
                    })()}
              </p>
              {loggedInUser.email && (
                <p className="text-xs text-slate-500 mt-1">{loggedInUser.email}</p>
              )}
            </div>
            {loggedInUser.isTest ? (
              <div className="space-y-3">
                <p className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-md px-3 py-2">
                  Test mode enabled. This confirms the post-login success UI without redirect.
                </p>
                <div className="flex gap-2 justify-center">
                  <Button
                    onClick={() => setLoggedInUser(null)}
                    variant="outline"
                    className="rounded-lg"
                  >
                    Back to Sign In
                  </Button>
                  <Button
                    onClick={() => navigate('/', { replace: true })}
                    className="rounded-lg bg-slate-900 hover:bg-slate-800 text-white"
                  >
                    Continue to Dashboard
                  </Button>
                </div>
              </div>
            ) : (
              <div className="text-xs text-slate-500">
                Redirecting to dashboard...
              </div>
            )}
          </div>
        ) : (
          <>
            <div className="mb-4 flex justify-center">
              <BrandLogo size="lg" withLabel subtitle="Secure Team Access" />
            </div>
            <h1 className="text-2xl font-semibold mb-2 text-slate-900">Sign in to WatchTower</h1>
            <p className="text-sm text-slate-600 mb-3">
              Use GitHub to authenticate, or enter the server's API token below.
            </p>
            <details className="mb-5 text-left text-xs text-slate-500">
              <summary className="cursor-pointer hover:text-slate-700 text-center">Why does WatchTower need a sign-in?</summary>
              <div className="mt-2 px-2 space-y-1.5 text-slate-600">
                <p>WatchTower deploys your projects across machines you own. To do that safely it needs to know <strong>who</strong> triggered each action.</p>
                <p><strong>If you sign in with GitHub:</strong> WatchTower can clone your repos (including private ones if you authorize it later), attribute audit-log entries to your real identity, and deploy under team-scoped permissions.</p>
                <p><strong>If you use the API token:</strong> WatchTower runs locally as the operator who installed the server. Most single-user desktop installs work this way.</p>
                <p>WatchTower never reads or stores your GitHub password. OAuth and Device Flow both happen on github.com, not here.</p>
              </div>
            </details>
            {/* Debug-only affordance — vite strips this in production builds. */}
            {IS_DEV && (
            <div className="mb-4">
              <button
                type="button"
                onClick={() => setLoggedInUser({ name: 'Test User', email: 'test@example.com', isTest: true })}
                className="text-[11px] text-slate-500 hover:text-slate-800 underline underline-offset-2"
              >
                Test logged-in success screen
              </button>
            </div>
            )}

        {/* Dev mode: one-click login */}
        {!statusLoading && authStatus?.dev_auth?.allow_insecure && (
          <div className="mb-5 rounded-lg border border-red-400 bg-red-50 px-4 py-3 text-left">
            <p className="text-sm font-semibold text-red-800 mb-1">⚠ Insecure dev mode enabled</p>
            <p className="text-xs text-red-700 mb-3">
              <code className="font-mono bg-red-100 px-1 rounded">WATCHTOWER_ALLOW_INSECURE_DEV_AUTH=true</code> is set on the server.
              <strong> Any token is accepted</strong> — anyone reaching this page can sign in instantly.
              Set the env var to <code className="font-mono bg-red-100 px-1 rounded">false</code> in production.
            </p>
            <Button
              onClick={() => void devAutoLogin()}
              disabled={loading}
              className="w-full rounded-lg bg-amber-600 hover:bg-amber-700 text-white font-semibold py-5"
            >
              {loading ? 'Logging in…' : 'Quick Dev Login →'}
            </Button>
          </div>
        )}

        {/* Server not configured at all */}
        {nothingConfigured && (
            <div className="text-left text-sm mb-5 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 space-y-1">
            <p className="font-medium text-amber-800">⚠ Server setup required</p>
            <p className="text-amber-700 text-xs">
              Set <code className="font-mono bg-amber-100 px-1 rounded">WATCHTOWER_API_TOKEN</code> on the server, or configure GitHub OAuth to enable secure team sign-in.
            </p>
            </div>
        )}

        {/* Owner mode hint */}
        {!statusLoading && authStatus?.installation?.owner_mode_enabled && (
            <div className="text-left text-xs mb-4 rounded-lg border border-blue-200 bg-blue-50 px-3 py-2">
            <p className="font-medium text-blue-800">Installation ownership is active</p>
            <p className="text-blue-700 mt-0.5">Ask your owner or admin to invite your account before signing in.</p>
            </div>
        )}

        {error && (
            <div className="text-sm text-red-700 border border-red-200 bg-red-50 rounded-lg px-3 py-2.5 mb-4 text-left">
            {error}
            </div>
        )}

        {/* Auth methods */}
        {statusLoading ? (
            <div className="py-6 flex items-center justify-center gap-2 text-slate-400 text-sm">
            <span className="inline-block w-4 h-4 border-2 border-slate-300 border-t-slate-600 rounded-full animate-spin" />
            Checking server…
            </div>
          ) : (
          <>
            {/* GitHub OAuth — PRIMARY auth method */}
            <div className="space-y-3 mb-4">
              {!oauthReady && !deviceFlowReady && (
                  <div className="text-left text-xs rounded-lg border border-blue-200 bg-blue-50 px-3 py-2 text-blue-700 mb-3">
                  <p className="font-medium text-blue-800 mb-1">GitHub sign-in not set up yet</p>
                  <p>
                    Ask your administrator to configure GitHub login on the server.
                    {' '}You can still sign in with the server's API token below in the meantime.
                  </p>
                  <p className="mt-1 text-blue-600">
                    <a
                      href="https://github.com/sinhaankur/WatchTower#github-authentication"
                      target="_blank"
                      rel="noopener noreferrer"
                      className="hover:underline"
                    >
                      Setup guide →
                    </a>
                  </p>
                  </div>
              )}

              {/* Device Flow active panel */}
              {deviceFlow ? (
                <div className="text-left rounded-xl border-2 border-slate-900 bg-slate-50 px-4 py-4 space-y-3">
                  <p className="text-sm font-semibold text-slate-900">Authorize WatchTower on GitHub</p>
                  <ol className="list-decimal list-inside text-xs text-slate-700 space-y-1">
                    <li>A browser opened at <span className="font-mono">{deviceFlow.verification_uri}</span></li>
                    <li>Enter the code below if not pre-filled</li>
                    <li>Approve access — this page will sign you in automatically</li>
                  </ol>
                  <div className="flex items-center justify-between bg-white border border-slate-300 rounded-lg px-4 py-3">
                    <code className="text-2xl font-mono tracking-widest font-bold text-slate-900">
                      {deviceFlow.user_code}
                    </code>
                    <button
                      type="button"
                      onClick={() => void copyUserCode()}
                      className="text-xs text-slate-600 hover:text-slate-900 underline"
                    >
                      Copy
                    </button>
                  </div>
                  <div className="flex items-center gap-2 text-xs text-slate-500">
                    <span className="inline-block w-3 h-3 border-2 border-slate-300 border-t-slate-700 rounded-full animate-spin" />
                    <span className="flex-1">{devicePolling ? 'Waiting for GitHub authorization…' : 'Starting…'}</span>
                    <DeviceFlowCountdown started={deviceFlow.started} expiresIn={deviceFlow.expires_in} />
                  </div>
                  <div className="flex gap-2">
                    <a
                      href={deviceFlow.verification_uri_complete || deviceFlow.verification_uri}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="flex-1 text-center text-xs bg-slate-900 hover:bg-slate-800 text-white rounded-md px-3 py-2"
                    >
                      Reopen GitHub
                    </a>
                    <button
                      type="button"
                      onClick={cancelDeviceFlow}
                      className="text-xs border border-slate-300 hover:bg-slate-100 text-slate-700 rounded-md px-3 py-2"
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              ) : (
                <>
                  <Button
                    onClick={() => {
                      // If neither method is configured, the button is
                      // visually disabled but we still want to surface
                      // *why* — open the setup guide instead of being
                      // a silent no-op (which previously read as "the
                      // button doesn't work").
                      if (!oauthReady && !deviceFlowReady) {
                        window.open(
                          'https://github.com/sinhaankur/WatchTower#github-authentication',
                          '_blank',
                          'noopener,noreferrer',
                        );
                        return;
                      }
                      if (deviceFlowReady) {
                        void startGitHubDeviceFlow();
                      } else {
                        void loginWithGitHub();
                      }
                    }}
                    disabled={loading}
                    className={`w-full rounded-lg gap-2 py-6 text-base font-semibold flex items-center justify-center ${
                      (oauthReady || deviceFlowReady)
                        ? 'bg-slate-900 hover:bg-slate-800 text-white'
                        : 'bg-slate-200 text-slate-700 hover:bg-slate-300 border border-slate-300'
                    }`}
                    title={
                      (oauthReady || deviceFlowReady)
                        ? undefined
                        : 'GitHub OAuth/Device Flow is not configured on this server. Click for setup instructions.'
                    }
                  >
                    {loading ? (
                        <span className="inline-flex items-center gap-2">
                        <span className="inline-block w-4 h-4 border-2 border-white/40 border-t-white rounded-full animate-spin" />
                        Connecting to GitHub…
                        </span>
                    ) : (
                        <span className="inline-flex items-center gap-2">
                        <svg viewBox="0 0 16 16" width="20" height="20" fill="currentColor" aria-hidden="true">
                          <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/>
                        </svg>
                        <span>{(oauthReady || deviceFlowReady) ? 'Sign in with GitHub' : 'GitHub sign-in not set up — see setup guide'}</span>
                        </span>
                    )}
                  </Button>
                  {(oauthReady || deviceFlowReady) ? (
                    <div className="text-xs text-slate-600 text-center space-y-1">
                      <p>
                        {deviceFlowReady
                          ? '✓ Click → GitHub gives you a short code to enter'
                          : '✓ Click → browser opens GitHub → returns here automatically'}
                      </p>
                      <p className="text-[11px] text-slate-500">
                        Method: <span className="font-medium">{deviceFlowReady ? 'Device Flow' : 'OAuth redirect'}</span>
                        {deviceFlowReady && oauthReady && ' (Device Flow preferred — no callback URL needed)'}
                      </p>
                    </div>
                  ) : (
                    <p className="text-[11px] text-slate-500 text-center">
                      To enable: set <code className="font-mono bg-slate-100 px-1 rounded">WATCHTOWER_GITHUB_DEVICE_CLIENT_ID</code> in <code className="font-mono bg-slate-100 px-1 rounded">.env</code>, then restart. Sign in with the API token below in the meantime.
                    </p>
                  )}
                </>
              )}
            </div>

            <div className="my-5 flex items-center gap-3">
              <div className="h-px flex-1 bg-slate-200" />
              <span className="text-[11px] text-slate-400 uppercase tracking-wider">or</span>
              <div className="h-px flex-1 bg-slate-200" />
            </div>

            {/* Guest mode — no login required, but limited capabilities */}
            <div className="text-left">
              <Button
                onClick={() => void continueAsGuest()}
                disabled={loading}
                variant="outline"
                className="w-full rounded-lg gap-2 py-5 text-sm font-medium flex items-center justify-center border-slate-300 text-slate-700 hover:bg-slate-50"
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
                  <circle cx="12" cy="7" r="4" />
                </svg>
                <span>Continue as Guest</span>
              </Button>
              <details className="mt-1.5 text-[11px] text-slate-500">
                <summary className="cursor-pointer text-center hover:text-slate-700">What can guest mode do?</summary>
                <div className="mt-2 px-3 text-left space-y-1">
                  <p className="text-slate-700"><strong>Guest mode CAN:</strong></p>
                  <ul className="list-disc list-inside space-y-0.5 pl-1">
                    <li>Browse projects and deployments</li>
                    <li>Run local builds (Nixpacks / Containerfile)</li>
                    <li>Deploy to <code className="font-mono bg-slate-100 px-0.5 rounded">localhost</code> (containers running on this machine)</li>
                    <li>Use the failure analyzer + auto-fix loop on local deploys</li>
                  </ul>
                  <p className="text-slate-700 pt-1"><strong>Guest mode CAN'T:</strong></p>
                  <ul className="list-disc list-inside space-y-0.5 pl-1">
                    <li>Add remote SSH deployment servers</li>
                    <li>Manage team members</li>
                    <li>Access private GitHub repos</li>
                  </ul>
                </div>
              </details>
            </div>

            <div className="my-5 flex items-center gap-3">
              <div className="h-px flex-1 bg-slate-200" />
              <span className="text-[11px] text-slate-400 uppercase tracking-wider">or use</span>
              <div className="h-px flex-1 bg-slate-200" />
            </div>

            {/* API token — SECONDARY auth method.
                Critically: this field accepts the SERVER's WATCHTOWER_API_TOKEN
                (a deployment-scoped token set when the operator installed
                WatchTower). It does NOT accept a GitHub Personal Access
                Token — the previous label + PAT-creation links here led
                users to create a GitHub PAT, paste it, and get rejected.
                The post-login flow (Settings → Integrations → GitHub)
                is where users actually link a GitHub PAT for repo access. */}
            <div className="text-left">
              <label htmlFor="api-token" className="block text-xs font-medium text-slate-700 mb-1.5">
                Sign in with the server's API token
              </label>

              <div className="mb-3 rounded-lg border border-slate-200 bg-slate-50 px-4 py-3 space-y-2">
                <p className="text-xs text-slate-700">
                  This is the <code className="font-mono bg-white border border-slate-200 px-1 rounded">WATCHTOWER_API_TOKEN</code> set on the server when WatchTower was installed. <strong>It is not a GitHub Personal Access Token.</strong>
                </p>
                <ul className="text-[11px] text-slate-600 list-disc list-inside space-y-0.5">
                  <li>Find it in your server's <code className="font-mono bg-white border border-slate-200 px-0.5 rounded">.env</code> file or systemd unit env</li>
                  <li>If you installed via <code className="font-mono bg-white border border-slate-200 px-0.5 rounded">./run.sh</code>, the dev token is <code className="font-mono bg-white border border-slate-200 px-0.5 rounded">dev-watchtower-token</code></li>
                  <li>For private repo access, link your GitHub account from Settings → Integrations <em>after</em> sign-in</li>
                </ul>
              </div>

              <input
                id="api-token"
                type="password"
                value={tokenInput}
                onChange={(e) => setTokenInput(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && void continueWithToken()}
                className="w-full rounded-lg border border-slate-300 focus:border-red-700 focus:ring-1 focus:ring-red-700 bg-white px-3 py-2 text-sm text-slate-900 outline-none transition"
                placeholder="Paste WATCHTOWER_API_TOKEN"
                autoComplete="current-password"
              />
              <Button
                onClick={() => void continueWithToken()}
                disabled={loading || !tokenInput.trim()}
                variant="outline"
                className="w-full mt-3 rounded-lg text-slate-700"
              >
                {loading ? 'Verifying…' : 'Sign in with API Token'}
              </Button>
            </div>
          </>
          )}
          </>
        )}
      </div>
    </div>
  );
};

export default Login;
