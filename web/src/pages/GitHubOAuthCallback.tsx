import { useEffect, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import apiClient from '@/lib/api';
import { Button } from '@/components/ui/button';

const GitHubOAuthCallback = () => {
  const [searchParams] = useSearchParams();
  const [status, setStatus] = useState<'loading' | 'success' | 'error'>('loading');
  const [detail, setDetail] = useState('');
  const navigate = useNavigate();

  useEffect(() => {
    const code = searchParams.get('code');
    const state = searchParams.get('state');
    const error = searchParams.get('error');

    if (error) {
      setStatus('error');
      setDetail(error === 'access_denied'
        ? 'You declined the GitHub authorization request. No changes were made.'
        : `GitHub returned an error: ${error}`);
      return;
    }

    if (!code || !state) {
      setStatus('error');
      setDetail('The callback URL is missing required parameters (code or state). Try connecting again from the Team page.');
      return;
    }

    const complete = async () => {
      try {
        const redirectUri = `${window.location.origin}/oauth/github/callback`;
        const resp = await apiClient.post('/github/oauth/callback', { code, state, redirect_uri: redirectUri });
        const data = resp.data as { redirect_to?: string };
        setStatus('success');
        const nextPath = data?.redirect_to && data.redirect_to.startsWith('/') ? data.redirect_to : '/team';
        setTimeout(() => navigate(nextPath, { replace: true }), 1200);
      } catch {
        setStatus('error');
        setDetail('The server could not complete the OAuth exchange. Make sure GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET are configured, then try again.');
      }
    };

    void complete();
  }, [searchParams]);

  return (
    <div className="min-h-screen flex items-center justify-center px-6 bg-slate-50">
      <div className="w-full max-w-md rounded-xl px-8 py-10 text-center border border-border bg-white shadow-sm">

        {status === 'loading' && (
          <>
            <div className="text-4xl mb-4 animate-spin inline-block">⌛</div>
            <h1 className="text-base font-semibold mb-1">Connecting GitHub…</h1>
            <p className="text-sm text-slate-600">Completing your GitHub authorization. Please wait.</p>
          </>
        )}

        {status === 'success' && (
          <>
            <div className="text-5xl mb-4">✅</div>
            <h1 className="text-base font-semibold mb-1">GitHub Connected!</h1>
            <p className="text-sm text-slate-600 mb-6">Your GitHub account has been linked to WatchTower. You can now pull repositories for deployments.</p>
            <div className="flex flex-col gap-2">
              <Link to="/team">
                <Button className="w-full rounded-md">→ Go to Team Management</Button>
              </Link>
              <Link to="/">
                <Button variant="outline" className="w-full rounded-md">Dashboard</Button>
              </Link>
            </div>
          </>
        )}

        {status === 'error' && (
          <>
            <div className="text-5xl mb-4">❌</div>
            <h1 className="text-base font-semibold mb-1">Connection failed</h1>
            {detail && (
              <p className="text-sm text-red-700 mb-4 bg-red-50 border border-red-200 rounded-md px-3 py-2 text-left">{detail}</p>
            )}
            <p className="text-xs text-slate-600 mb-6">If the problem persists, check that the API server is running and environment variables are configured correctly.</p>
            <div className="flex flex-col gap-2">
              <Link to="/team">
                <Button className="w-full rounded-md">← Try again from Team page</Button>
              </Link>
              <Link to="/">
                <Button variant="outline" className="w-full rounded-md">Dashboard</Button>
              </Link>
            </div>
          </>
        )}
      </div>
    </div>
  );
};

export default GitHubOAuthCallback;
