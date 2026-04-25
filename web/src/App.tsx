import { useEffect } from 'react';
import { BrowserRouter, Routes, Route, Navigate, useLocation } from 'react-router-dom';
import { trackPageView } from '@/lib/analytics';
import { QueryClientProvider, QueryClient } from '@tanstack/react-query';
import SetupWizard from './pages/SetupWizard';
import Dashboard from './pages/Dashboard';
import ProjectDetail from './pages/ProjectDetail';
import TeamManagement from './pages/TeamManagement';
import Servers from './pages/Servers';
import Applications from './pages/Applications';
import LocalNode from './pages/LocalNode';
import Databases from './pages/Databases';
import Services from './pages/Services';
import Settings from './pages/Settings';
import HostConnect from './pages/HostConnect';
import GitHubOAuthCallback from './pages/GitHubOAuthCallback';
import GitHubLoginCallback from './pages/GitHubLoginCallback';
import Login from './pages/Login';
import Layout from './components/Layout';
import './App.css';

const queryClient = new QueryClient();

/** Fires a GA page_view on every client-side navigation. */
function RouteTracker() {
  const location = useLocation();
  useEffect(() => {
    // Strip query strings and hash to avoid sending PII.
    trackPageView(location.pathname);
  }, [location.pathname]);
  return null;
}

function RequireAuth({ children }: { children: JSX.Element }) {
  const location = useLocation();
  const envToken = (import.meta as any).env?.VITE_API_TOKEN;
  const token = localStorage.getItem('authToken') || envToken;

  if (!token) {
    return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  }

  return children;
}

function App() {
  useEffect(() => {
    // Keep a single light visual system across all pages.
    document.documentElement.setAttribute('data-theme', 'light');
  }, []);

  return (
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>          <RouteTracker />        <Routes>
          <Route path="/login" element={<Login />} />
          <Route path="/oauth/github/login/callback" element={<GitHubLoginCallback />} />

          {/* Pages with shared sidebar layout */}
          <Route path="/" element={<RequireAuth><Layout><Dashboard /></Layout></RequireAuth>} />
          <Route path="/projects/:id" element={<RequireAuth><Layout><ProjectDetail /></Layout></RequireAuth>} />
          <Route path="/servers" element={<RequireAuth><Layout><Servers /></Layout></RequireAuth>} />
          <Route path="/servers/local" element={<RequireAuth><Layout><LocalNode /></Layout></RequireAuth>} />
          <Route path="/applications" element={<RequireAuth><Layout><Applications /></Layout></RequireAuth>} />
          <Route path="/databases" element={<RequireAuth><Layout><Databases /></Layout></RequireAuth>} />
          <Route path="/services" element={<RequireAuth><Layout><Services /></Layout></RequireAuth>} />
          <Route path="/host-connect" element={<RequireAuth><Layout><HostConnect /></Layout></RequireAuth>} />
          <Route path="/team" element={<RequireAuth><Layout><TeamManagement /></Layout></RequireAuth>} />
          <Route path="/settings" element={<RequireAuth><Layout><Settings /></Layout></RequireAuth>} />
          {/* Legacy redirect */}
          <Route path="/nodes" element={<Navigate to="/servers" replace />} />
          {/* Full-screen pages (wizard & oauth flow — no sidebar) */}
          <Route path="/setup" element={<RequireAuth><SetupWizard /></RequireAuth>} />
          <Route path="/oauth/github/callback" element={<RequireAuth><GitHubOAuthCallback /></RequireAuth>} />
        </Routes>
      </BrowserRouter>
    </QueryClientProvider>
  );
}

export default App;
