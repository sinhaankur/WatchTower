import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { BrowserRouter, Routes, Route } from 'react-router-dom';
import { QueryClientProvider, QueryClient } from '@tanstack/react-query';
import SetupWizard from './pages/SetupWizard';
import Dashboard from './pages/Dashboard';
import TeamManagement from './pages/TeamManagement';
import NodeManagement from './pages/NodeManagement';
import GitHubOAuthCallback from './pages/GitHubOAuthCallback';
import Layout from './components/Layout';
import './App.css';
const queryClient = new QueryClient();
function App() {
    return (_jsx(QueryClientProvider, { client: queryClient, children: _jsx(BrowserRouter, { children: _jsxs(Routes, { children: [_jsx(Route, { path: "/", element: _jsx(Layout, { children: _jsx(Dashboard, {}) }) }), _jsx(Route, { path: "/nodes", element: _jsx(Layout, { children: _jsx(NodeManagement, {}) }) }), _jsx(Route, { path: "/team", element: _jsx(Layout, { children: _jsx(TeamManagement, {}) }) }), _jsx(Route, { path: "/setup", element: _jsx(SetupWizard, {}) }), _jsx(Route, { path: "/oauth/github/callback", element: _jsx(GitHubOAuthCallback, {}) })] }) }) }));
}
export default App;
