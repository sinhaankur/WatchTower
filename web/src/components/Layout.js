import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { Link, useLocation } from 'react-router-dom';
const NAV_ITEMS = [
    { path: '/', label: 'Overview', icon: '◉' },
    { path: '/setup', label: 'New Project', icon: '+' },
    { path: '/nodes', label: 'Nodes', icon: '○' },
    { path: '/team', label: 'Team', icon: '◎' },
];
export default function Layout({ children }) {
    const { pathname } = useLocation();
    return (_jsxs("div", { className: "flex min-h-screen bg-gray-50", children: [_jsxs("aside", { className: "w-56 shrink-0 bg-white border-r border-gray-100 flex flex-col", children: [_jsxs("div", { className: "px-5 py-5 border-b border-gray-100", children: [_jsx("p", { className: "text-sm font-semibold text-gray-900 tracking-tight", children: "WatchTower" }), _jsx("p", { className: "text-[11px] text-gray-400 mt-0.5", children: "Deploy Platform" })] }), _jsx("nav", { className: "flex-1 px-3 py-4 space-y-1", children: NAV_ITEMS.map(({ path, label, icon }) => {
                            const active = path === '/' ? pathname === '/' : pathname.startsWith(path);
                            return (_jsxs(Link, { to: path, className: `flex items-center gap-3 px-3 py-2 text-sm rounded transition-colors ${active
                                    ? 'bg-gray-100 text-gray-900 font-medium'
                                    : 'text-gray-500 hover:bg-gray-50 hover:text-gray-800'}`, children: [_jsx("span", { className: `text-xs font-mono ${active ? 'text-gray-700' : 'text-gray-400'}`, children: icon }), label] }, path));
                        }) }), _jsxs("div", { className: "px-5 py-4 border-t border-gray-100", children: [_jsx("p", { className: "text-[11px] text-gray-400", children: "v2.0.0" }), _jsx("a", { href: "https://github.com/sinhaankur/WatchTower", target: "_blank", rel: "noreferrer", className: "text-[11px] text-gray-400 hover:text-gray-600 transition-colors", children: "GitHub \u2197" })] })] }), _jsx("div", { className: "flex-1 flex flex-col min-w-0", children: children })] }));
}
