import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useEffect, useState } from 'react';
import axios from 'axios';
import apiClient from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
const STEP_LABELS = ['Basic Info', 'SSH Access', 'Deployment Config'];
const STATUS_STYLES = {
    healthy: { dot: 'bg-green-500', badge: 'bg-green-50 text-green-700 border-green-200', label: 'Healthy' },
    unhealthy: { dot: 'bg-red-400', badge: 'bg-red-50 text-red-700 border-red-200', label: 'Unhealthy' },
    offline: { dot: 'bg-gray-400', badge: 'bg-gray-50 text-gray-600 border-gray-200', label: 'Offline' },
    maintenance: { dot: 'bg-yellow-400', badge: 'bg-yellow-50 text-yellow-700 border-yellow-200', label: 'Maintenance' },
};
function UsageBar({ value, label, color }) {
    const pct = value ?? 0;
    return (_jsxs("div", { className: "flex-1 min-w-0", children: [_jsxs("div", { className: "flex justify-between text-xs text-gray-500 mb-1", children: [_jsx("span", { children: label }), _jsx("span", { children: value != null ? `${pct}%` : '—' })] }), _jsx("div", { className: "h-1.5 bg-gray-100 rounded-full overflow-hidden", children: _jsx("div", { className: `h-full rounded-full transition-all ${color}`, style: { width: value != null ? `${Math.min(pct, 100)}%` : '0%' } }) })] }));
}
const NodeManagement = () => {
    const [orgId, setOrgId] = useState('');
    const [orgName, setOrgName] = useState('');
    const [nodes, setNodes] = useState([]);
    const [loading, setLoading] = useState(false);
    const [pageError, setPageError] = useState('');
    const [actionError, setActionError] = useState('');
    const [actionSuccess, setActionSuccess] = useState('');
    const [healthLoading, setHealthLoading] = useState(null);
    const [step, setStep] = useState(0);
    const [addingNode, setAddingNode] = useState(false);
    const [offlineMode, setOfflineMode] = useState(false);
    const [form, setForm] = useState({
        name: '',
        host: '',
        user: 'deploy',
        port: 22,
        remote_path: '/opt/apps/watchtower',
        ssh_key_path: '~/.ssh/id_rsa',
        reload_command: 'sudo systemctl reload caddy',
        is_primary: true,
        max_concurrent_deployments: 1,
    });
    const refreshNodes = async (currentOrgId) => {
        try {
            const nodesResp = await apiClient.get(`/orgs/${currentOrgId}/nodes`);
            setNodes(nodesResp.data);
        }
        catch {
            // nodes list failure is non-fatal; keep existing list
        }
    };
    const loadContext = async () => {
        setLoading(true);
        setPageError('');
        setOfflineMode(false);
        try {
            const ctxResp = await apiClient.get('/context');
            const ctx = ctxResp.data;
            setOrgId(ctx.organization.id);
            setOrgName(ctx.organization.name);
            await refreshNodes(ctx.organization.id);
        }
        catch (error) {
            setOfflineMode(true);
            if (axios.isAxiosError(error)) {
                const status = error.response?.status;
                if (status === 401) {
                    setPageError('Authentication failed. Set VITE_API_TOKEN (or localStorage authToken) and ensure it matches WATCHTOWER_API_TOKEN on the server.');
                }
                else if (status === 503) {
                    setPageError('Server authentication is not configured yet. Set WATCHTOWER_API_TOKEN, or enable WATCHTOWER_ALLOW_INSECURE_DEV_AUTH=true for local development.');
                }
                else {
                    setPageError('Could not connect to the WatchTower server. You can still review the form below and add nodes once the server is reachable.');
                }
            }
            else {
                setPageError('Could not connect to the WatchTower server. You can still review the form below and add nodes once the server is reachable.');
            }
        }
        finally {
            setLoading(false);
        }
    };
    useEffect(() => {
        void loadContext();
    }, []);
    const setField = (key, value) => {
        setForm((prev) => ({ ...prev, [key]: value }));
    };
    const isStepValid = (s) => {
        if (s === 0)
            return form.name.trim().length > 0 && form.host.trim().length > 0;
        return true;
    };
    const addNode = async () => {
        if (!orgId || !form.name || !form.host)
            return;
        setAddingNode(true);
        setActionError('');
        setActionSuccess('');
        try {
            await apiClient.post(`/orgs/${orgId}/nodes`, form);
            setForm({
                name: '',
                host: '',
                user: 'deploy',
                port: 22,
                remote_path: '/opt/apps/watchtower',
                ssh_key_path: '~/.ssh/id_rsa',
                reload_command: 'sudo systemctl reload caddy',
                is_primary: true,
                max_concurrent_deployments: 1,
            });
            setStep(0);
            setActionSuccess('Node added successfully!');
            await refreshNodes(orgId);
        }
        catch {
            setActionError('Failed to add node. Check the server connection and try again.');
        }
        finally {
            setAddingNode(false);
        }
    };
    const checkHealth = async (nodeId) => {
        setHealthLoading(nodeId);
        setActionError('');
        setActionSuccess('');
        try {
            await apiClient.get(`/org-nodes/${nodeId}/health`);
            await refreshNodes(orgId);
            setActionSuccess('Health check completed.');
        }
        catch {
            setActionError('SSH health check failed. Ensure the node is reachable and SSH credentials are correct.');
        }
        finally {
            setHealthLoading(null);
        }
    };
    return (_jsxs("div", { className: "flex-1 overflow-auto bg-gray-50", children: [_jsx("header", { className: "bg-white border-b border-gray-100", children: _jsxs("div", { className: "px-8 py-5 flex items-center justify-between", children: [_jsxs("div", { children: [_jsx("h1", { className: "text-base font-semibold text-gray-900", children: "Nodes" }), _jsx("p", { className: "text-xs text-gray-400 mt-0.5", children: loading ? 'Loading…' : orgName ? `Organization: ${orgName}` : offlineMode ? 'Server offline — some features unavailable' : 'Manage deployment nodes' })] }), offlineMode && (_jsx(Button, { variant: "outline", onClick: () => void loadContext(), className: "rounded-none border-gray-300 text-sm", children: "\u21BA Retry Connection" }))] }) }), _jsxs("main", { className: "px-8 py-6 space-y-6 max-w-4xl", children: [pageError && (_jsxs("div", { className: "flex items-start gap-3 rounded-none border border-amber-200 bg-amber-50 px-4 py-3", children: [_jsx("span", { className: "text-amber-500 mt-0.5", children: "\u26A0" }), _jsxs("div", { children: [_jsx("p", { className: "text-sm font-medium text-amber-800", children: "Connection issue" }), _jsx("p", { className: "text-sm text-amber-700 mt-0.5", children: pageError })] })] })), actionSuccess && (_jsxs("div", { className: "flex items-center gap-2 rounded-none border border-green-200 bg-green-50 px-4 py-3", children: [_jsx("span", { className: "text-green-500", children: "\u2713" }), _jsx("p", { className: "text-sm text-green-700", children: actionSuccess })] })), actionError && (_jsxs("div", { className: "flex items-start gap-2 rounded-none border border-red-200 bg-red-50 px-4 py-3", children: [_jsx("span", { className: "text-red-500 mt-0.5", children: "\u2717" }), _jsx("p", { className: "text-sm text-red-700", children: actionError })] })), _jsxs(Card, { className: "rounded-none border-gray-200 shadow-none bg-white", children: [_jsxs(CardHeader, { className: "pb-4", children: [_jsx(CardTitle, { className: "text-base", children: "Add a Deployment Node" }), _jsx(CardDescription, { children: "Complete 3 quick steps to register a node for deployment." })] }), _jsxs(CardContent, { children: [_jsx("div", { className: "flex items-center gap-0 mb-6", children: STEP_LABELS.map((label, i) => (_jsxs("div", { className: "flex items-center flex-1 last:flex-none", children: [_jsxs("button", { type: "button", onClick: () => i < step && setStep(i), className: `flex items-center gap-2 text-sm font-medium transition-colors ${i === step ? 'text-gray-900' : i < step ? 'text-gray-500 cursor-pointer hover:text-gray-700' : 'text-gray-300 cursor-default'}`, children: [_jsx("span", { className: `w-6 h-6 rounded-full flex items-center justify-center text-xs border ${i < step ? 'bg-gray-900 border-gray-900 text-white' :
                                                                i === step ? 'border-gray-900 text-gray-900' :
                                                                    'border-gray-200 text-gray-300'}`, children: i < step ? '✓' : i + 1 }), label] }), i < STEP_LABELS.length - 1 && (_jsx("div", { className: `flex-1 h-px mx-3 ${i < step ? 'bg-gray-900' : 'bg-gray-200'}` }))] }, i))) }), step === 0 && (_jsxs("div", { className: "space-y-4", children: [_jsx("p", { className: "text-xs text-gray-500 mb-2", children: "Give this node a recognizable name and enter its hostname or IP address." }), _jsxs("div", { className: "grid sm:grid-cols-2 gap-4", children: [_jsxs("div", { children: [_jsxs(Label, { htmlFor: "name", children: ["Node Name ", _jsx("span", { className: "text-red-400", children: "*" })] }), _jsx(Input, { id: "name", placeholder: "e.g. web-node-1", value: form.name, onChange: (e) => setField('name', e.target.value), className: "mt-1.5 rounded-none border-gray-300" })] }), _jsxs("div", { children: [_jsxs(Label, { htmlFor: "host", children: ["Host / IP Address ", _jsx("span", { className: "text-red-400", children: "*" })] }), _jsx(Input, { id: "host", placeholder: "e.g. 192.168.1.101 or server.example.com", value: form.host, onChange: (e) => setField('host', e.target.value), className: "mt-1.5 rounded-none border-gray-300" })] })] }), _jsxs("label", { className: "flex items-center gap-2 text-sm text-gray-700 cursor-pointer mt-2", children: [_jsx("input", { type: "checkbox", checked: form.is_primary, onChange: (e) => setField('is_primary', e.target.checked), className: "cursor-pointer" }), "Mark as ", _jsx("strong", { children: "primary" }), " deployment node"] })] })), step === 1 && (_jsxs("div", { className: "space-y-4", children: [_jsx("p", { className: "text-xs text-gray-500 mb-2", children: "How should WatchTower connect to this node via SSH?" }), _jsxs("div", { className: "grid sm:grid-cols-3 gap-4", children: [_jsxs("div", { children: [_jsx(Label, { htmlFor: "user", children: "SSH User" }), _jsx(Input, { id: "user", value: form.user, onChange: (e) => setField('user', e.target.value), className: "mt-1.5 rounded-none border-gray-300" })] }), _jsxs("div", { children: [_jsx(Label, { htmlFor: "port", children: "SSH Port" }), _jsx(Input, { id: "port", type: "number", value: form.port, onChange: (e) => setField('port', Number(e.target.value || 22)), className: "mt-1.5 rounded-none border-gray-300" })] }), _jsxs("div", { children: [_jsx(Label, { htmlFor: "ssh_key_path", children: "SSH Key Path" }), _jsx(Input, { id: "ssh_key_path", placeholder: "~/.ssh/id_rsa", value: form.ssh_key_path, onChange: (e) => setField('ssh_key_path', e.target.value), className: "mt-1.5 rounded-none border-gray-300" })] })] }), _jsx("p", { className: "text-xs text-gray-400", children: "The SSH key must be accessible on the WatchTower server, not your local machine." })] })), step === 2 && (_jsxs("div", { className: "space-y-4", children: [_jsx("p", { className: "text-xs text-gray-500 mb-2", children: "Configure deployment paths and the command that reloads your service." }), _jsxs("div", { className: "grid sm:grid-cols-2 gap-4", children: [_jsxs("div", { children: [_jsx(Label, { htmlFor: "remote_path", children: "Remote Deploy Path" }), _jsx(Input, { id: "remote_path", value: form.remote_path, onChange: (e) => setField('remote_path', e.target.value), className: "mt-1.5 rounded-none border-gray-300" })] }), _jsxs("div", { children: [_jsx(Label, { htmlFor: "max_concurrent_deployments", children: "Max Concurrent Deployments" }), _jsx(Input, { id: "max_concurrent_deployments", type: "number", min: 1, value: form.max_concurrent_deployments, onChange: (e) => setField('max_concurrent_deployments', Number(e.target.value || 1)), className: "mt-1.5 rounded-none border-gray-300" })] }), _jsxs("div", { className: "sm:col-span-2", children: [_jsx(Label, { htmlFor: "reload_command", children: "Service Reload Command" }), _jsx(Input, { id: "reload_command", placeholder: "e.g. sudo systemctl reload nginx", value: form.reload_command, onChange: (e) => setField('reload_command', e.target.value), className: "mt-1.5 rounded-none border-gray-300" }), _jsx("p", { className: "text-xs text-gray-400 mt-1", children: "Run after each deployment to apply the new build." })] })] })] })), _jsxs("div", { className: "flex items-center justify-between mt-6 pt-4 border-t border-gray-100", children: [_jsx(Button, { variant: "outline", disabled: step === 0, onClick: () => setStep((s) => s - 1), className: "rounded-none border-gray-300 text-sm", children: "\u2190 Back" }), step < STEP_LABELS.length - 1 ? (_jsx(Button, { onClick: () => isStepValid(step) && setStep((s) => s + 1), disabled: !isStepValid(step), className: "bg-gray-900 text-white hover:bg-gray-800 rounded-none text-sm", children: "Continue \u2192" })) : (_jsx(Button, { onClick: () => void addNode(), disabled: addingNode || offlineMode || !orgId, className: "bg-gray-900 text-white hover:bg-gray-800 rounded-none text-sm", children: addingNode ? 'Adding…' : offlineMode ? 'Server offline' : 'Add Node' }))] })] })] }), _jsxs(Card, { className: "rounded-none border-gray-200 shadow-none bg-white", children: [_jsxs(CardHeader, { className: "pb-3", children: [_jsx(CardTitle, { className: "text-base", children: "Registered Nodes" }), _jsx(CardDescription, { children: loading ? 'Loading nodes…' : `${nodes.length} node${nodes.length !== 1 ? 's' : ''} available for deployments` })] }), _jsxs(CardContent, { children: [loading && (_jsxs("div", { className: "flex items-center gap-2 py-6 text-sm text-gray-400", children: [_jsx("span", { className: "animate-spin", children: "\u231B" }), " Loading nodes\u2026"] })), !loading && nodes.length === 0 && (_jsxs("div", { className: "py-10 text-center border border-dashed border-gray-200 text-gray-400", children: [_jsx("p", { className: "text-3xl mb-2", children: "\uD83D\uDDA5" }), _jsx("p", { className: "text-sm font-medium text-gray-600", children: "No nodes registered yet" }), _jsx("p", { className: "text-xs text-gray-400 mt-1", children: "Use the form above to add your first deployment node." })] })), _jsx("div", { className: "space-y-3", children: nodes.map((node) => {
                                            const s = STATUS_STYLES[node.status] ?? STATUS_STYLES.offline;
                                            return (_jsx("div", { className: "border border-gray-200 bg-gray-50 p-4", children: _jsxs("div", { className: "flex items-start justify-between gap-4", children: [_jsxs("div", { className: "flex-1 min-w-0", children: [_jsxs("div", { className: "flex items-center gap-2 flex-wrap", children: [_jsx("span", { className: "font-semibold text-sm text-gray-900", children: node.name }), _jsxs("span", { className: `inline-flex items-center gap-1.5 text-xs px-2 py-0.5 border rounded-full ${s.badge}`, children: [_jsx("span", { className: `w-1.5 h-1.5 rounded-full ${s.dot}` }), s.label] }), node.is_primary && (_jsx("span", { className: "text-xs px-2 py-0.5 border border-blue-200 bg-blue-50 text-blue-700 rounded-full", children: "Primary" }))] }), _jsxs("p", { className: "text-xs text-gray-500 mt-1 font-mono", children: [node.user, "@", node.host, ":", node.port, " \u00B7 ", node.remote_path] }), _jsxs("div", { className: "flex gap-4 mt-3", children: [_jsx(UsageBar, { value: node.cpu_usage, label: "CPU", color: "bg-blue-400" }), _jsx(UsageBar, { value: node.memory_usage, label: "Memory", color: "bg-purple-400" }), _jsx(UsageBar, { value: node.disk_usage, label: "Disk", color: "bg-orange-400" })] }), node.last_health_check && (_jsxs("p", { className: "text-xs text-gray-400 mt-2", children: ["Last checked: ", node.last_health_check] }))] }), _jsx(Button, { variant: "outline", className: "rounded-none border-gray-300 text-xs shrink-0", onClick: () => void checkHealth(node.id), disabled: healthLoading === node.id, children: healthLoading === node.id ? 'Checking…' : 'Health Check' })] }) }, node.id));
                                        }) })] })] }), _jsx(Card, { className: "rounded-none border-gray-100 shadow-none bg-white", children: _jsxs(CardContent, { className: "py-4", children: [_jsx("p", { className: "text-xs text-gray-500 font-medium mb-2", children: "Quick tips" }), _jsxs("ul", { className: "text-xs text-gray-400 space-y-1 list-disc list-inside", children: [_jsx("li", { children: "The WatchTower server must have SSH access to each node using the key path you provide." }), _jsxs("li", { children: ["Use ", _jsx("code", { className: "bg-gray-100 px-1", children: "sudo systemctl reload <service>" }), " as the reload command for zero-downtime reloads."] }), _jsxs("li", { children: ["Run a ", _jsx("strong", { children: "Health Check" }), " after adding a node to verify SSH connectivity."] }), _jsx("li", { children: "Only one node can be primary \u2014 it is used as the default deployment target." })] })] }) })] })] }));
};
export default NodeManagement;
