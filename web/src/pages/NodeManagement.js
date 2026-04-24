import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import apiClient from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
const NodeManagement = () => {
    const [orgId, setOrgId] = useState('');
    const [orgName, setOrgName] = useState('');
    const [nodes, setNodes] = useState([]);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState('');
    const [form, setForm] = useState({
        name: '',
        host: '',
        user: 'root',
        port: 22,
        remote_path: '/opt/apps/watchtower',
        ssh_key_path: '~/.ssh/id_rsa',
        reload_command: 'sudo systemctl reload caddy',
        is_primary: true,
        max_concurrent_deployments: 1,
    });
    const refreshNodes = async (currentOrgId) => {
        const nodesResp = await apiClient.get(`/orgs/${currentOrgId}/nodes`);
        setNodes(nodesResp.data);
    };
    useEffect(() => {
        const load = async () => {
            setLoading(true);
            setError('');
            try {
                const ctxResp = await apiClient.get('/context');
                const ctx = ctxResp.data;
                setOrgId(ctx.organization.id);
                setOrgName(ctx.organization.name);
                await refreshNodes(ctx.organization.id);
            }
            catch {
                setError('Unable to load node management data.');
            }
            finally {
                setLoading(false);
            }
        };
        void load();
    }, []);
    const setField = (key, value) => {
        setForm((prev) => ({ ...prev, [key]: value }));
    };
    const addNode = async () => {
        if (!orgId || !form.name || !form.host) {
            return;
        }
        setLoading(true);
        setError('');
        try {
            await apiClient.post(`/orgs/${orgId}/nodes`, form);
            setForm((prev) => ({ ...prev, name: '', host: '' }));
            await refreshNodes(orgId);
        }
        catch {
            setError('Failed to add node.');
        }
        finally {
            setLoading(false);
        }
    };
    const checkHealth = async (nodeId) => {
        setLoading(true);
        setError('');
        try {
            await apiClient.get(`/org-nodes/${nodeId}/health`);
            await refreshNodes(orgId);
        }
        catch {
            setError('SSH health check failed for one or more nodes.');
        }
        finally {
            setLoading(false);
        }
    };
    return (_jsxs("div", { className: "min-h-screen bg-white", children: [_jsx("header", { className: "border-b border-gray-100", children: _jsxs("div", { className: "max-w-6xl mx-auto px-6 py-8 flex items-center justify-between", children: [_jsxs("div", { children: [_jsx("h1", { className: "text-2xl font-semibold text-gray-900", children: "Node Management" }), _jsxs("p", { className: "text-sm text-gray-500 mt-1", children: ["Organization: ", orgName || 'Loading...'] })] }), _jsx(Link, { to: "/", children: _jsx(Button, { variant: "outline", className: "rounded-none border-gray-300", children: "Back to Dashboard" }) })] }) }), _jsxs("main", { className: "max-w-6xl mx-auto px-6 py-8 space-y-6", children: [error && (_jsx(Card, { className: "rounded-none border-red-200 bg-red-50 shadow-none", children: _jsx(CardContent, { className: "py-4 text-sm text-red-700", children: error }) })), _jsxs(Card, { className: "rounded-none border-gray-200 shadow-none", children: [_jsxs(CardHeader, { children: [_jsx(CardTitle, { children: "Add Deployment Node" }), _jsx(CardDescription, { children: "Register a node and use SSH health checks to monitor it." })] }), _jsxs(CardContent, { children: [_jsxs("div", { className: "grid md:grid-cols-3 gap-4", children: [_jsxs("div", { children: [_jsx(Label, { htmlFor: "name", children: "Node Name" }), _jsx(Input, { id: "name", value: form.name, onChange: (e) => setField('name', e.target.value), className: "mt-2 rounded-none border-gray-300" })] }), _jsxs("div", { children: [_jsx(Label, { htmlFor: "host", children: "Host" }), _jsx(Input, { id: "host", value: form.host, onChange: (e) => setField('host', e.target.value), className: "mt-2 rounded-none border-gray-300" })] }), _jsxs("div", { children: [_jsx(Label, { htmlFor: "user", children: "SSH User" }), _jsx(Input, { id: "user", value: form.user, onChange: (e) => setField('user', e.target.value), className: "mt-2 rounded-none border-gray-300" })] }), _jsxs("div", { children: [_jsx(Label, { htmlFor: "port", children: "SSH Port" }), _jsx(Input, { id: "port", type: "number", value: form.port, onChange: (e) => setField('port', Number(e.target.value || 22)), className: "mt-2 rounded-none border-gray-300" })] }), _jsxs("div", { children: [_jsx(Label, { htmlFor: "remote_path", children: "Remote Path" }), _jsx(Input, { id: "remote_path", value: form.remote_path, onChange: (e) => setField('remote_path', e.target.value), className: "mt-2 rounded-none border-gray-300" })] }), _jsxs("div", { children: [_jsx(Label, { htmlFor: "ssh_key_path", children: "SSH Key Path" }), _jsx(Input, { id: "ssh_key_path", value: form.ssh_key_path, onChange: (e) => setField('ssh_key_path', e.target.value), className: "mt-2 rounded-none border-gray-300" })] }), _jsxs("div", { className: "md:col-span-2", children: [_jsx(Label, { htmlFor: "reload_command", children: "Reload Command" }), _jsx(Input, { id: "reload_command", value: form.reload_command, onChange: (e) => setField('reload_command', e.target.value), className: "mt-2 rounded-none border-gray-300" })] }), _jsxs("div", { children: [_jsx(Label, { htmlFor: "max_concurrent_deployments", children: "Max Concurrent Deployments" }), _jsx(Input, { id: "max_concurrent_deployments", type: "number", min: 1, value: form.max_concurrent_deployments, onChange: (e) => setField('max_concurrent_deployments', Number(e.target.value || 1)), className: "mt-2 rounded-none border-gray-300" })] })] }), _jsxs("label", { className: "mt-4 flex items-center gap-2 text-sm text-gray-700", children: [_jsx("input", { type: "checkbox", checked: form.is_primary, onChange: (e) => setField('is_primary', e.target.checked) }), "Mark as primary deployment node"] }), _jsx(Button, { onClick: addNode, disabled: loading || !orgId, className: "mt-4 bg-gray-900 text-white hover:bg-gray-800 rounded-none", children: "Add Node" })] })] }), _jsxs(Card, { className: "rounded-none border-gray-200 shadow-none", children: [_jsxs(CardHeader, { children: [_jsx(CardTitle, { children: "Registered Nodes" }), _jsxs(CardDescription, { children: [nodes.length, " node(s) available for deployment selection."] })] }), _jsx(CardContent, { children: _jsxs("div", { className: "space-y-3", children: [nodes.map((node) => (_jsx("div", { className: "border border-gray-200 p-4", children: _jsxs("div", { className: "flex items-start justify-between gap-3", children: [_jsxs("div", { children: [_jsxs("p", { className: "font-semibold text-sm text-gray-900", children: [node.name, " (", node.host, ":", node.port, ")"] }), _jsxs("p", { className: "text-xs text-gray-500 mt-1", children: [node.user, " \u00B7 ", node.is_primary ? 'primary' : 'secondary', " \u00B7 status: ", node.status] }), _jsxs("p", { className: "text-xs text-gray-500 mt-1", children: ["CPU: ", node.cpu_usage ?? '--', "% \u00B7 Memory: ", node.memory_usage ?? '--', "% \u00B7 Disk: ", node.disk_usage ?? '--', "%"] })] }), _jsx(Button, { variant: "outline", className: "rounded-none border-gray-300", onClick: () => void checkHealth(node.id), disabled: loading, children: "SSH Health Check" })] }) }, node.id))), !loading && nodes.length === 0 && _jsx("p", { className: "text-sm text-gray-500", children: "No deployment nodes found." })] }) })] })] })] }));
};
export default NodeManagement;
