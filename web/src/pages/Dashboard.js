import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { Link } from 'react-router-dom';
import { useMemo, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle, } from '@/components/ui/card';
const STORAGE_KEY = 'wt_projects';
const Dashboard = () => {
    const [projects, setProjects] = useState(() => {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (!raw) {
            return [];
        }
        try {
            const parsed = JSON.parse(raw);
            return Array.isArray(parsed) ? parsed : [];
        }
        catch {
            return [];
        }
    });
    const stats = useMemo(() => {
        const staticCount = projects.filter((p) => p.use_case === 'netlify_like').length;
        const ssrCount = projects.filter((p) => p.use_case === 'vercel_like').length;
        const dockerCount = projects.filter((p) => p.use_case === 'docker_platform').length;
        return { staticCount, ssrCount, dockerCount };
    }, [projects]);
    const deleteProject = (id) => {
        const next = projects.filter((p) => p.id !== id);
        setProjects(next);
        localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    };
    const getUseCaseLabel = (useCase) => {
        if (useCase === 'netlify_like') {
            return 'Static + Functions';
        }
        if (useCase === 'vercel_like') {
            return 'SSR App';
        }
        return 'Docker App';
    };
    return (_jsxs("div", { className: "min-h-screen bg-white", children: [_jsx("header", { className: "border-b border-gray-100", children: _jsx("div", { className: "max-w-5xl mx-auto px-6 py-10", children: _jsxs("div", { className: "flex justify-between items-center", children: [_jsxs("div", { children: [_jsx("h1", { className: "text-3xl font-semibold tracking-wide text-gray-900", children: "WatchTower" }), _jsx("p", { className: "text-sm text-gray-500 mt-1", children: "Simple deploy platform setup and project control." })] }), _jsxs("div", { className: "flex items-center gap-2", children: [_jsx(Link, { to: "/team", children: _jsx(Button, { variant: "outline", className: "rounded-none border-gray-300", children: "Team" }) }), _jsx(Link, { to: "/nodes", children: _jsx(Button, { variant: "outline", className: "rounded-none border-gray-300", children: "Nodes" }) }), _jsx(Link, { to: "/setup", children: _jsx(Button, { className: "bg-gray-900 text-white hover:bg-gray-800 rounded-none", children: "Create Project" }) })] })] }) }) }), _jsxs("main", { className: "max-w-5xl mx-auto px-6 py-10 space-y-8", children: [_jsxs("div", { className: "grid grid-cols-3 gap-4", children: [_jsx(Card, { className: "rounded-none border-gray-200 shadow-none", children: _jsxs(CardHeader, { children: [_jsx(CardTitle, { className: "text-lg", children: "Static" }), _jsxs(CardDescription, { children: [stats.staticCount, " project(s)"] })] }) }), _jsx(Card, { className: "rounded-none border-gray-200 shadow-none", children: _jsxs(CardHeader, { children: [_jsx(CardTitle, { className: "text-lg", children: "SSR" }), _jsxs(CardDescription, { children: [stats.ssrCount, " project(s)"] })] }) }), _jsx(Card, { className: "rounded-none border-gray-200 shadow-none", children: _jsxs(CardHeader, { children: [_jsx(CardTitle, { className: "text-lg", children: "Docker" }), _jsxs(CardDescription, { children: [stats.dockerCount, " project(s)"] })] }) })] }), _jsxs(Card, { className: "rounded-none border-gray-200 shadow-none", children: [_jsxs(CardHeader, { children: [_jsx(CardTitle, { className: "text-xl", children: "Step-by-Step Install & Setup" }), _jsx(CardDescription, { children: "Follow these steps for first-time users." })] }), _jsx(CardContent, { children: _jsxs("ol", { className: "grid md:grid-cols-2 gap-4 text-sm text-gray-700", children: [_jsxs("li", { className: "border border-gray-200 p-4", children: [_jsx("p", { className: "font-semibold mb-1", children: "1. Start Services" }), _jsxs("p", { children: ["Run ", _jsx("code", { children: "./scripts/dev-up.sh" }), " to launch UI + API."] })] }), _jsxs("li", { className: "border border-gray-200 p-4", children: [_jsx("p", { className: "font-semibold mb-1", children: "2. Open Setup Wizard" }), _jsx("p", { children: "Click Create Project and choose deployment model + use case." })] }), _jsxs("li", { className: "border border-gray-200 p-4", children: [_jsx("p", { className: "font-semibold mb-1", children: "3. Connect Repository" }), _jsx("p", { children: "Enter repository URL, branch, and build command." })] }), _jsxs("li", { className: "border border-gray-200 p-4", children: [_jsx("p", { className: "font-semibold mb-1", children: "4. Manage Projects" }), _jsx("p", { children: "Create, review, and delete projects from this dashboard." })] })] }) })] }), _jsxs(Card, { className: "rounded-none border-gray-200 shadow-none", children: [_jsxs(CardHeader, { children: [_jsx(CardTitle, { className: "text-xl", children: "Project Management" }), _jsx(CardDescription, { children: "Manage created projects, including delete operations." })] }), _jsxs(CardContent, { children: [projects.length === 0 && (_jsxs("div", { className: "text-center py-8 border border-dashed border-gray-300", children: [_jsx("p", { className: "text-gray-500 mb-4", children: "No projects yet." }), _jsx(Link, { to: "/setup", children: _jsx(Button, { className: "bg-gray-900 text-white hover:bg-gray-800 rounded-none", children: "Start Setup Wizard" }) })] })), projects.length > 0 && (_jsx("div", { className: "space-y-3", children: projects.map((project) => (_jsxs("div", { className: "border border-gray-200 p-4 flex items-center justify-between gap-4", children: [_jsxs("div", { children: [_jsx("p", { className: "text-sm font-semibold text-gray-900", children: project.name }), _jsxs("p", { className: "text-xs text-gray-500 mt-1", children: [getUseCaseLabel(project.use_case), " \u00B7 ", project.deployment_model === 'self_hosted' ? 'Self-hosted' : 'SaaS', " \u00B7 ", project.repo_branch] })] }), _jsxs("div", { className: "flex items-center gap-2", children: [_jsx("a", { href: project.repo_url, target: "_blank", rel: "noreferrer", className: "text-xs text-gray-600 underline", children: "Repo" }), _jsx(Button, { variant: "outline", className: "rounded-none border-gray-300 text-gray-700 hover:bg-gray-50", onClick: () => deleteProject(project.id), children: "Delete" })] })] }, project.id))) }))] })] })] })] }));
};
export default Dashboard;
