/**
 * Page-render smoke test.
 *
 * For every top-level page in App.tsx, mount the component inside the
 * minimum chrome (React Query, Router, Suspense), feed any axios call
 * a benign empty-but-shaped response, and assert no React error is
 * thrown during the first render and microtask.
 *
 * What this catches:
 *   - JSX/TSX runtime errors that get past tsc (e.g. accessing .x on
 *     undefined when a state is null)
 *   - "Cannot read properties of undefined (reading 'map')" — the
 *     class of bug that left Templates blank-screening for users
 *   - Missing required props or context providers
 *
 * What this does NOT catch:
 *   - Logic correctness (we don't assert UI content)
 *   - Async/effect errors after the first microtask
 *   - Server-side bugs
 *   - User-interaction bugs (no click testing)
 *
 * Add new pages here when you ship them. The cost of forgetting is one
 * test failure on the next CI run, not a silent regression.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import { Suspense, lazy } from 'react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import RouteErrorBoundary from '@/components/RouteErrorBoundary';

// Stub apiClient before any page imports it. The pages all use
// `apiClient.get|post|put|delete`. Returning empty arrays / objects
// keeps render code paths from blowing up on undefined data.
vi.mock('@/lib/api', () => {
  const empty = (path: string) => {
    // A few endpoints have callers that destructure specific shapes —
    // give the most-common ones a benign default. Generic GET → [].
    if (path.includes('/templates'))   return { templates: [] };
    if (path.includes('/context'))     return {
      user: { id: '00000000-0000-0000-0000-000000000000', email: 't@t', name: 't' },
      organization: { id: '00000000-0000-0000-0000-000000000000', name: 'Org' },
      membership: { id: '00000000-0000-0000-0000-000000000000', role: 'owner', can_manage_team: true, can_manage_nodes: true, can_manage_deployments: true },
    };
    if (path.includes('/edition'))     return { tier: 'free', features: {} };
    if (path.includes('/runtime'))     return { podman: { installed: false, version: null, sample_containers: [] } };
    if (path.includes('/auth/status')) return { oauth: { github_configured: false, missing: [] }, device_flow: { github_configured: false }, api_token: { configured: true }, dev_auth: { allow_insecure: false }, recommended: 'api_token', installation: { owner_mode_enabled: false } };
    return [];
  };
  const get = vi.fn(async (path: string) => ({ data: empty(path), headers: { 'x-request-id': 'test' } }));
  const post = vi.fn(async () => ({ data: {}, headers: { 'x-request-id': 'test' } }));
  const put = vi.fn(async () => ({ data: {}, headers: { 'x-request-id': 'test' } }));
  const del = vi.fn(async () => ({ data: {}, headers: { 'x-request-id': 'test' } }));
  const apiClient = { get, post, put, delete: del, interceptors: { request: { use: () => 0 }, response: { use: () => 0 } } };
  return {
    default: apiClient,
    apiClient,
    getLastRequestId: () => 'test-request-id',
  };
});

// Stub the analytics tracker — pageview firing during tests is noise.
vi.mock('@/lib/analytics', () => ({ trackPageView: () => {} }));

// localStorage with a session token so RequireAuth doesn't redirect away.
beforeAll(() => {
  window.localStorage.setItem('authToken', 'test-session-token');
});

afterEach(() => cleanup());

const PAGES: { path: string; name: string; importer: () => Promise<{ default: React.ComponentType<unknown> }> }[] = [
  { path: '/dashboard',         name: 'Dashboard',        importer: () => import('@/pages/Dashboard') },
  { path: '/projects/test',     name: 'ProjectDetail',    importer: () => import('@/pages/ProjectDetail') },
  { path: '/templates',         name: 'Templates',        importer: () => import('@/pages/Templates') },
  { path: '/team',              name: 'TeamManagement',   importer: () => import('@/pages/TeamManagement') },
  { path: '/invite/abc',        name: 'InviteAccept',     importer: () => import('@/pages/InviteAccept') },
  { path: '/servers',           name: 'Servers',          importer: () => import('@/pages/Servers') },
  { path: '/applications',      name: 'Applications',     importer: () => import('@/pages/Applications') },
  { path: '/servers/local',     name: 'LocalNode',        importer: () => import('@/pages/LocalNode') },
  { path: '/services',          name: 'Services',         importer: () => import('@/pages/Services') },
  { path: '/integrations',      name: 'Integrations',     importer: () => import('@/pages/Integrations') },
  { path: '/settings',          name: 'Settings',         importer: () => import('@/pages/Settings') },
  { path: '/audit',             name: 'AuditLog',         importer: () => import('@/pages/AuditLog') },
  { path: '/account',           name: 'Account',          importer: () => import('@/pages/Account') },
  { path: '/local-containers',  name: 'LocalContainers',  importer: () => import('@/pages/LocalContainers') },
  { path: '/host-connect',      name: 'HostConnect',      importer: () => import('@/pages/HostConnect') },
  { path: '/login',             name: 'Login',            importer: () => import('@/pages/Login') },
];

function makeQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false, refetchOnWindowFocus: false },
      mutations: { retry: false },
    },
  });
}

describe('pages render without throwing', () => {
  for (const page of PAGES) {
    it(page.name, async () => {
      const Page = lazy(page.importer);
      // The RouteErrorBoundary swallows render errors and renders a
      // fallback. To make a render failure cause the test to fail,
      // we let it bubble by passing a boundary that re-throws.
      let caught: Error | null = null;
      class CatchingBoundary extends RouteErrorBoundary {
        componentDidCatch(error: Error): void {
          caught = error;
        }
        render() {
          if (this.state.error) caught = this.state.error;
          return super.render();
        }
      }
      render(
        <QueryClientProvider client={makeQueryClient()}>
          <MemoryRouter initialEntries={[page.path]}>
            <Suspense fallback={<div data-testid="suspense-fallback" />}>
              <CatchingBoundary pageName={page.name}>
                <Routes>
                  <Route path={page.path} element={<Page />} />
                  <Route path="*" element={<Page />} />
                </Routes>
              </CatchingBoundary>
            </Suspense>
          </MemoryRouter>
        </QueryClientProvider>,
      );
      // Wait one macrotask so lazy import resolves and effects run.
      await new Promise((r) => setTimeout(r, 0));
      await new Promise((r) => setTimeout(r, 0));
      expect(caught).toBeNull();
    });
  }
});
