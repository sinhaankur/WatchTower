import { lazy, Suspense, useEffect, type ReactElement } from 'react';
import { BrowserRouter, Routes, Route, Navigate, useLocation } from 'react-router-dom';
import { trackPageView } from '@/lib/analytics';
import { QueryClientProvider, QueryClient, MutationCache, QueryCache } from '@tanstack/react-query';
import { toast } from './lib/toast';
// Eager — first-paint critical (login screen, then Dashboard for the
// authed cold start), plus the chrome that wraps every authed page.
import Dashboard from './pages/Dashboard';
import Login from './pages/Login';
import Layout from './components/Layout';
import ErrorBoundary from './components/ErrorBoundary';
import { Toaster } from './lib/toast';
import './App.css';

// Lazy — split out of the main bundle. ~50ms first-click penalty per
// page on a desktop, invisible vs. the savings on the cold-start
// bundle. The Suspense fallback is a faint full-height div so route
// switches don't flash a giant spinner mid-layout.
const SetupWizard          = lazy(() => import('./pages/SetupWizard'));
const ProjectDetail        = lazy(() => import('./pages/ProjectDetail'));
const Templates            = lazy(() => import('./pages/Templates'));
const TeamManagement       = lazy(() => import('./pages/TeamManagement'));
const Servers              = lazy(() => import('./pages/Servers'));
const Applications         = lazy(() => import('./pages/Applications'));
const LocalNode            = lazy(() => import('./pages/LocalNode'));
const Databases            = lazy(() => import('./pages/Databases'));
const Services             = lazy(() => import('./pages/Services'));
const Integrations         = lazy(() => import('./pages/Integrations'));
const Settings             = lazy(() => import('./pages/Settings'));
const AuditLog             = lazy(() => import('./pages/AuditLog'));
const HostConnect          = lazy(() => import('./pages/HostConnect'));
const GitHubOAuthCallback  = lazy(() => import('./pages/GitHubOAuthCallback'));
const GitHubLoginCallback  = lazy(() => import('./pages/GitHubLoginCallback'));

function RouteFallback() {
  // Subtle blank panel — a spinner mid-layout flashes more than it
  // helps. Lazy chunks load in well under 100 ms on local files.
  return <div className="flex-1 bg-slate-50" aria-busy="true" />;
}

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
      <BrowserRouter>
        <RouteTracker />
        <Suspense fallback={<RouteFallback />}>
          <Routes>
            <Route path="/login" element={<Login />} />
            <Route path="/oauth/github/login/callback" element={<GitHubLoginCallback />} />

            {/* Pages with shared sidebar layout */}
            <Route path="/" element={<RequireAuth><Layout><Dashboard /></Layout></RequireAuth>} />
            <Route path="/projects/:id" element={<RequireAuth><Layout><ProjectDetail /></Layout></RequireAuth>} />
            <Route path="/servers" element={<RequireAuth><Layout><Servers /></Layout></RequireAuth>} />
            <Route path="/servers/local" element={<RequireAuth><Layout><LocalNode /></Layout></RequireAuth>} />
            <Route path="/applications" element={<RequireAuth><Layout><Applications /></Layout></RequireAuth>} />
            <Route path="/templates" element={<RequireAuth><Layout><Templates /></Layout></RequireAuth>} />
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
        </Suspense>
      </BrowserRouter>
      <Toaster />
    </QueryClientProvider>
    </ErrorBoundary>
  );
}

export default App;
