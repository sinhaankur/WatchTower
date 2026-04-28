import { useEffect, type ReactElement } from 'react';
import { BrowserRouter, Routes, Route, Navigate, useLocation } from 'react-router-dom';
import { trackPageView } from '@/lib/analytics';
import { QueryClientProvider, QueryClient, MutationCache, QueryCache } from '@tanstack/react-query';
import { toast } from './lib/toast';
import SetupWizard from './pages/SetupWizard';
import Dashboard from './pages/Dashboard';
import ProjectDetail from './pages/ProjectDetail';
import TeamManagement from './pages/TeamManagement';
import Servers from './pages/Servers';
import Applications from './pages/Applications';
import LocalNode from './pages/LocalNode';
import Databases from './pages/Databases';
import Services from './pages/Services';
import Integrations from './pages/Integrations';
import Settings from './pages/Settings';
import AuditLog from './pages/AuditLog';
import HostConnect from './pages/HostConnect';
import GitHubOAuthCallback from './pages/GitHubOAuthCallback';
import GitHubLoginCallback from './pages/GitHubLoginCallback';
import Login from './pages/Login';
import Layout from './components/Layout';
import ErrorBoundary from './components/ErrorBoundary';
import { Toaster } from './lib/toast';
import './App.css';

// Surface query/mutation failures via toast so a 500/network error
// doesn't disappear into the React Query cache. We skip 401s because
// the apiClient interceptor already redirects to /login — toasting
// "Unauthorized" on top would just be noise.
//
// Per-component `onError` handlers still run, so pages that already
// show inline error UI (Servers banner, Login form) keep that — they
// just don't *also* get a toast unless they don't override.
const queryClient = new QueryClient({
  queryCache: new QueryCache({
    onError: (error, query) => {
      const status = (error as { response?: { status?: number } })?.response?.status;
      if (status === 401) return;
      // Skip if the consumer set its own onError — but @tanstack v5 doesn't
      // expose a clean check, so we just dedupe by query key string.
      if (query.meta?.silent) return;
      toast.fromError(error, 'Failed to load data');
    },
  }),
  mutationCache: new MutationCache({
    onError: (error, _vars, _ctx, mutation) => {
      const status = (error as { response?: { status?: number } })?.response?.status;
      if (status === 401) return;
      if (mutation.options.onError) return; // consumer handles it
      toast.fromError(error, 'Action failed');
    },
  }),
  defaultOptions: {
    queries: {
      // Don't hammer the API on a transient blip — single retry is enough.
      retry: 1,
      retryDelay: 500,
    },
  },
});

/** Fires a GA page_view on every client-side navigation. */
function RouteTracker() {
  const location = useLocation();
  useEffect(() => {
    // Strip query strings and hash to avoid sending PII.
    trackPageView(location.pathname);
  }, [location.pathname]);
  return null;
}

function RequireAuth({ children }: { children: ReactElement }) {
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
    <ErrorBoundary>
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
          <Route path="/integrations" element={<RequireAuth><Layout><Integrations /></Layout></RequireAuth>} />
          <Route path="/host-connect" element={<RequireAuth><Layout><HostConnect /></Layout></RequireAuth>} />
          <Route path="/team" element={<RequireAuth><Layout><TeamManagement /></Layout></RequireAuth>} />
          <Route path="/settings" element={<RequireAuth><Layout><Settings /></Layout></RequireAuth>} />
          <Route path="/audit" element={<RequireAuth><Layout><AuditLog /></Layout></RequireAuth>} />
          {/* Legacy redirect */}
          <Route path="/nodes" element={<Navigate to="/servers" replace />} />
          {/* Full-screen pages (wizard & oauth flow — no sidebar) */}
          <Route path="/setup" element={<RequireAuth><SetupWizard /></RequireAuth>} />
          <Route path="/oauth/github/callback" element={<RequireAuth><GitHubOAuthCallback /></RequireAuth>} />
          {/* Catch-all: redirect any unmatched path to home instead of showing a blank page */}
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </BrowserRouter>
      <Toaster />
    </QueryClientProvider>
    </ErrorBoundary>
  );
}

export default App;
