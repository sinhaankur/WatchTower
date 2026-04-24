import { useState } from 'react';
import { Button } from '@/components/ui/button';
import BrandLogo from '@/components/BrandLogo';

const Login = () => {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const loginWithGitHub = async () => {
    setLoading(true);
    setError('');
    try {
      const redirectUri = `${window.location.origin}/oauth/github/login/callback`;
      const apiBase = ((import.meta as any).env?.VITE_API_URL as string | undefined) || '/api';
      const resolvedApiBase = apiBase.startsWith('http') ? apiBase : `${window.location.origin}${apiBase}`;
      const loginUrl = `${resolvedApiBase}/auth/github/login?redirect_uri=${encodeURIComponent(redirectUri)}`;
      const popup = window.open(loginUrl, '_blank', 'noopener,noreferrer');
      if (!popup) {
        window.location.href = loginUrl;
      }
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
          {loading ? 'Redirecting…' : 'Sign in with GitHub'}
        </Button>
      </div>
    </div>
  );
};

export default Login;
