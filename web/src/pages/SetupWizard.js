import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import apiClient from '@/lib/api';
import { Card, CardContent, CardDescription, CardHeader, CardTitle, } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
const STORAGE_KEY = 'wt_projects';
const SetupWizard = () => {
    const [step, setStep] = useState(1);
    const [submitting, setSubmitting] = useState(false);
    const navigate = useNavigate();
    const [data, setData] = useState({
        deployment_model: 'self_hosted',
        use_case: 'netlify_like',
        repo_url: '',
        repo_branch: 'main',
        build_command: 'npm ci && npm run build',
        project_name: '',
        output_dir: 'dist',
        functions_dir: 'api',
        enable_functions: false,
        framework: 'next.js',
        enable_preview_deployments: true,
        dockerfile_path: './Dockerfile',
        exposed_port: 3000,
        target_nodes: 'default',
        custom_domain: '',
    });
    const canContinue = useMemo(() => {
        if (step === 1) {
            return Boolean(data.deployment_model);
        }
        if (step === 2) {
            return Boolean(data.use_case);
        }
        if (step === 3) {
            return data.repo_url.trim().length > 0 && data.build_command.trim().length > 0;
        }
        return data.project_name.trim().length > 0;
    }, [data, step]);
    const setField = (key, value) => {
        setData((prev) => ({ ...prev, [key]: value }));
    };
    const saveLocalProject = () => {
        const existingRaw = localStorage.getItem(STORAGE_KEY);
        const existing = existingRaw ? JSON.parse(existingRaw) : [];
        const item = {
            id: crypto.randomUUID(),
            name: data.project_name,
            use_case: data.use_case,
            deployment_model: data.deployment_model,
            repo_url: data.repo_url,
            repo_branch: data.repo_branch,
            created_at: new Date().toISOString(),
        };
        const next = [item, ...existing];
        localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    };
    const createProject = async () => {
        setSubmitting(true);
        const payload = {
            deployment_model: data.deployment_model,
            use_case: data.use_case,
            repo_url: data.repo_url,
            repo_branch: data.repo_branch,
            build_command: data.build_command,
            project_name: data.project_name,
            output_dir: data.output_dir,
            functions_dir: data.functions_dir,
            enable_functions: data.enable_functions,
            framework: data.framework,
            enable_preview_deployments: data.enable_preview_deployments,
            dockerfile_path: data.dockerfile_path,
            exposed_port: data.exposed_port,
            target_nodes: data.target_nodes,
            custom_domain: data.custom_domain || undefined,
        };
        saveLocalProject();
        try {
            await apiClient.post('/setup/wizard/complete', payload);
        }
        catch {
            // Local-first flow: dashboard still works if backend auth is not fully configured.
        }
        setSubmitting(false);
        navigate('/');
    };
    return (_jsx("div", { className: "min-h-screen bg-white", children: _jsxs("div", { className: "max-w-3xl mx-auto px-6 py-10", children: [_jsxs("div", { className: "text-center mb-10", children: [_jsx("h1", { className: "text-3xl font-semibold text-gray-900 tracking-wide", children: "WatchTower Setup" }), _jsx("p", { className: "text-sm text-gray-500 mt-2", children: "Step-by-step project installation and configuration." })] }), _jsx("div", { className: "flex justify-between mb-8", children: [1, 2, 3, 4].map((idx) => (_jsxs("div", { className: "flex items-center", children: [_jsx("div", { className: `w-10 h-10 rounded-full flex items-center justify-center font-bold ${idx <= step ? 'bg-gray-900 text-white' : 'bg-gray-100 text-gray-500'}`, children: idx }), idx < 4 && _jsx("div", { className: "w-12 h-px mx-2 bg-gray-200" })] }, idx))) }), _jsx("div", { className: "flex justify-between mb-8", children: [1, 2, 3, 4].map((idx) => (_jsx("div", { className: `h-2 flex-1 mr-2 last:mr-0 ${idx <= step ? 'bg-gray-900' : 'bg-gray-200'}` }, idx))) }), step === 1 && (_jsxs(Card, { className: "rounded-none border-gray-200 shadow-none", children: [_jsxs(CardHeader, { children: [_jsx(CardTitle, { children: "Choose Deployment Model" }), _jsx(CardDescription, { children: "How do you want to deploy?" })] }), _jsxs(CardContent, { children: [_jsxs("div", { className: "space-y-4", children: [_jsxs("label", { className: "flex gap-3 items-center border border-gray-200 p-4 cursor-pointer", children: [_jsx("input", { type: "radio", name: "deployment_model", checked: data.deployment_model === 'self_hosted', onChange: () => setField('deployment_model', 'self_hosted') }), _jsxs("div", { children: [_jsx("p", { className: "font-semibold text-sm", children: "Self-Hosted" }), _jsx("p", { className: "text-xs text-gray-500", children: "Run WatchTower on your infrastructure." })] })] }), _jsxs("label", { className: "flex gap-3 items-center border border-gray-200 p-4 cursor-pointer", children: [_jsx("input", { type: "radio", name: "deployment_model", checked: data.deployment_model === 'saas', onChange: () => setField('deployment_model', 'saas') }), _jsxs("div", { children: [_jsx("p", { className: "font-semibold text-sm", children: "SaaS" }), _jsx("p", { className: "text-xs text-gray-500", children: "Use cloud-managed infrastructure." })] })] })] }), _jsx(Button, { type: "button", className: "w-full mt-6 bg-gray-900 text-white hover:bg-gray-800 rounded-none", disabled: !canContinue, onClick: () => setStep(2), children: "Continue" })] })] })), step === 2 && (_jsxs(Card, { className: "rounded-none border-gray-200 shadow-none", children: [_jsxs(CardHeader, { children: [_jsx(CardTitle, { children: "Choose Use Case" }), _jsx(CardDescription, { children: "What kind of app are you deploying?" })] }), _jsxs(CardContent, { children: [_jsxs("div", { className: "space-y-4", children: [_jsxs("label", { className: "flex gap-3 items-center border border-gray-200 p-4 cursor-pointer", children: [_jsx("input", { type: "radio", name: "use_case", checked: data.use_case === 'netlify_like', onChange: () => setField('use_case', 'netlify_like') }), _jsxs("div", { children: [_jsx("p", { className: "font-semibold text-sm", children: "Static + Functions" }), _jsx("p", { className: "text-xs text-gray-500", children: "Netlify-like workflows." })] })] }), _jsxs("label", { className: "flex gap-3 items-center border border-gray-200 p-4 cursor-pointer", children: [_jsx("input", { type: "radio", name: "use_case", checked: data.use_case === 'vercel_like', onChange: () => setField('use_case', 'vercel_like') }), _jsxs("div", { children: [_jsx("p", { className: "font-semibold text-sm", children: "SSR Application" }), _jsx("p", { className: "text-xs text-gray-500", children: "Vercel-like previews and runtime behavior." })] })] }), _jsxs("label", { className: "flex gap-3 items-center border border-gray-200 p-4 cursor-pointer", children: [_jsx("input", { type: "radio", name: "use_case", checked: data.use_case === 'docker_platform', onChange: () => setField('use_case', 'docker_platform') }), _jsxs("div", { children: [_jsx("p", { className: "font-semibold text-sm", children: "Docker Platform" }), _jsx("p", { className: "text-xs text-gray-500", children: "Containerized app deployment." })] })] })] }), _jsxs("div", { className: "flex gap-3 mt-6", children: [_jsx(Button, { type: "button", variant: "outline", className: "flex-1 rounded-none border-gray-300", onClick: () => setStep(1), children: "Back" }), _jsx(Button, { type: "button", className: "flex-1 bg-gray-900 text-white hover:bg-gray-800 rounded-none", disabled: !canContinue, onClick: () => setStep(3), children: "Continue" })] })] })] })), step === 3 && (_jsxs(Card, { className: "rounded-none border-gray-200 shadow-none", children: [_jsxs(CardHeader, { children: [_jsx(CardTitle, { children: "Connect Repository" }), _jsx(CardDescription, { children: "Repository and build settings." })] }), _jsxs(CardContent, { children: [_jsxs("div", { className: "space-y-5", children: [_jsxs("div", { children: [_jsx(Label, { htmlFor: "repo_url", children: "Repository URL" }), _jsx(Input, { id: "repo_url", value: data.repo_url, onChange: (e) => setField('repo_url', e.target.value), className: "mt-2 rounded-none border-gray-300", placeholder: "https://github.com/owner/repo" })] }), _jsxs("div", { children: [_jsx(Label, { htmlFor: "repo_branch", children: "Branch" }), _jsx(Input, { id: "repo_branch", value: data.repo_branch, onChange: (e) => setField('repo_branch', e.target.value), className: "mt-2 rounded-none border-gray-300" })] }), _jsxs("div", { children: [_jsx(Label, { htmlFor: "build_command", children: "Build Command" }), _jsx(Input, { id: "build_command", value: data.build_command, onChange: (e) => setField('build_command', e.target.value), className: "mt-2 rounded-none border-gray-300" })] })] }), _jsxs("div", { className: "flex gap-3 mt-6", children: [_jsx(Button, { type: "button", variant: "outline", className: "flex-1 rounded-none border-gray-300", onClick: () => setStep(2), children: "Back" }), _jsx(Button, { type: "button", className: "flex-1 bg-gray-900 text-white hover:bg-gray-800 rounded-none", disabled: !canContinue, onClick: () => setStep(4), children: "Continue" })] })] })] })), step === 4 && (_jsxs(Card, { className: "rounded-none border-gray-200 shadow-none", children: [_jsxs(CardHeader, { children: [_jsx(CardTitle, { children: "Finalize Configuration" }), _jsx(CardDescription, { children: "Last step before creating your project." })] }), _jsxs(CardContent, { children: [_jsxs("div", { className: "space-y-5", children: [_jsxs("div", { children: [_jsx(Label, { htmlFor: "project_name", children: "Project Name" }), _jsx(Input, { id: "project_name", value: data.project_name, onChange: (e) => setField('project_name', e.target.value), className: "mt-2 rounded-none border-gray-300", placeholder: "my-web-app" })] }), data.use_case === 'netlify_like' && (_jsxs(_Fragment, { children: [_jsxs("div", { children: [_jsx(Label, { htmlFor: "output_dir", children: "Output Directory" }), _jsx(Input, { id: "output_dir", value: data.output_dir, onChange: (e) => setField('output_dir', e.target.value), className: "mt-2 rounded-none border-gray-300" })] }), _jsxs("div", { children: [_jsx(Label, { htmlFor: "functions_dir", children: "Functions Directory" }), _jsx(Input, { id: "functions_dir", value: data.functions_dir, onChange: (e) => setField('functions_dir', e.target.value), className: "mt-2 rounded-none border-gray-300" })] }), _jsxs("label", { className: "flex items-center gap-2 text-sm text-gray-700", children: [_jsx("input", { type: "checkbox", checked: data.enable_functions, onChange: (e) => setField('enable_functions', e.target.checked) }), "Enable functions"] })] })), data.use_case === 'vercel_like' && (_jsxs(_Fragment, { children: [_jsxs("div", { children: [_jsx(Label, { htmlFor: "framework", children: "Framework" }), _jsx(Input, { id: "framework", value: data.framework, onChange: (e) => setField('framework', e.target.value), className: "mt-2 rounded-none border-gray-300" })] }), _jsxs("label", { className: "flex items-center gap-2 text-sm text-gray-700", children: [_jsx("input", { type: "checkbox", checked: data.enable_preview_deployments, onChange: (e) => setField('enable_preview_deployments', e.target.checked) }), "Enable preview deployments"] })] })), data.use_case === 'docker_platform' && (_jsxs(_Fragment, { children: [_jsxs("div", { children: [_jsx(Label, { htmlFor: "dockerfile_path", children: "Dockerfile Path" }), _jsx(Input, { id: "dockerfile_path", value: data.dockerfile_path, onChange: (e) => setField('dockerfile_path', e.target.value), className: "mt-2 rounded-none border-gray-300" })] }), _jsxs("div", { children: [_jsx(Label, { htmlFor: "exposed_port", children: "Exposed Port" }), _jsx(Input, { id: "exposed_port", type: "number", value: data.exposed_port, onChange: (e) => setField('exposed_port', Number(e.target.value || 3000)), className: "mt-2 rounded-none border-gray-300" })] }), _jsxs("div", { children: [_jsx(Label, { htmlFor: "target_nodes", children: "Target Nodes" }), _jsx(Input, { id: "target_nodes", value: data.target_nodes, onChange: (e) => setField('target_nodes', e.target.value), className: "mt-2 rounded-none border-gray-300", placeholder: "primary-node,edge-node-2" })] })] })), _jsxs("div", { children: [_jsx(Label, { htmlFor: "custom_domain", children: "Custom Domain (optional)" }), _jsx(Input, { id: "custom_domain", value: data.custom_domain, onChange: (e) => setField('custom_domain', e.target.value), className: "mt-2 rounded-none border-gray-300", placeholder: "app.example.com" })] })] }), _jsxs("div", { className: "flex gap-3 mt-6", children: [_jsx(Button, { type: "button", variant: "outline", className: "flex-1 rounded-none border-gray-300", onClick: () => setStep(3), children: "Back" }), _jsx(Button, { type: "button", className: "flex-1 bg-gray-900 text-white hover:bg-gray-800 rounded-none", disabled: !canContinue || submitting, onClick: createProject, children: submitting ? 'Creating...' : 'Create Project' })] })] })] }))] }) }));
};
export default SetupWizard;
