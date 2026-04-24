import { useEffect, useState } from 'react';
import { useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import BrandLogo from '@/components/BrandLogo';

const Login = () => {
  const navigate = useNavigate();
  const location = useLocation();
  const [searchParams] = useSearchParams();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    const existing = localStorage.getItem('authToken');
    if (existing) {
      navigate('/', { replace: true });
    }
  }, [navigate]);

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
      window.location.assign(`${loginUrl}?${params.toString()}`);
    } catch {
      setError('Unable to start GitHub login. Ensure GITHUB_OAUTH_CLIENT_ID/GITHUB_CLIENT_ID and GITHUB_OAUTH_CLIENT_SECRET/GITHUB_CLIENT_SECRET are configured on the API server.');
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center px-6">
      <div className="w-full max-w-md electron-card rounded-xl px-8 py-10 text-center">
        <div className="mb-3 flex justify-center">
          <BrandLogo size="lg" />
        </div>
        <h1 className="text-xl font-semibold mb-2">Sign in to continue</h1>
        <p className="text-sm text-slate-300 mb-6">Use your GitHub account for seamless project and team access.</p>

        {error && (
          <div className="text-sm text-red-700 border border-red-200 bg-red-50 rounded-md px-3 py-2 mb-4 text-left">
            {error}
          </div>
        )}

        <Button
          onClick={() => void loginWithGitHub()}
          disabled={loading}
          className="w-full electron-accent-bg rounded-md"
        >
          {loading ? 'Redirecting...' : 'Sign in with GitHub'}
        </Button>
      </div>
    </div>
  );
};

export default Login;
