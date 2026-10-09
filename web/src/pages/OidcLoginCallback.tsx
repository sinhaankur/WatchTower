import { useEffect, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import apiClient from '@/lib/api';
import { Button } from '@/components/ui/button';
import BrandLogo from '@/components/BrandLogo';
import { Spinner } from '@/components/Spinner';

type CallbackStatus = 'loading' | 'success' | 'error';

// Generic OIDC (Google / GitLab / Okta / Authentik / …) callback. Mirrors
// GitHubLoginCallback exactly but posts to /auth/oidc/callback. The backend
// verifies the signed state + nonce, exchanges the code, and returns the
// same WatchTower session token shape, so this handler stays provider-neutral.
const OidcLoginCallback = () => {
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
      setDetail(error === 'access_denied' ? 'You cancelled sign-in.' : `The provider returned an error: ${error}`);
      return;
    }

    if (!code || !state) {
      setStatus('error');
      setDetail('Missing required OAuth callback parameters. Please retry login.');
      return;
    }

    const complete = async () => {
      try {
        const redirectUri = `${window.location.origin}/oauth/oidc/login/callback`;
        const resp = await apiClient.post('/auth/oidc/callback', {
          code,
          state,
          redirect_uri: redirectUri,
        });

        const data = resp.data as { token?: string; redirect_to?: string };
        if (!data.token) {
          throw new Error('No session token returned');
        }

        localStorage.setItem('authToken', data.token);
        localStorage.removeItem('wt:explicitlySignedOut');
        const nextPath = data.redirect_to && data.redirect_to.startsWith('/') ? data.redirect_to : '/';

        setStatus('success');

        const electron = (window as any).electronAPI;
        if (electron?.oauthDone) {
          setTimeout(() => electron.oauthDone(), 600);
        } else {
          setTimeout(() => navigate(nextPath, { replace: true }), 600);
        }
      } catch {
        setStatus('error');
        setDetail('Failed to complete sign-in. Ask your administrator to check the OIDC configuration and try again.');
      }
    };

    void complete();
  }, [navigate, searchParams]);

  return (
    <div className="min-h-screen flex items-center justify-center px-6 bg-muted">
      <div className="w-full max-w-md rounded-xl px-8 py-10 text-center border border-border bg-card shadow-sm">
        <div className="mb-4 flex justify-center">
          <BrandLogo size="sm" />
        </div>
        {status === 'loading' && (
          <>
            <div className="mb-4 inline-flex items-center justify-center">
              <Spinner size={32} label="Signing in" />
            </div>
            <h1 className="text-base font-semibold mb-1">Signing you in…</h1>
            <p className="text-sm text-muted-foreground">Completing sign-in with your provider.</p>
          </>
        )}

        {status === 'success' && (
          <>
            <div className="text-5xl mb-4">✅</div>
            <h1 className="text-base font-semibold mb-1">Signed in</h1>
            <p className="text-sm text-muted-foreground">Redirecting to your dashboard.</p>
          </>
        )}

        {status === 'error' && (
          <>
            <div className="text-5xl mb-4">❌</div>
            <h1 className="text-base font-semibold mb-1">Sign-in failed</h1>
            <p className="text-sm text-destructive border border-destructive/30 bg-destructive/10 rounded-md px-3 py-2 text-left mb-5">{detail}</p>
            <Link to="/login">
              <Button className="w-full rounded-md">Try login again</Button>
            </Link>
          </>
        )}
      </div>
    </div>
  );
};

export default OidcLoginCallback;
