import { useEffect, useState } from 'react';
import { useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import apiClient from '@/lib/api';
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

  useEffect(() => {
    // Auto-login: Electron injects VITE_API_TOKEN into the Vite process at launch.
    // If present, store it and go straight to the dashboard.
    const injectedToken = (import.meta as any).env?.VITE_API_TOKEN as string | undefined;
    if (injectedToken && injectedToken.trim()) {
      localStorage.setItem('authToken', injectedToken.trim());
      navigate('/', { replace: true });
      return;
    }
    const existing = localStorage.getItem('authToken');
    if (existing) {
      navigate('/', { replace: true });
    }
  }, [navigate]);

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
      await apiClient.get('/context');
      navigate('/', { replace: true });
    } catch {
      localStorage.removeItem('authToken');
      setError('Authentication failed. If installation ownership is enabled, your account must be invited by an owner/admin before access is granted.');
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
        setLoading(false);
      } else {
        window.location.assign(oauthUrl);
      }
    } catch {
      setError('Unable to start GitHub login. Ensure GITHUB_OAUTH_CLIENT_ID/GITHUB_CLIENT_ID and GITHUB_OAUTH_CLIENT_SECRET/GITHUB_CLIENT_SECRET are configured on the API server.');
      setLoading(false);
    }
  };

  // Determine if the server has anything configured at all
  const apiTokenConfigured = Boolean(authStatus?.api_token?.configured);
  const nothingConfigured = !statusLoading && authStatus && !oauthReady && !apiTokenConfigured && !authStatus?.dev_auth?.allow_insecure;

  return (
    <div className="min-h-screen flex items-center justify-center px-6 bg-transparent">
      <div className="w-full max-w-md rounded-2xl px-8 py-10 text-center border border-border bg-white/95 backdrop-blur-sm shadow-sm fade-in-up">
        <div className="mb-4 flex justify-center">
          <BrandLogo size="lg" withLabel subtitle="Secure Team Access" />
        </div>
        <h1 className="text-2xl font-semibold mb-2 text-slate-900">Sign in to WatchTower</h1>
        <p className="text-sm text-slate-600 mb-6">
          {oauthReady ? 'Sign in with your GitHub account or use an API token.' : 'Use your shared API token to sign in.'}
        </p>

        {/* Server not configured at all */}
        {nothingConfigured && (
          <div className="text-left text-sm mb-5 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 space-y-1">
            <p className="font-medium text-amber-800">Server setup required</p>
            <p className="text-amber-700 text-xs">
              Set <code className="font-mono bg-amber-100 px-1 rounded">WATCHTOWER_API_TOKEN</code> on the server to enable login,
              or configure GitHub OAuth credentials to allow team sign-in.
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
            {/* GitHub OAuth — only shown when configured */}
            {oauthReady && (
              <>
                <Button
                  onClick={() => void loginWithGitHub()}
                  disabled={loading}
                  className="w-full rounded-lg bg-slate-900 hover:bg-slate-800 text-white gap-2"
                >
                  {loading ? (
                    <span className="inline-flex items-center gap-2">
                      <span className="inline-block w-3.5 h-3.5 border-2 border-white/40 border-t-white rounded-full animate-spin" />
                      Redirecting…
                    </span>
                  ) : (
                    <span className="inline-flex items-center gap-2">
                      {/* GitHub mark */}
                      <svg viewBox="0 0 16 16" width="16" height="16" fill="currentColor" aria-hidden="true">
                        <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/>
                      </svg>
                      Continue with GitHub
                    </span>
                  )}
                </Button>

                <div className="my-4 flex items-center gap-3">
                  <div className="h-px flex-1 bg-slate-200" />
                  <span className="text-[11px] text-slate-400 uppercase tracking-wider">or</span>
                  <div className="h-px flex-1 bg-slate-200" />
                </div>
              </>
            )}

            {/* API token */}
            <div className="text-left">
              {!oauthReady && (
                <p className="text-xs text-slate-500 mb-3 text-center">
                  Enter the <code className="font-mono bg-slate-100 px-1 rounded">WATCHTOWER_API_TOKEN</code> set on the server.
                </p>
              )}
              <label htmlFor="api-token" className="block text-xs font-medium text-slate-700 mb-1.5">
                {oauthReady ? 'API Token' : 'API Token'}
              </label>
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
                variant={oauthReady ? 'outline' : 'default'}
                className={`w-full mt-3 rounded-lg ${!oauthReady ? 'bg-red-700 hover:bg-red-800 text-white border-slate-800 shadow-[2px_2px_0_0_#1f2937]' : ''}`}
              >
                {loading ? 'Verifying…' : 'Continue with API Token'}
              </Button>
            </div>
          </>
        )}
      </div>
    </div>
  );
};

export default Login;
