import { useState } from 'react';
import axios from 'axios';
import apiClient from '@/lib/api';
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

      // Some deployments configure VITE_API_URL with and without `/api`.
      // Probe both common endpoint shapes and use the first successful response.
      const candidates = ['/auth/github/start', '/api/auth/github/start'];
      let authorizeUrl: string | null = null;

      for (const endpoint of candidates) {
        try {
          const resp = await apiClient.get(endpoint, {
            params: { redirect_uri: redirectUri },
          });
          authorizeUrl = (resp.data as { authorize_url?: string }).authorize_url ?? null;
          if (authorizeUrl) break;
        } catch (error) {
          if (!axios.isAxiosError(error) || error.response?.status !== 404) {
            throw error;
          }
        }
      }

      if (!authorizeUrl) {
        throw new Error('OAuth start endpoint not found');
      }

      const popup = window.open(authorizeUrl, '_blank', 'noopener,noreferrer');
      if (!popup) {
        window.location.href = authorizeUrl;
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
