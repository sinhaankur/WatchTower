import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import apiClient from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

const GitHubOAuthCallback = () => {
  const [searchParams] = useSearchParams();
  const [status, setStatus] = useState<'loading' | 'success' | 'error'>('loading');
  const [message, setMessage] = useState('Finalizing GitHub connection...');

  useEffect(() => {
    const code = searchParams.get('code');
    const state = searchParams.get('state');
    const error = searchParams.get('error');

    if (error) {
      setStatus('error');
      setMessage(`OAuth authorization failed: ${error}`);
      return;
    }

    if (!code || !state) {
      setStatus('error');
      setMessage('Missing OAuth code or state in callback URL.');
      return;
    }

    const complete = async () => {
      try {
        const redirectUri = `${window.location.origin}/oauth/github/callback`;
        await apiClient.post('/github/oauth/callback', {
          code,
          state,
          redirect_uri: redirectUri,
        });
        setStatus('success');
        setMessage('GitHub account connected successfully.');
      } catch {
        setStatus('error');
        setMessage('Failed to complete OAuth callback. Check API credentials and retry.');
      }
    };

    void complete();
  }, [searchParams]);

  return (
    <div className="min-h-screen bg-white flex items-center justify-center px-6">
      <Card className="w-full max-w-xl rounded-none border-gray-200 shadow-none">
        <CardHeader>
          <CardTitle>GitHub OAuth Callback</CardTitle>
          <CardDescription>Completing account connection for WatchTower.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className={`text-sm ${status === 'error' ? 'text-red-700' : 'text-gray-700'}`}>{message}</p>
          <div className="flex gap-3">
            <Link to="/team" className="flex-1">
              <Button className="w-full bg-gray-900 text-white hover:bg-gray-800 rounded-none">Go To Team Management</Button>
            </Link>
            <Link to="/" className="flex-1">
              <Button variant="outline" className="w-full rounded-none border-gray-300">Dashboard</Button>
            </Link>
          </div>
        </CardContent>
      </Card>
    </div>
  );
};

export default GitHubOAuthCallback;
