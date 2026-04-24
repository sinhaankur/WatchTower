import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
import { Link } from 'react-router-dom';
import { useMemo, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle, } from '@/components/ui/card';
const STORAGE_KEY = 'wt_projects';
const USE_CASE_META = {
    netlify_like: { label: 'Static + Functions', icon: '⚡', color: 'bg-blue-50 text-blue-700 border-blue-200' },
    vercel_like: { label: 'SSR App', icon: '▲', color: 'bg-purple-50 text-purple-700 border-purple-200' },
    docker_platform: { label: 'Docker App', icon: '🐳', color: 'bg-cyan-50 text-cyan-700 border-cyan-200' },
};
const Dashboard = () => {
    const [projects, setProjects] = useState(() => {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (!raw)
            return [];
        try {
            const parsed = JSON.parse(raw);
            return Array.isArray(parsed) ? parsed : [];
        }
        catch {
            return [];
        }
    });
    const [confirmDelete, setConfirmDelete] = useState(null);
    const stats = useMemo(() => ({
        staticCount: projects.filter((p) => p.use_case === 'netlify_like').length,
        ssrCount: projects.filter((p) => p.use_case === 'vercel_like').length,
        dockerCount: projects.filter((p) => p.use_case === 'docker_platform').length,
    }), [projects]);
    const deleteProject = (id) => {
        const next = projects.filter((p) => p.id !== id);
        setProjects(next);
        localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
        setConfirmDelete(null);
    };
    const isFirstVisit = projects.length === 0;
    return (_jsxs("div", { className: "flex-1 overflow-auto bg-gray-50", children: [_jsx("header", { className: "bg-white border-b border-gray-100", children: _jsxs("div", { className: "px-8 py-5 flex justify-between items-center", children: [_jsxs("div", { children: [_jsx("h1", { className: "text-base font-semibold text-gray-900", children: "Overview" }), _jsx("p", { className: "text-xs text-gray-400 mt-0.5", children: "Your projects and deployment status" })] }), _jsx(Link, { to: "/setup", children: _jsx(Button, { className: "bg-gray-900 text-white hover:bg-gray-800 rounded-none text-sm", children: "+ New Project" }) })] }) }), _jsxs("main", { className: "px-8 py-6 space-y-6 max-w-5xl", children: [isFirstVisit && (_jsxs("div", { className: "border border-amber-200 bg-amber-50 px-5 py-4 flex items-start gap-3", children: [_jsx("span", { className: "text-amber-500 text-lg mt-0.5", children: "\uD83D\uDC4B" }), _jsxs("div", { children: [_jsx("p", { className: "text-sm font-medium text-amber-900", children: "Welcome to WatchTower!" }), _jsx("p", { className: "text-xs text-amber-700 mt-0.5", children: "Get started by creating your first project. The setup wizard will guide you through every step." }), _jsx(Link, { to: "/setup", children: _jsx(Button, { className: "mt-3 bg-gray-900 text-white hover:bg-gray-800 rounded-none text-xs", children: "Start Setup Wizard \u2192" }) })] })] })), _jsx("div", { className: "grid grid-cols-3 gap-3", children: [
                            { label: 'Static + Functions', count: stats.staticCount, icon: '⚡' },
                            { label: 'SSR Apps', count: stats.ssrCount, icon: '▲' },
                            { label: 'Docker Apps', count: stats.dockerCount, icon: '🐳' },
                        ].map((s) => (_jsx(Card, { className: "rounded-none border-gray-200 shadow-none bg-white", children: _jsxs(CardContent, { className: "py-4 flex items-center gap-3", children: [_jsx("span", { className: "text-2xl", children: s.icon }), _jsxs("div", { children: [_jsx("p", { className: "text-2xl font-bold text-gray-900 leading-none", children: s.count }), _jsx("p", { className: "text-xs text-gray-500 mt-0.5", children: s.label })] })] }) }, s.label))) }), _jsxs(Card, { className: "rounded-none border-gray-200 shadow-none bg-white", children: [_jsxs(CardHeader, { className: "pb-3", children: [_jsx(CardTitle, { className: "text-base", children: "How to get started" }), _jsx(CardDescription, { children: "Four steps to deploy your first app" })] }), _jsx(CardContent, { children: _jsx("ol", { className: "grid md:grid-cols-2 gap-3", children: [
                                        { n: 1, title: 'Start the server', body: _jsxs(_Fragment, { children: ["Run ", _jsx("code", { className: "bg-gray-100 px-1 rounded text-xs", children: "./scripts/dev-up.sh" }), " to launch the UI + API."] }) },
                                        { n: 2, title: 'Create a project', body: 'Click "+ New Project" and choose your deployment type and use case.' },
                                        { n: 3, title: 'Connect your repo', body: 'Enter your repository URL, branch, and build command.' },
                                        { n: 4, title: 'Deploy & monitor', body: 'Use Nodes to add servers, Team to invite collaborators.' },
                                    ].map(({ n, title, body }) => (_jsxs("li", { className: "flex gap-3 border border-gray-100 bg-gray-50 px-4 py-3", children: [_jsx("span", { className: "w-6 h-6 rounded-full bg-gray-900 text-white text-xs flex items-center justify-center shrink-0 mt-0.5", children: n }), _jsxs("div", { children: [_jsx("p", { className: "text-sm font-medium text-gray-800", children: title }), _jsx("p", { className: "text-xs text-gray-500 mt-0.5", children: body })] })] }, n))) }) })] }), _jsxs(Card, { className: "rounded-none border-gray-200 shadow-none bg-white", children: [_jsxs(CardHeader, { className: "pb-3 flex flex-row items-center justify-between", children: [_jsxs("div", { children: [_jsx(CardTitle, { className: "text-base", children: "Your Projects" }), _jsx(CardDescription, { children: projects.length === 0 ? 'No projects yet' : `${projects.length} project${projects.length !== 1 ? 's' : ''}` })] }), projects.length > 0 && (_jsx(Link, { to: "/setup", children: _jsx(Button, { className: "bg-gray-900 text-white hover:bg-gray-800 rounded-none text-xs", children: "+ New Project" }) }))] }), _jsxs(CardContent, { children: [projects.length === 0 && (_jsxs("div", { className: "text-center py-10 border border-dashed border-gray-200", children: [_jsx("p", { className: "text-3xl mb-2", children: "\uD83D\uDCE6" }), _jsx("p", { className: "text-sm font-medium text-gray-600", children: "No projects yet" }), _jsx("p", { className: "text-xs text-gray-400 mt-1", children: "Create a project using the Setup Wizard to get started." }), _jsx(Link, { to: "/setup", children: _jsx(Button, { className: "mt-4 bg-gray-900 text-white hover:bg-gray-800 rounded-none text-sm", children: "Start Setup Wizard \u2192" }) })] })), _jsx("div", { className: "space-y-2", children: projects.map((project) => {
                                            const meta = USE_CASE_META[project.use_case];
                                            return (_jsxs("div", { className: "border border-gray-200 bg-gray-50 px-4 py-3 flex items-center justify-between gap-4", children: [_jsxs("div", { className: "flex items-center gap-3 min-w-0", children: [_jsx("span", { className: "text-xl", children: meta.icon }), _jsxs("div", { className: "min-w-0", children: [_jsx("p", { className: "text-sm font-semibold text-gray-900 truncate", children: project.name }), _jsxs("div", { className: "flex items-center gap-2 mt-0.5 flex-wrap", children: [_jsx("span", { className: `text-xs px-2 py-0.5 border rounded-full ${meta.color}`, children: meta.label }), _jsx("span", { className: "text-xs text-gray-400", children: project.deployment_model === 'self_hosted' ? 'Self-hosted' : 'SaaS' }), _jsx("span", { className: "text-xs font-mono text-gray-400", children: project.repo_branch })] })] })] }), _jsxs("div", { className: "flex items-center gap-2 shrink-0", children: [project.repo_url && (_jsx("a", { href: project.repo_url, target: "_blank", rel: "noreferrer", className: "text-xs text-gray-500 hover:text-gray-700 underline", children: "Repo \u2197" })), confirmDelete === project.id ? (_jsxs("div", { className: "flex items-center gap-1", children: [_jsx("span", { className: "text-xs text-gray-500", children: "Delete?" }), _jsx(Button, { variant: "outline", className: "rounded-none border-red-300 text-red-600 text-xs px-2 py-1 h-auto hover:bg-red-50", onClick: () => deleteProject(project.id), children: "Yes" }), _jsx(Button, { variant: "outline", className: "rounded-none border-gray-300 text-xs px-2 py-1 h-auto", onClick: () => setConfirmDelete(null), children: "No" })] })) : (_jsx(Button, { variant: "outline", className: "rounded-none border-gray-300 text-gray-500 text-xs hover:border-red-300 hover:text-red-600", onClick: () => setConfirmDelete(project.id), children: "Delete" }))] })] }, project.id));
                                        }) })] })] })] })] }));
};
export default Dashboard;
