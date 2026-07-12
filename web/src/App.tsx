import { lazy, Suspense, useEffect, useLayoutEffect, type ReactElement } from 'react';
import { BrowserRouter, Routes, Route, Navigate, useLocation } from 'react-router-dom';
import { trackPageView } from '@/lib/analytics';
import { QueryClientProvider, QueryClient, MutationCache, QueryCache } from '@tanstack/react-query';
import { toast } from './lib/toast';
// Eager — first-paint critical (the login screen is the guaranteed first view
// for logged-out users), plus the chrome that wraps every authed page. Dashboard
// is NO LONGER eager: since the redesign, a fresh user lands on /start, not /,
// so inlining Dashboard's ~30KB into the initial bundle taxed every load for a
// page not always shown first. It's lazy below with the rest.
import Login from './pages/Login';
import Layout from './components/Layout';
import ErrorBoundary from './components/ErrorBoundary';
import LegalGate from './components/LegalGate';
import RouteErrorBoundary from './components/RouteErrorBoundary';
import { PageTransition } from './components/PageTransition';
import { Toaster } from './lib/toast';
import './App.css';

// Lazy — split out of the main bundle. ~50ms first-click penalty per
// page on a desktop, invisible vs. the savings on the cold-start
// bundle. The Suspense fallback is a faint full-height div so route
// switches don't flash a giant spinner mid-layout.
const Dashboard            = lazy(() => import('./pages/Dashboard'));
const SetupWizard          = lazy(() => import('./pages/SetupWizard'));
const FirstRun             = lazy(() => import('./pages/FirstRun'));
const ProjectDetail        = lazy(() => import('./pages/ProjectDetail'));
const DeploymentDetail     = lazy(() => import('./pages/DeploymentDetail'));
const Templates            = lazy(() => import('./pages/Templates'));
const TeamManagement       = lazy(() => import('./pages/TeamManagement'));
const InviteAccept         = lazy(() => import('./pages/InviteAccept'));
const Servers              = lazy(() => import('./pages/Servers'));
const Applications         = lazy(() => import('./pages/Applications'));
const LocalNode            = lazy(() => import('./pages/LocalNode'));
const Services             = lazy(() => import('./pages/Services'));
const Integrations         = lazy(() => import('./pages/Integrations'));
const Settings             = lazy(() => import('./pages/Settings'));
const AuditLog             = lazy(() => import('./pages/AuditLog'));
const Account              = lazy(() => import('./pages/Account'));
const LocalContainers      = lazy(() => import('./pages/LocalContainers'));
const HostConnect          = lazy(() => import('./pages/HostConnect'));
const RemoteAccess         = lazy(() => import('./pages/RemoteAccess'));
const ManagedDatabases     = lazy(() => import('./pages/ManagedDatabases'));
const ReportBug            = lazy(() => import('./pages/ReportBug'));
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

  // Click-through legal gate: authenticated users must accept the
  // current terms version before anything else renders. Recorded
  // server-side; see watchtower/legal_docs.py + /api/legal.
  return <LegalGate>{children}</LegalGate>;
}

/**
 * Per-route browser-tab title. Without this every tab, history entry,
 * and analytics page_view reads the same static index.html title, so
 * users with three WatchTower tabs open can't tell them apart.
 * useLayoutEffect (not useEffect) so the title is set before
 * RouteTracker's passive effect snapshots document.title for GA.
 */
function PageTitle({ name }: { name: string }) {
  useLayoutEffect(() => {
    document.title = name === 'Dashboard' ? 'WatchTower' : `${name} · WatchTower`;
  }, [name]);
  return null;
}

/**
 * Wrap a page in:
 *   - per-route error boundary (failures stay scoped to this page)
 *   - the auth gate (redirects to /login if no token)
 *   - the shared sidebar layout (skipped when `bare` is true for full-
 *     screen pages like the wizard / oauth callback / invite landing)
 *
 * Without this, every Route line repeats four nested wrappers and adding
 * a new page is tedious enough to skip the boundary "just for now".
 */
function withChrome(pageName: string, element: ReactElement, opts: { bare?: boolean } = {}): ReactElement {
  // PageTransition keys off pathname so its fade-in fires every time the
  // route changes — the chrome (Layout/RequireAuth) doesn't unmount, so
  // without keying we'd only animate on first load.
  const animated = <PageTransition>{element}</PageTransition>;
  const wrapped = opts.bare ? animated : <Layout>{animated}</Layout>;
  return (
    <RequireAuth>
      <RouteErrorBoundary pageName={pageName}>
        <PageTitle name={pageName} />
        {wrapped}
      </RouteErrorBoundary>
    </RequireAuth>
  );
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
            <Route path="/login" element={<><PageTitle name="Sign in" /><Login /></>} />
            <Route path="/oauth/github/login/callback" element={<GitHubLoginCallback />} />

            {/* Pages with shared sidebar layout */}
            <Route path="/"                  element={withChrome('Dashboard',        <Dashboard />)} />
            <Route path="/projects/:id"      element={withChrome('Project',          <ProjectDetail />)} />
            <Route path="/deployments/:id"   element={withChrome('Deployment',       <DeploymentDetail />)} />
            <Route path="/servers"           element={withChrome('Servers',          <Servers />)} />
            <Route path="/servers/local"     element={withChrome('Local node',       <LocalNode />)} />
            <Route path="/applications"      element={withChrome('Sites',            <Applications />)} />
            <Route path="/templates"         element={withChrome('Templates',        <Templates />)} />
            <Route path="/services"          element={withChrome('Catalog',          <Services />)} />
            <Route path="/integrations"      element={withChrome('Integrations',     <Integrations />)} />
            <Route path="/host-connect"      element={withChrome('Host Connect',     <HostConnect />)} />
            <Route path="/remote-access"     element={withChrome('Remote Access',    <RemoteAccess />)} />
            <Route path="/managed-databases" element={withChrome('Managed Databases', <ManagedDatabases />)} />
            <Route path="/team"              element={withChrome('Team',             <TeamManagement />)} />
            <Route path="/invite/:token"     element={withChrome('Invitation',       <InviteAccept />, { bare: true })} />
            <Route path="/settings"          element={withChrome('Settings',         <Settings />)} />
            <Route path="/report-bug"        element={withChrome('Report Bug',       <ReportBug />)} />
            <Route path="/audit"             element={withChrome('Audit log',        <AuditLog />)} />
            <Route path="/account"           element={withChrome('Account',          <Account />)} />
            <Route path="/local-containers"  element={withChrome('Local containers', <LocalContainers />)} />
            {/* Legacy redirects — old paths that no longer have their own page. */}
            <Route path="/nodes" element={<Navigate to="/servers" replace />} />
            <Route path="/databases" element={<Navigate to="/managed-databases" replace />} />
            {/* Full-screen pages (wizard & oauth flow — no sidebar) */}
            <Route path="/start"                  element={withChrome('Get started',   <FirstRun />,           { bare: true })} />
            <Route path="/setup"                  element={withChrome('Setup wizard',  <SetupWizard />,        { bare: true })} />
            <Route path="/oauth/github/callback"  element={withChrome('OAuth callback', <GitHubOAuthCallback />, { bare: true })} />
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
