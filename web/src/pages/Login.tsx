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
  api_token?: {
    configured?: boolean;
  };
  dev_auth?: {
    allow_insecure?: boolean;
  };
  installation?: {
    owner_mode_enabled?: boolean;
  };
  recommended?: 'oauth' | 'api_token';
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
};

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

  const [loggedInUser, setLoggedInUser] = useState<LoggedInUser | null>(null);

  const showSuccessAndRedirect = (user: LoggedInUser, delayMs = 1600) => {
    setLoggedInUser(user);
    window.setTimeout(() => navigate('/', { replace: true }), delayMs);
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
    if (testLoginEnabled) {
      setLoggedInUser({ name: 'Test User', email: 'test@example.com', isTest: true });
      return;
    }

    const hydrateExistingSession = async (token: string) => {
      localStorage.setItem('authToken', token);
      const user = await resolveUserFromContext();
      showSuccessAndRedirect(user, 1800);
    };

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
  }, [navigate, searchParams]);

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
      const user = await resolveUserFromContext();
      trackEvent('login', { method: 'api_token' });
      showSuccessAndRedirect(user);
    } catch {
      localStorage.removeItem('authToken');
      setError('Authentication failed. If installation ownership is enabled, your account must be invited by an owner/admin before access is granted.');
      setLoading(false);
    }
  };

  const devAutoLogin = async () => {
    setLoading(true);
    setError('');
    try {
      const devToken = 'dev-' + Math.random().toString(36).slice(2, 10);
      localStorage.setItem('authToken', devToken);
      const user = await resolveUserFromContext();
      trackEvent('login', { method: 'dev_auto' });
      showSuccessAndRedirect(user);
    } catch {
      localStorage.removeItem('authToken');
      setError('Dev auto-login failed. Check that WATCHTOWER_ALLOW_INSECURE_DEV_AUTH=true on the server.');
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
      setError('Unable to start GitHub login. Ensure GITHUB_OAUTH_CLIENT_ID/GITHUB_CLIENT_ID and GITHUB_OAUTH_CLIENT_SECRET/GITHUB_CLIENT_SECRET are configured on the API server.');
      setLoading(false);
    }
  };

  const openGitHubTokenGenerator = () => {
    trackEvent('login', { method: 'token_generator_opened', type: 'fine_grained' });
    window.open('https://github.com/settings/personal-access-tokens/new', '_blank', 'noopener,noreferrer');
  };

  const openClassicPATGenerator = () => {
    trackEvent('login', { method: 'token_generator_opened', type: 'classic' });
    window.open(
      'https://github.com/settings/tokens/new?scopes=repo,read%3Apackages&description=WatchTower+API+Token',
      '_blank',
      'noopener,noreferrer'
    );
  };

  // Determine if the server has anything configured at all
  const apiTokenConfigured = Boolean(authStatus?.api_token?.configured);
  const nothingConfigured = !statusLoading && authStatus && !oauthReady && !apiTokenConfigured && !authStatus?.dev_auth?.allow_insecure;

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
                {loggedInUser.name ? `Welcome, ${loggedInUser.name}!` : 'Successfully authenticated with GitHub'}
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
            <p className="text-sm text-slate-600 mb-6">
              Use GitHub to authenticate, or enter an API token below.
            </p>
            <div className="mb-4">
              <button
                type="button"
                onClick={() => setLoggedInUser({ name: 'Test User', email: 'test@example.com', isTest: true })}
                className="text-[11px] text-slate-500 hover:text-slate-800 underline underline-offset-2"
              >
                Test logged-in success screen
              </button>
            </div>

        {/* Dev mode: one-click login */}
        {!statusLoading && authStatus?.dev_auth?.allow_insecure && (
          <div className="mb-5 rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 text-left">
            <p className="text-sm font-semibold text-amber-800 mb-1">🛠 Dev mode active</p>
            <p className="text-xs text-amber-700 mb-3">
              Server is running with <code className="font-mono bg-amber-100 px-1 rounded">WATCHTOWER_ALLOW_INSECURE_DEV_AUTH=true</code>.
              Any token is accepted — click below to log in instantly.
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
              {!oauthReady && (
                  <div className="text-left text-xs rounded-lg border border-blue-200 bg-blue-50 px-3 py-2 text-blue-700 mb-3">
                  <p className="font-medium text-blue-800 mb-1">GitHub not configured yet</p>
                  <p>Ask your admin to set <code className="font-mono bg-blue-100 px-1 rounded text-xs">GITHUB_OAUTH_CLIENT_ID</code> and <code className="font-mono bg-blue-100 px-1 rounded text-xs">GITHUB_OAUTH_CLIENT_SECRET</code></p>
                  </div>
              )}
              <Button
                onClick={() => void loginWithGitHub()}
                disabled={loading || !oauthReady}
                className={`w-full rounded-lg gap-2 py-6 text-base font-semibold flex items-center justify-center ${
                  oauthReady
                    ? 'bg-slate-900 hover:bg-slate-800 text-white'
                    : 'bg-slate-300 text-slate-500 cursor-not-allowed'
                }`}
              >
                {loading ? (
                    <span className="inline-flex items-center gap-2">
                    <span className="inline-block w-4 h-4 border-2 border-white/40 border-t-white rounded-full animate-spin" />
                    Redirecting to GitHub…
                    </span>
                ) : (
                    <span className="inline-flex items-center gap-2">
                    {/* GitHub mark */}
                    <svg viewBox="0 0 16 16" width="20" height="20" fill="currentColor" aria-hidden="true">
                      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/>
                    </svg>
                    <span>{oauthReady ? 'Sign in with GitHub' : 'GitHub Login (Not Ready)'}</span>
                    </span>
                )}
              </Button>
              {oauthReady && (
                  <p className="text-xs text-slate-600 text-center">
                  ✓ Browser opens GitHub → authenticate → returns here automatically
                  </p>
              )}
            </div>

            <div className="my-5 flex items-center gap-3">
              <div className="h-px flex-1 bg-slate-200" />
              <span className="text-[11px] text-slate-400 uppercase tracking-wider">or use</span>
              <div className="h-px flex-1 bg-slate-200" />
            </div>

            {/* API token — SECONDARY auth method */}
            <div className="text-left">
              <label htmlFor="api-token" className="block text-xs font-medium text-slate-700 mb-1.5">
                Sign in with a GitHub Personal Access Token
              </label>

              {/* PAT generation links */}
              <div className="mb-3 rounded-lg border border-slate-200 bg-slate-50 px-4 py-3 space-y-2">
                <p className="text-xs font-medium text-slate-700 flex items-center gap-1.5">
                  <svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor" className="shrink-0 text-slate-500" aria-hidden="true">
                    <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/>
                  </svg>
                  Create a GitHub token, paste it below
                </p>
                <div className="flex flex-col gap-1.5">
                  <a
                    href="https://github.com/settings/personal-access-tokens/new"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex items-center justify-between rounded-md border border-slate-300 bg-white hover:bg-slate-100 px-3 py-2 text-xs text-slate-800 transition-colors group"
                  >
                    <span className="font-medium">Fine-grained PAT <span className="text-slate-400 font-normal">(recommended)</span></span>
                    <span className="text-slate-400 group-hover:text-slate-700 text-[10px]">github.com ↗</span>
                  </a>
                  <a
                    href="https://github.com/settings/tokens/new?scopes=repo,read%3Apackages&description=WatchTower+API+Token"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex items-center justify-between rounded-md border border-slate-300 bg-white hover:bg-slate-100 px-3 py-2 text-xs text-slate-800 transition-colors group"
                  >
                    <span className="font-medium">Classic PAT</span>
                    <span className="text-slate-400 group-hover:text-slate-700 text-[10px]">github.com ↗</span>
                  </a>
                </div>
                <p className="text-[11px] text-slate-500">
                  Required scopes: <code className="font-mono bg-white border border-slate-200 px-1 rounded">Contents: Read</code> · <code className="font-mono bg-white border border-slate-200 px-1 rounded">Packages: Read</code>
                </p>
              </div>

              <div className="mb-2">
                <p className="text-xs text-slate-500 mb-0 text-center hidden">
                  Paste a <code className="font-mono bg-slate-100 px-1 rounded">WATCHTOWER_API_TOKEN</code> from your server
                </p>
              </div>
              <div className="mb-2 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 hidden">
                <p className="text-[11px] text-slate-700 mb-2">
                  Need a GitHub token? Generate one with <span className="font-semibold">Contents: Read</span> and <span className="font-semibold">Packages: Read</span> (for private GHCR images).
                </p>
                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={openGitHubTokenGenerator}
                    className="flex-1 text-[11px] bg-red-700 hover:bg-red-800 text-white rounded px-2 py-1 transition-colors"
                  >
                    Fine-grained <span className="opacity-75">(recommended)</span>
                  </button>
                  <button
                    type="button"
                    onClick={openClassicPATGenerator}
                    className="flex-1 text-[11px] border border-slate-300 hover:border-slate-400 text-slate-600 hover:text-slate-800 rounded px-2 py-1 transition-colors"
                  >
                    Classic PAT
                  </button>
                </div>
              </div>
              <input
                id="api-token"
                type="password"
                value={tokenInput}
                onChange={(e) => setTokenInput(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && void continueWithToken()}
                className="w-full rounded-lg border border-slate-300 focus:border-red-700 focus:ring-1 focus:ring-red-700 bg-white px-3 py-2 text-sm text-slate-900 outline-none transition"
                placeholder="Paste your API token"
                autoComplete="current-password"
              />
              <Button
                onClick={() => void continueWithToken()}
                disabled={loading || !tokenInput.trim()}
                variant="outline"
                className="w-full mt-3 rounded-lg text-slate-700"
              >
                {loading ? 'Verifying…' : 'Sign in with Token'}
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
