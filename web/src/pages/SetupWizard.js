import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import apiClient from '@/lib/api';
import { Card, CardContent, } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
const STORAGE_KEY = 'wt_projects';
const STEP_LABELS = ['Deployment', 'App Type', 'Repository', 'Finalize'];
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
        if (step === 1)
            return Boolean(data.deployment_model);
        if (step === 2)
            return Boolean(data.use_case);
        if (step === 3)
            return data.repo_url.trim().length > 0 && data.build_command.trim().length > 0;
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
        localStorage.setItem(STORAGE_KEY, JSON.stringify([item, ...existing]));
    };
    const createProject = async () => {
        setSubmitting(true);
        saveLocalProject();
        try {
            await apiClient.post('/setup/wizard/complete', {
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
            });
        }
        catch {
            // Local-first: dashboard works even if backend isn't fully configured yet.
        }
        setSubmitting(false);
        navigate('/');
    };
    return (_jsxs("div", { className: "min-h-screen bg-gray-50", children: [_jsx("header", { className: "bg-white border-b border-gray-100", children: _jsxs("div", { className: "max-w-2xl mx-auto px-6 py-5 flex items-center justify-between", children: [_jsxs("div", { children: [_jsx("h1", { className: "text-base font-semibold text-gray-900", children: "New Project" }), _jsx("p", { className: "text-xs text-gray-400 mt-0.5", children: "WatchTower Setup Wizard" })] }), _jsx(Link, { to: "/", children: _jsx(Button, { variant: "outline", className: "rounded-none border-gray-200 text-sm", children: "\u2190 Cancel" }) })] }) }), _jsxs("div", { className: "max-w-2xl mx-auto px-6 py-8", children: [_jsx("div", { className: "mb-8", children: _jsx("div", { className: "flex items-center gap-0", children: STEP_LABELS.map((label, i) => {
                                const idx = i + 1;
                                const done = idx < step;
                                const active = idx === step;
                                return (_jsxs("div", { className: "flex items-center flex-1 last:flex-none", children: [_jsxs("div", { className: "flex items-center gap-1.5", children: [_jsx("span", { className: `w-6 h-6 rounded-full flex items-center justify-center text-xs font-medium border transition-colors ${done ? 'bg-gray-900 border-gray-900 text-white' :
                                                        active ? 'border-gray-900 text-gray-900' :
                                                            'border-gray-300 text-gray-400'}`, children: done ? '✓' : idx }), _jsx("span", { className: `text-xs font-medium hidden sm:block ${active ? 'text-gray-900' : done ? 'text-gray-500' : 'text-gray-300'}`, children: label })] }), i < STEP_LABELS.length - 1 && (_jsx("div", { className: `flex-1 h-px mx-2 transition-colors ${done ? 'bg-gray-900' : 'bg-gray-200'}` }))] }, idx));
                            }) }) }), step === 1 && (_jsxs("div", { children: [_jsx("h2", { className: "text-lg font-semibold text-gray-900 mb-1", children: "Where will you deploy?" }), _jsx("p", { className: "text-sm text-gray-500 mb-6", children: "Choose how WatchTower manages your infrastructure." }), _jsx("div", { className: "space-y-3", children: [
                                    { value: 'self_hosted', title: 'Self-Hosted', desc: 'Run WatchTower on your own servers. Full control, no external dependencies.', icon: '🏠' },
                                    { value: 'saas', title: 'SaaS (Cloud-managed)', desc: 'Use cloud-managed infrastructure. Easier setup, handled for you.', icon: '☁️' },
                                ].map((opt) => (_jsxs("label", { className: `flex gap-4 items-start border p-4 cursor-pointer transition-colors ${data.deployment_model === opt.value ? 'border-gray-900 bg-gray-50' : 'border-gray-200 hover:border-gray-400'}`, children: [_jsx("input", { type: "radio", name: "deployment_model", className: "mt-1", checked: data.deployment_model === opt.value, onChange: () => setField('deployment_model', opt.value) }), _jsxs("div", { children: [_jsxs("p", { className: "font-medium text-sm text-gray-900", children: [opt.icon, " ", opt.title] }), _jsx("p", { className: "text-xs text-gray-500 mt-0.5", children: opt.desc })] })] }, opt.value))) }), _jsx("div", { className: "mt-6 flex justify-end", children: _jsx(Button, { onClick: () => setStep(2), disabled: !canContinue, className: "bg-gray-900 text-white hover:bg-gray-800 rounded-none", children: "Continue \u2192" }) })] })), step === 2 && (_jsxs("div", { children: [_jsx("h2", { className: "text-lg font-semibold text-gray-900 mb-1", children: "What kind of app are you deploying?" }), _jsx("p", { className: "text-sm text-gray-500 mb-6", children: "Pick the type that best matches your project." }), _jsx("div", { className: "space-y-3", children: [
                                    { value: 'netlify_like', title: 'Static Site + Functions', desc: 'HTML/CSS/JS frontend with optional serverless API functions. Like Netlify.', icon: '⚡' },
                                    { value: 'vercel_like', title: 'SSR / Full-Stack App', desc: 'Server-side rendered app with preview deployments per branch. Like Vercel.', icon: '▲' },
                                    { value: 'docker_platform', title: 'Docker Container', desc: 'Containerized app with a Dockerfile. Any language or framework.', icon: '🐳' },
                                ].map((opt) => (_jsxs("label", { className: `flex gap-4 items-start border p-4 cursor-pointer transition-colors ${data.use_case === opt.value ? 'border-gray-900 bg-gray-50' : 'border-gray-200 hover:border-gray-400'}`, children: [_jsx("input", { type: "radio", name: "use_case", className: "mt-1", checked: data.use_case === opt.value, onChange: () => setField('use_case', opt.value) }), _jsxs("div", { children: [_jsxs("p", { className: "font-medium text-sm text-gray-900", children: [opt.icon, " ", opt.title] }), _jsx("p", { className: "text-xs text-gray-500 mt-0.5", children: opt.desc })] })] }, opt.value))) }), _jsxs("div", { className: "mt-6 flex justify-between", children: [_jsx(Button, { variant: "outline", onClick: () => setStep(1), className: "rounded-none border-gray-300", children: "\u2190 Back" }), _jsx(Button, { onClick: () => setStep(3), disabled: !canContinue, className: "bg-gray-900 text-white hover:bg-gray-800 rounded-none", children: "Continue \u2192" })] })] })), step === 3 && (_jsxs("div", { children: [_jsx("h2", { className: "text-lg font-semibold text-gray-900 mb-1", children: "Connect your repository" }), _jsx("p", { className: "text-sm text-gray-500 mb-6", children: "Where is your source code? WatchTower will pull from this repo." }), _jsxs("div", { className: "space-y-4", children: [_jsxs("div", { children: [_jsxs(Label, { htmlFor: "repo_url", children: ["Repository URL ", _jsx("span", { className: "text-red-400", children: "*" })] }), _jsx(Input, { id: "repo_url", value: data.repo_url, onChange: (e) => setField('repo_url', e.target.value), className: "mt-1.5 rounded-none border-gray-300", placeholder: "https://github.com/your-org/your-repo" }), _jsx("p", { className: "text-xs text-gray-400 mt-1", children: "Supports GitHub, GitLab, and Bitbucket URLs." })] }), _jsxs("div", { className: "grid grid-cols-2 gap-4", children: [_jsxs("div", { children: [_jsx(Label, { htmlFor: "repo_branch", children: "Branch" }), _jsx(Input, { id: "repo_branch", value: data.repo_branch, onChange: (e) => setField('repo_branch', e.target.value), className: "mt-1.5 rounded-none border-gray-300", placeholder: "main" })] }), _jsxs("div", { children: [_jsxs(Label, { htmlFor: "build_command", children: ["Build Command ", _jsx("span", { className: "text-red-400", children: "*" })] }), _jsx(Input, { id: "build_command", value: data.build_command, onChange: (e) => setField('build_command', e.target.value), className: "mt-1.5 rounded-none border-gray-300", placeholder: "npm ci && npm run build" })] })] })] }), _jsxs("div", { className: "mt-6 flex justify-between", children: [_jsx(Button, { variant: "outline", onClick: () => setStep(2), className: "rounded-none border-gray-300", children: "\u2190 Back" }), _jsx(Button, { onClick: () => setStep(4), disabled: !canContinue, className: "bg-gray-900 text-white hover:bg-gray-800 rounded-none", children: "Continue \u2192" })] })] })), step === 4 && (_jsxs("div", { children: [_jsx("h2", { className: "text-lg font-semibold text-gray-900 mb-1", children: "Final configuration" }), _jsx("p", { className: "text-sm text-gray-500 mb-6", children: "One last step \u2014 name your project and tweak the settings for your app type." }), _jsxs("div", { className: "space-y-4", children: [_jsxs("div", { children: [_jsxs(Label, { htmlFor: "project_name", children: ["Project Name ", _jsx("span", { className: "text-red-400", children: "*" })] }), _jsx(Input, { id: "project_name", value: data.project_name, onChange: (e) => setField('project_name', e.target.value), className: "mt-1.5 rounded-none border-gray-300", placeholder: "my-web-app" }), _jsx("p", { className: "text-xs text-gray-400 mt-1", children: "Used to identify this project in the dashboard." })] }), data.use_case === 'netlify_like' && (_jsx(Card, { className: "rounded-none border-gray-100 shadow-none bg-gray-50", children: _jsxs(CardContent, { className: "py-4 space-y-3", children: [_jsx("p", { className: "text-xs font-medium text-gray-600 uppercase tracking-wide", children: "Static + Functions settings" }), _jsxs("div", { className: "grid grid-cols-2 gap-3", children: [_jsxs("div", { children: [_jsx(Label, { htmlFor: "output_dir", children: "Output Directory" }), _jsx(Input, { id: "output_dir", value: data.output_dir, onChange: (e) => setField('output_dir', e.target.value), className: "mt-1.5 rounded-none border-gray-300", placeholder: "dist" })] }), _jsxs("div", { children: [_jsx(Label, { htmlFor: "functions_dir", children: "Functions Directory" }), _jsx(Input, { id: "functions_dir", value: data.functions_dir, onChange: (e) => setField('functions_dir', e.target.value), className: "mt-1.5 rounded-none border-gray-300", placeholder: "api" })] })] }), _jsxs("label", { className: "flex items-center gap-2 text-sm text-gray-700 cursor-pointer", children: [_jsx("input", { type: "checkbox", checked: data.enable_functions, onChange: (e) => setField('enable_functions', e.target.checked) }), "Enable serverless functions"] })] }) })), data.use_case === 'vercel_like' && (_jsx(Card, { className: "rounded-none border-gray-100 shadow-none bg-gray-50", children: _jsxs(CardContent, { className: "py-4 space-y-3", children: [_jsx("p", { className: "text-xs font-medium text-gray-600 uppercase tracking-wide", children: "SSR App settings" }), _jsxs("div", { children: [_jsx(Label, { htmlFor: "framework", children: "Framework" }), _jsx(Input, { id: "framework", value: data.framework, onChange: (e) => setField('framework', e.target.value), className: "mt-1.5 rounded-none border-gray-300", placeholder: "next.js" })] }), _jsxs("label", { className: "flex items-center gap-2 text-sm text-gray-700 cursor-pointer", children: [_jsx("input", { type: "checkbox", checked: data.enable_preview_deployments, onChange: (e) => setField('enable_preview_deployments', e.target.checked) }), "Enable preview deployments per branch"] })] }) })), data.use_case === 'docker_platform' && (_jsx(Card, { className: "rounded-none border-gray-100 shadow-none bg-gray-50", children: _jsxs(CardContent, { className: "py-4 space-y-3", children: [_jsx("p", { className: "text-xs font-medium text-gray-600 uppercase tracking-wide", children: "Docker settings" }), _jsxs("div", { className: "grid grid-cols-2 gap-3", children: [_jsxs("div", { children: [_jsx(Label, { htmlFor: "dockerfile_path", children: "Dockerfile Path" }), _jsx(Input, { id: "dockerfile_path", value: data.dockerfile_path, onChange: (e) => setField('dockerfile_path', e.target.value), className: "mt-1.5 rounded-none border-gray-300", placeholder: "./Dockerfile" })] }), _jsxs("div", { children: [_jsx(Label, { htmlFor: "exposed_port", children: "Exposed Port" }), _jsx(Input, { id: "exposed_port", type: "number", value: data.exposed_port, onChange: (e) => setField('exposed_port', Number(e.target.value || 3000)), className: "mt-1.5 rounded-none border-gray-300" })] })] }), _jsxs("div", { children: [_jsx(Label, { htmlFor: "target_nodes", children: "Target Nodes" }), _jsx(Input, { id: "target_nodes", value: data.target_nodes, onChange: (e) => setField('target_nodes', e.target.value), className: "mt-1.5 rounded-none border-gray-300", placeholder: "default or node-1,node-2" }), _jsx("p", { className: "text-xs text-gray-400 mt-1", children: "Comma-separated node names. Use \"default\" for primary node." })] })] }) })), _jsxs("div", { children: [_jsxs(Label, { htmlFor: "custom_domain", children: ["Custom Domain ", _jsx("span", { className: "text-gray-400 font-normal", children: "(optional)" })] }), _jsx(Input, { id: "custom_domain", value: data.custom_domain, onChange: (e) => setField('custom_domain', e.target.value), className: "mt-1.5 rounded-none border-gray-300", placeholder: "app.example.com" })] })] }), _jsxs("div", { className: "mt-5 border border-gray-100 bg-gray-50 px-4 py-3 text-xs text-gray-500 space-y-1", children: [_jsx("p", { className: "font-medium text-gray-700 text-xs mb-1", children: "Summary" }), _jsxs("p", { children: ["Model: ", _jsx("span", { className: "text-gray-900", children: data.deployment_model === 'self_hosted' ? 'Self-Hosted' : 'SaaS' })] }), _jsxs("p", { children: ["Type: ", _jsx("span", { className: "text-gray-900", children: data.use_case === 'netlify_like' ? 'Static + Functions' : data.use_case === 'vercel_like' ? 'SSR App' : 'Docker' })] }), _jsxs("p", { children: ["Repo: ", _jsx("span", { className: "text-gray-900 font-mono", children: data.repo_url || '—' }), " on ", _jsx("span", { className: "text-gray-900", children: data.repo_branch })] })] }), _jsxs("div", { className: "mt-6 flex justify-between", children: [_jsx(Button, { variant: "outline", onClick: () => setStep(3), className: "rounded-none border-gray-300", children: "\u2190 Back" }), _jsx(Button, { onClick: () => void createProject(), disabled: !canContinue || submitting, className: "bg-gray-900 text-white hover:bg-gray-800 rounded-none", children: submitting ? 'Creating…' : '🚀 Create Project' })] })] }))] })] }));
};
export default SetupWizard;
