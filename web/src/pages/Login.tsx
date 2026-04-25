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

  return (
    <div className="min-h-screen flex items-center justify-center px-6 bg-transparent">
      <div className="w-full max-w-md rounded-2xl px-8 py-10 text-center border border-border bg-white/95 backdrop-blur-sm shadow-sm fade-in-up">
        <div className="mb-4 flex justify-center">
          <BrandLogo size="lg" withLabel subtitle="Secure Team Access" />
        </div>
        <h1 className="text-2xl font-semibold mb-2 text-slate-900">Sign in to WatchTower</h1>
        <p className="text-sm text-slate-600 mb-6">Simple login for your team. Use GitHub OAuth or a shared API token.</p>

        {!statusLoading && authStatus && (
          <div className="text-left text-xs mb-4 rounded-md border border-slate-200 bg-slate-50 px-3 py-2">
            <p className="text-slate-700">Auth status:</p>
            <p className="mt-1 text-slate-600">
              GitHub OAuth: {authStatus.oauth?.github_configured ? 'configured' : 'not configured'}
            </p>
            <p className="text-slate-600">
              API token: {authStatus.api_token?.configured ? 'configured' : 'not configured'}
            </p>
            <p className="text-slate-600">
              Install owner mode: {authStatus.installation?.owner_mode_enabled ? 'enabled' : 'disabled'}
            </p>
            {authStatus.oauth?.missing && authStatus.oauth.missing.length > 0 && (
              <p className="mt-1 text-amber-700">
                Missing: {authStatus.oauth.missing.join(', ')}
              </p>
            )}
          </div>
        )}

        {error && (
          <div className="text-sm text-red-700 border border-red-200 bg-red-50 rounded-md px-3 py-2 mb-4 text-left">
            {error}
          </div>
        )}

        <Button
          onClick={() => void loginWithGitHub()}
          disabled={loading || (!statusLoading && !oauthReady)}
          className="w-full rounded-lg"
        >
          {loading ? 'Redirecting...' : 'Sign in with GitHub'}
        </Button>
        {!statusLoading && !oauthReady && (
          <p className="mt-2 text-xs text-amber-700 text-left">
            GitHub OAuth is currently not configured on the server. Use API token login below.
          </p>
        )}

        <div className="my-4 flex items-center gap-3">
          <div className="h-px flex-1 bg-slate-200" />
          <span className="text-[11px] text-slate-500 uppercase tracking-wider">or</span>
          <div className="h-px flex-1 bg-slate-200" />
        </div>

        <div className="text-left">
          <label htmlFor="api-token" className="block text-xs text-slate-700 mb-1.5">
            API Token (WATCHTOWER_API_TOKEN)
          </label>
          <input
            id="api-token"
            type="password"
            value={tokenInput}
            onChange={(e) => setTokenInput(e.target.value)}
            className="w-full rounded-lg border border-slate-800 bg-white px-3 py-2 text-sm text-slate-900"
            placeholder="Paste shared team token"
          />
          <Button
            onClick={() => void continueWithToken()}
            disabled={loading}
            variant="outline"
            className="w-full mt-3 rounded-lg"
          >
            Continue with API Token
          </Button>
        </div>
      </div>
    </div>
  );
};

export default Login;
