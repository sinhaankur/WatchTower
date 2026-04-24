import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useEffect, useMemo, useState } from 'react';
import apiClient from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
const ROLE_META = {
    owner: { label: 'Owner', color: 'bg-amber-50 text-amber-700 border-amber-200' },
    admin: { label: 'Admin', color: 'bg-purple-50 text-purple-700 border-purple-200' },
    developer: { label: 'Developer', color: 'bg-blue-50 text-blue-700 border-blue-200' },
    viewer: { label: 'Viewer', color: 'bg-gray-50 text-gray-600 border-gray-200' },
};
const TeamManagement = () => {
    const [orgId, setOrgId] = useState('');
    const [orgName, setOrgName] = useState('');
    const [members, setMembers] = useState([]);
    const [connections, setConnections] = useState([]);
    const [email, setEmail] = useState('');
    const [role, setRole] = useState('developer');
    const [loading, setLoading] = useState(false);
    const [offlineMode, setOfflineMode] = useState(false);
    const [pageError, setPageError] = useState('');
    const [actionError, setActionError] = useState('');
    const [actionSuccess, setActionSuccess] = useState('');
    const [inviting, setInviting] = useState(false);
    const ownerCount = useMemo(() => members.filter((m) => m.role === 'owner').length, [members]);
    const refreshData = async (currentOrgId) => {
        try {
            const [membersResp, connectionsResp] = await Promise.all([
                apiClient.get(`/orgs/${currentOrgId}/team-members`),
                apiClient.get(`/orgs/${currentOrgId}/github-connections`),
            ]);
            setMembers(membersResp.data);
            setConnections(connectionsResp.data);
        }
        catch {
            // non-fatal
        }
    };
    const loadContext = async () => {
        setLoading(true);
        setPageError('');
        setOfflineMode(false);
        try {
            const ctxResp = await apiClient.get('/context');
            const context = ctxResp.data;
            setOrgId(context.organization.id);
            setOrgName(context.organization.name);
            await refreshData(context.organization.id);
        }
        catch {
            setOfflineMode(true);
            setPageError('Could not connect to the WatchTower server. Check that the API is running and your API token is configured.');
        }
        finally {
            setLoading(false);
        }
    };
    useEffect(() => { void loadContext(); }, []);
    const inviteMember = async () => {
        if (!orgId || !email.trim())
            return;
        setInviting(true);
        setActionError('');
        setActionSuccess('');
        try {
            await apiClient.post(`/orgs/${orgId}/team-members`, {
                email,
                role,
                can_create_projects: true,
                can_manage_deployments: role === 'owner' || role === 'admin',
                can_manage_nodes: role === 'owner' || role === 'admin',
                can_manage_team: role === 'owner' || role === 'admin',
            });
            setEmail('');
            setRole('developer');
            setActionSuccess(`Invitation sent to ${email}.`);
            await refreshData(orgId);
        }
        catch {
            setActionError('Failed to invite member. Check the email address and try again.');
        }
        finally {
            setInviting(false);
        }
    };
    const startOAuth = async (provider) => {
        if (!orgId)
            return;
        setActionError('');
        try {
            const redirectUri = `${window.location.origin}/oauth/github/callback`;
            const resp = await apiClient.get('/github/oauth/start', {
                params: { org_id: orgId, provider, redirect_uri: redirectUri },
            });
            window.location.href = resp.data.authorize_url;
        }
        catch {
            setActionError('GitHub OAuth setup failed. Ensure GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET are set on the server.');
        }
    };
    return (_jsxs("div", { className: "flex-1 overflow-auto bg-gray-50", children: [_jsx("header", { className: "bg-white border-b border-gray-100", children: _jsxs("div", { className: "px-8 py-5 flex items-center justify-between", children: [_jsxs("div", { children: [_jsx("h1", { className: "text-base font-semibold text-gray-900", children: "Team" }), _jsx("p", { className: "text-xs text-gray-400 mt-0.5", children: loading ? 'Loading…' : orgName ? `Organization: ${orgName}` : offlineMode ? 'Server offline — showing cached data' : '' })] }), offlineMode && (_jsx(Button, { variant: "outline", onClick: () => void loadContext(), className: "rounded-none border-gray-300 text-sm", children: "\u21BA Retry Connection" }))] }) }), _jsxs("main", { className: "px-8 py-6 space-y-6 max-w-4xl", children: [pageError && (_jsxs("div", { className: "flex items-start gap-3 border border-amber-200 bg-amber-50 px-4 py-3", children: [_jsx("span", { className: "text-amber-500 mt-0.5", children: "\u26A0" }), _jsxs("div", { children: [_jsx("p", { className: "text-sm font-medium text-amber-800", children: "Connection issue" }), _jsx("p", { className: "text-sm text-amber-700 mt-0.5", children: pageError })] })] })), actionSuccess && (_jsxs("div", { className: "flex items-center gap-2 border border-green-200 bg-green-50 px-4 py-3", children: [_jsx("span", { className: "text-green-500", children: "\u2713" }), _jsx("p", { className: "text-sm text-green-700", children: actionSuccess })] })), actionError && (_jsxs("div", { className: "flex items-start gap-2 border border-red-200 bg-red-50 px-4 py-3", children: [_jsx("span", { className: "text-red-500 mt-0.5", children: "\u2717" }), _jsx("p", { className: "text-sm text-red-700", children: actionError })] })), _jsxs("div", { className: "grid md:grid-cols-2 gap-5", children: [_jsxs(Card, { className: "rounded-none border-gray-200 shadow-none bg-white", children: [_jsxs(CardHeader, { className: "pb-3", children: [_jsx(CardTitle, { className: "text-base", children: "Invite a Team Member" }), _jsx(CardDescription, { children: "Send an invite by email and choose their access level." })] }), _jsxs(CardContent, { className: "space-y-4", children: [_jsxs("div", { children: [_jsx(Label, { htmlFor: "invite_email", children: "Email address" }), _jsx(Input, { id: "invite_email", type: "email", value: email, onChange: (e) => setEmail(e.target.value), onKeyDown: (e) => e.key === 'Enter' && void inviteMember(), className: "mt-1.5 rounded-none border-gray-300", placeholder: "engineer@example.com" })] }), _jsxs("div", { children: [_jsx(Label, { htmlFor: "invite_role", children: "Role" }), _jsxs("select", { id: "invite_role", value: role, onChange: (e) => setRole(e.target.value), className: "mt-1.5 w-full border border-gray-300 h-10 px-3 text-sm bg-white", children: [_jsx("option", { value: "developer", children: "Developer \u2014 can create projects & deploy" }), _jsx("option", { value: "viewer", children: "Viewer \u2014 read-only access" }), _jsx("option", { value: "admin", children: "Admin \u2014 manage nodes, team & deployments" }), _jsx("option", { value: "owner", children: "Owner \u2014 full access" })] })] }), _jsx(Button, { onClick: () => void inviteMember(), disabled: inviting || offlineMode || !orgId || !email.trim(), className: "w-full bg-gray-900 text-white hover:bg-gray-800 rounded-none", children: inviting ? 'Sending invite…' : offlineMode ? 'Server offline' : 'Send Invite' })] })] }), _jsxs(Card, { className: "rounded-none border-gray-200 shadow-none bg-white", children: [_jsxs(CardHeader, { className: "pb-3", children: [_jsx(CardTitle, { className: "text-base", children: "GitHub Connections" }), _jsx(CardDescription, { children: "Link GitHub accounts so WatchTower can pull repositories." })] }), _jsxs(CardContent, { className: "space-y-3", children: [_jsxs("div", { className: "grid grid-cols-2 gap-2", children: [_jsx(Button, { onClick: () => void startOAuth('github_com'), disabled: loading || !orgId || offlineMode, className: "bg-gray-900 text-white hover:bg-gray-800 rounded-none text-sm", children: "\uD83D\uDD17 GitHub.com" }), _jsx(Button, { onClick: () => void startOAuth('github_enterprise'), disabled: loading || !orgId || offlineMode, variant: "outline", className: "rounded-none border-gray-300 text-sm", children: "\uD83C\uDFE2 GitHub Enterprise" })] }), _jsx("p", { className: "text-xs text-gray-400", children: "You'll be redirected to GitHub to authorize access." }), connections.length === 0 && !loading && (_jsx("div", { className: "py-4 text-center border border-dashed border-gray-200", children: _jsx("p", { className: "text-xs text-gray-400", children: "No GitHub accounts connected yet." }) })), _jsx("div", { className: "space-y-2", children: connections.map((conn) => (_jsxs("div", { className: "border border-gray-200 bg-gray-50 px-3 py-2.5 flex items-center justify-between", children: [_jsxs("div", { children: [_jsxs("p", { className: "text-sm font-semibold text-gray-900", children: ["@", conn.github_username] }), _jsxs("p", { className: "text-xs text-gray-500 mt-0.5", children: [conn.provider === 'github_enterprise' ? (conn.enterprise_name ?? 'GitHub Enterprise') : 'GitHub.com', conn.is_primary && _jsx("span", { className: "ml-2 text-blue-600", children: "\u00B7 Primary" })] })] }), _jsx("span", { className: `text-xs px-2 py-0.5 border rounded-full ${conn.is_active ? 'bg-green-50 text-green-700 border-green-200' : 'bg-gray-100 text-gray-400 border-gray-200'}`, children: conn.is_active ? 'Active' : 'Inactive' })] }, conn.id))) })] })] })] }), _jsxs(Card, { className: "rounded-none border-gray-200 shadow-none bg-white", children: [_jsxs(CardHeader, { className: "pb-3", children: [_jsx(CardTitle, { className: "text-base", children: "Team Members" }), _jsx(CardDescription, { children: loading ? 'Loading members…' : `${members.length} member${members.length !== 1 ? 's' : ''} · ${ownerCount} owner${ownerCount !== 1 ? 's' : ''}` })] }), _jsxs(CardContent, { children: [!loading && members.length === 0 && (_jsxs("div", { className: "py-10 text-center border border-dashed border-gray-200", children: [_jsx("p", { className: "text-2xl mb-2", children: "\uD83D\uDC65" }), _jsx("p", { className: "text-sm font-medium text-gray-600", children: "No team members yet" }), _jsx("p", { className: "text-xs text-gray-400 mt-1", children: "Use the form above to invite your first teammate." })] })), _jsx("div", { className: "space-y-2", children: members.map((member) => {
                                            const roleMeta = ROLE_META[member.role];
                                            return (_jsxs("div", { className: "border border-gray-200 bg-gray-50 px-4 py-3 flex items-center justify-between gap-3", children: [_jsxs("div", { children: [_jsx("p", { className: "text-sm font-semibold text-gray-900", children: member.email }), _jsxs("div", { className: "flex items-center gap-2 mt-1 flex-wrap", children: [_jsx("span", { className: `text-xs px-2 py-0.5 border rounded-full ${roleMeta.color}`, children: roleMeta.label }), member.can_create_projects && _jsx("span", { className: "text-xs text-gray-400", children: "Projects" }), member.can_manage_deployments && _jsx("span", { className: "text-xs text-gray-400", children: "Deploy" }), member.can_manage_nodes && _jsx("span", { className: "text-xs text-gray-400", children: "Nodes" })] })] }), _jsx("span", { className: `text-xs px-2 py-0.5 border rounded-full shrink-0 ${member.is_active ? 'bg-green-50 text-green-700 border-green-200' : 'bg-gray-50 text-gray-400 border-gray-200'}`, children: member.is_active ? 'Active' : 'Inactive' })] }, member.id));
                                        }) })] })] })] })] }));
};
export default TeamManagement;
