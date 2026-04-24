import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import apiClient from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
const TeamManagement = () => {
    const [orgId, setOrgId] = useState('');
    const [orgName, setOrgName] = useState('');
    const [members, setMembers] = useState([]);
    const [connections, setConnections] = useState([]);
    const [email, setEmail] = useState('');
    const [role, setRole] = useState('developer');
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState('');
    const ownerCount = useMemo(() => members.filter((m) => m.role === 'owner').length, [members]);
    const refreshData = async (currentOrgId) => {
        const [membersResp, connectionsResp] = await Promise.all([
            apiClient.get(`/orgs/${currentOrgId}/team-members`),
            apiClient.get(`/orgs/${currentOrgId}/github-connections`),
        ]);
        setMembers(membersResp.data);
        setConnections(connectionsResp.data);
    };
    useEffect(() => {
        const load = async () => {
            setLoading(true);
            setError('');
            try {
                const ctxResp = await apiClient.get('/context');
                const context = ctxResp.data;
                setOrgId(context.organization.id);
                setOrgName(context.organization.name);
                await refreshData(context.organization.id);
            }
            catch {
                setError('Unable to load team data. Ensure API token/auth is configured.');
            }
            finally {
                setLoading(false);
            }
        };
        void load();
    }, []);
    const inviteMember = async () => {
        if (!orgId || !email.trim()) {
            return;
        }
        setLoading(true);
        setError('');
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
            await refreshData(orgId);
        }
        catch {
            setError('Failed to invite team member.');
        }
        finally {
            setLoading(false);
        }
    };
    const startOAuth = async (provider) => {
        if (!orgId) {
            return;
        }
        setLoading(true);
        setError('');
        try {
            const redirectUri = `${window.location.origin}/oauth/github/callback`;
            const resp = await apiClient.get('/github/oauth/start', {
                params: {
                    org_id: orgId,
                    provider,
                    redirect_uri: redirectUri,
                },
            });
            const authorizeUrl = resp.data.authorize_url;
            window.location.href = authorizeUrl;
        }
        catch {
            setError('OAuth setup failed. Verify GitHub OAuth env vars are configured.');
            setLoading(false);
        }
    };
    return (_jsxs("div", { className: "min-h-screen bg-white", children: [_jsx("header", { className: "border-b border-gray-100", children: _jsxs("div", { className: "max-w-5xl mx-auto px-6 py-8 flex items-center justify-between", children: [_jsxs("div", { children: [_jsx("h1", { className: "text-2xl font-semibold text-gray-900", children: "Team Management" }), _jsxs("p", { className: "text-sm text-gray-500 mt-1", children: ["Organization: ", orgName || 'Loading...'] })] }), _jsx(Link, { to: "/", children: _jsx(Button, { variant: "outline", className: "rounded-none border-gray-300", children: "Back to Dashboard" }) })] }) }), _jsxs("main", { className: "max-w-5xl mx-auto px-6 py-8 space-y-6", children: [error && (_jsx(Card, { className: "rounded-none border-red-200 bg-red-50 shadow-none", children: _jsx(CardContent, { className: "py-4 text-sm text-red-700", children: error }) })), _jsxs("div", { className: "grid md:grid-cols-2 gap-6", children: [_jsxs(Card, { className: "rounded-none border-gray-200 shadow-none", children: [_jsxs(CardHeader, { children: [_jsx(CardTitle, { children: "Invite Member" }), _jsx(CardDescription, { children: "Invite teammates and assign a role." })] }), _jsxs(CardContent, { className: "space-y-4", children: [_jsxs("div", { children: [_jsx(Label, { htmlFor: "invite_email", children: "Email" }), _jsx(Input, { id: "invite_email", value: email, onChange: (e) => setEmail(e.target.value), className: "mt-2 rounded-none border-gray-300", placeholder: "engineer@example.com" })] }), _jsxs("div", { children: [_jsx(Label, { htmlFor: "invite_role", children: "Role" }), _jsxs("select", { id: "invite_role", value: role, onChange: (e) => setRole(e.target.value), className: "mt-2 w-full border border-gray-300 h-10 px-3 text-sm", children: [_jsx("option", { value: "developer", children: "Developer" }), _jsx("option", { value: "viewer", children: "Viewer" }), _jsx("option", { value: "admin", children: "Admin" }), _jsx("option", { value: "owner", children: "Owner" })] })] }), _jsx(Button, { onClick: inviteMember, disabled: loading || !email.trim(), className: "w-full bg-gray-900 text-white hover:bg-gray-800 rounded-none", children: "Invite Member" })] })] }), _jsxs(Card, { className: "rounded-none border-gray-200 shadow-none", children: [_jsxs(CardHeader, { children: [_jsx(CardTitle, { children: "GitHub Connections" }), _jsx(CardDescription, { children: "Connect GitHub accounts for team deployments." })] }), _jsxs(CardContent, { className: "space-y-3", children: [_jsxs("div", { className: "flex gap-2", children: [_jsx(Button, { onClick: () => void startOAuth('github_com'), disabled: loading || !orgId, className: "flex-1 bg-gray-900 text-white hover:bg-gray-800 rounded-none", children: "Connect GitHub.com" }), _jsx(Button, { onClick: () => void startOAuth('github_enterprise'), disabled: loading || !orgId, variant: "outline", className: "flex-1 rounded-none border-gray-300", children: "Connect GHE" })] }), _jsxs("div", { className: "space-y-2", children: [connections.length === 0 && _jsx("p", { className: "text-sm text-gray-500", children: "No connections yet." }), connections.map((conn) => (_jsxs("div", { className: "border border-gray-200 p-3 text-sm", children: [_jsx("p", { className: "font-semibold text-gray-900", children: conn.github_username }), _jsx("p", { className: "text-gray-600", children: conn.provider === 'github_enterprise' ? (conn.enterprise_name || 'GitHub Enterprise') : 'GitHub.com' }), _jsxs("p", { className: "text-xs text-gray-500 mt-1", children: [conn.is_primary ? 'Primary' : 'Secondary', " \u00B7 ", conn.is_active ? 'Active' : 'Inactive'] })] }, conn.id)))] })] })] })] }), _jsxs(Card, { className: "rounded-none border-gray-200 shadow-none", children: [_jsxs(CardHeader, { children: [_jsx(CardTitle, { children: "Team Members" }), _jsxs(CardDescription, { children: [members.length, " member(s) \u00B7 ", ownerCount, " owner(s)"] })] }), _jsx(CardContent, { children: _jsxs("div", { className: "space-y-2", children: [members.map((member) => (_jsxs("div", { className: "border border-gray-200 p-3 flex items-center justify-between gap-3", children: [_jsxs("div", { children: [_jsx("p", { className: "text-sm font-semibold text-gray-900", children: member.email }), _jsxs("p", { className: "text-xs text-gray-500 mt-1", children: [member.role, " \u00B7 projects:", member.can_create_projects ? 'yes' : 'no', " \u00B7 deploy:", member.can_manage_deployments ? 'yes' : 'no', " \u00B7 nodes:", member.can_manage_nodes ? 'yes' : 'no'] })] }), _jsx("span", { className: `text-xs px-2 py-1 border ${member.is_active ? 'border-green-300 text-green-700' : 'border-gray-300 text-gray-500'}`, children: member.is_active ? 'active' : 'inactive' })] }, member.id))), !loading && members.length === 0 && _jsx("p", { className: "text-sm text-gray-500", children: "No members found." })] }) })] })] })] }));
};
export default TeamManagement;
