import { useEffect, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import apiClient from '@/lib/api';
import { Button } from '@/components/ui/button';
import BrandLogo from '@/components/BrandLogo';

type CallbackStatus = 'loading' | 'success' | 'error';

const GitHubLoginCallback = () => {
  const [searchParams] = useSearchParams();
  const [status, setStatus] = useState<CallbackStatus>('loading');
  const [detail, setDetail] = useState('');
  const navigate = useNavigate();

  useEffect(() => {
    const code = searchParams.get('code');
    const state = searchParams.get('state');
    const error = searchParams.get('error');

    if (error) {
      setStatus('error');
      setDetail(error === 'access_denied' ? 'You cancelled GitHub sign-in.' : `GitHub returned an error: ${error}`);
      return;
    }

    if (!code || !state) {
      setStatus('error');
      setDetail('Missing required OAuth callback parameters. Please retry login.');
      return;
    }

    const complete = async () => {
      try {
        const redirectUri = `${window.location.origin}/oauth/github/login/callback`;
        const resp = await apiClient.post('/auth/github/callback', {
          code,
          state,
          redirect_uri: redirectUri,
        });

        const data = resp.data as { token?: string; redirect_to?: string };
        if (!data.token) {
          throw new Error('No session token returned');
        }

        localStorage.setItem('authToken', data.token);
        const nextPath = data.redirect_to && data.redirect_to.startsWith('/') ? data.redirect_to : '/';

        setStatus('success');
        setTimeout(() => navigate(nextPath, { replace: true }), 600);
      } catch {
        setStatus('error');
        setDetail('Failed to complete GitHub sign-in. Check API OAuth configuration and try again.');
      }
    };

    void complete();
  }, [navigate, searchParams]);

  return (
    <div className="min-h-screen flex items-center justify-center px-6">
      <div className="w-full max-w-md electron-card rounded-xl px-8 py-10 text-center">
        <div className="mb-4 flex justify-center">
          <BrandLogo size="sm" />
        </div>
        {status === 'loading' && (
          <>
            <div className="text-4xl mb-4 animate-spin inline-block">⌛</div>
            <h1 className="text-base font-semibold mb-1">Signing you in...</h1>
            <p className="text-sm text-slate-300">Completing GitHub authentication.</p>
          </>
        )}

        {status === 'success' && (
          <>
            <div className="text-5xl mb-4">✅</div>
            <h1 className="text-base font-semibold mb-1">Signed in</h1>
            <p className="text-sm text-slate-300">Redirecting to your dashboard.</p>
          </>
        )}

        {status === 'error' && (
          <>
            <div className="text-5xl mb-4">❌</div>
            <h1 className="text-base font-semibold mb-1">GitHub sign-in failed</h1>
            <p className="text-sm text-red-600 border border-red-200 bg-red-50 rounded-md px-3 py-2 text-left mb-5">{detail}</p>
            <Link to="/login">
              <Button className="w-full electron-accent-bg rounded-md">Try login again</Button>
            </Link>
          </>
        )}
      </div>
    </div>
  );
};

export default GitHubLoginCallback;
