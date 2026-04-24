import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import apiClient from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
const GitHubOAuthCallback = () => {
    const [searchParams] = useSearchParams();
    const [status, setStatus] = useState('loading');
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
            }
            catch {
                setStatus('error');
                setMessage('Failed to complete OAuth callback. Check API credentials and retry.');
            }
        };
        void complete();
    }, [searchParams]);
    return (_jsx("div", { className: "min-h-screen bg-white flex items-center justify-center px-6", children: _jsxs(Card, { className: "w-full max-w-xl rounded-none border-gray-200 shadow-none", children: [_jsxs(CardHeader, { children: [_jsx(CardTitle, { children: "GitHub OAuth Callback" }), _jsx(CardDescription, { children: "Completing account connection for WatchTower." })] }), _jsxs(CardContent, { className: "space-y-4", children: [_jsx("p", { className: `text-sm ${status === 'error' ? 'text-red-700' : 'text-gray-700'}`, children: message }), _jsxs("div", { className: "flex gap-3", children: [_jsx(Link, { to: "/team", className: "flex-1", children: _jsx(Button, { className: "w-full bg-gray-900 text-white hover:bg-gray-800 rounded-none", children: "Go To Team Management" }) }), _jsx(Link, { to: "/", className: "flex-1", children: _jsx(Button, { variant: "outline", className: "w-full rounded-none border-gray-300", children: "Dashboard" }) })] })] })] }) }));
};
export default GitHubOAuthCallback;
