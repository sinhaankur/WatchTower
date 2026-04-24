import { jsx as _jsx, Fragment as _Fragment, jsxs as _jsxs } from "react/jsx-runtime";
import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import apiClient from '@/lib/api';
import { Button } from '@/components/ui/button';
const GitHubOAuthCallback = () => {
    const [searchParams] = useSearchParams();
    const [status, setStatus] = useState('loading');
    const [detail, setDetail] = useState('');
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
                await apiClient.post('/github/oauth/callback', { code, state, redirect_uri: redirectUri });
                setStatus('success');
            }
            catch {
                setStatus('error');
                setDetail('The server could not complete the OAuth exchange. Make sure GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET are configured, then try again.');
            }
        };
        void complete();
    }, [searchParams]);
    return (_jsx("div", { className: "min-h-screen bg-gray-50 flex items-center justify-center px-6", children: _jsxs("div", { className: "w-full max-w-md bg-white border border-gray-200 px-8 py-10 text-center", children: [status === 'loading' && (_jsxs(_Fragment, { children: [_jsx("div", { className: "text-4xl mb-4 animate-spin inline-block", children: "\u231B" }), _jsx("h1", { className: "text-base font-semibold text-gray-900 mb-1", children: "Connecting GitHub\u2026" }), _jsx("p", { className: "text-sm text-gray-500", children: "Completing your GitHub authorization. Please wait." })] })), status === 'success' && (_jsxs(_Fragment, { children: [_jsx("div", { className: "text-5xl mb-4", children: "\u2705" }), _jsx("h1", { className: "text-base font-semibold text-gray-900 mb-1", children: "GitHub Connected!" }), _jsx("p", { className: "text-sm text-gray-500 mb-6", children: "Your GitHub account has been linked to WatchTower. You can now pull repositories for deployments." }), _jsxs("div", { className: "flex flex-col gap-2", children: [_jsx(Link, { to: "/team", children: _jsx(Button, { className: "w-full bg-gray-900 text-white hover:bg-gray-800 rounded-none", children: "\u2192 Go to Team Management" }) }), _jsx(Link, { to: "/", children: _jsx(Button, { variant: "outline", className: "w-full rounded-none border-gray-300", children: "Dashboard" }) })] })] })), status === 'error' && (_jsxs(_Fragment, { children: [_jsx("div", { className: "text-5xl mb-4", children: "\u274C" }), _jsx("h1", { className: "text-base font-semibold text-gray-900 mb-1", children: "Connection failed" }), detail && (_jsx("p", { className: "text-sm text-red-600 mb-4 bg-red-50 border border-red-200 px-3 py-2 text-left", children: detail })), _jsx("p", { className: "text-xs text-gray-400 mb-6", children: "If the problem persists, check that the API server is running and environment variables are configured correctly." }), _jsxs("div", { className: "flex flex-col gap-2", children: [_jsx(Link, { to: "/team", children: _jsx(Button, { className: "w-full bg-gray-900 text-white hover:bg-gray-800 rounded-none", children: "\u2190 Try again from Team page" }) }), _jsx(Link, { to: "/", children: _jsx(Button, { variant: "outline", className: "w-full rounded-none border-gray-300", children: "Dashboard" }) })] })] }))] }) }));
};
export default GitHubOAuthCallback;
