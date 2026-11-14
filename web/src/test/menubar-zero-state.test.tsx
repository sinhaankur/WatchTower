/**
 * MenubarWidget zero (signed-out) state.
 *
 * The desktop app auto-auths with a LOCAL token, so /api/me returns a user even
 * when the person hasn't signed in to GitHub — the real signal is
 * is_github_authenticated. This asserts the widget shows a "Sign in" affordance
 * (not an account link) when that flag is false.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, cleanup, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

vi.mock('@/lib/api', () => {
  const data = (path: string) => {
    if (path.includes('/remote-access/providers'))
      return [{ id: 'tailscale', name: 'Tailscale', installed: false, ready: false, sharing: false, url: null, detail: null, hint: null, install_url: 'https://tailscale.com/download' }];
    if (path.includes('/remote-access/default-port')) return { port: 8000 };
    // Signed OUT of GitHub (local-token auth only).
    if (path.includes('/me'))
      return { user_id: '0', email: null, name: null, github_id: null, avatar_url: null, org_id: null, org_name: null, role: null, can_manage_team: false, can_manage_deployments: false, can_manage_nodes: false, can_create_projects: false, is_guest: false, is_github_authenticated: false, is_local_admin: true };
    if (path.includes('/this-pc/pairing-token')) return { token: 't', has_token: false, host: null, tailscale_ip: null, port: 8000, address: null };
    if (path.includes('/this-pc/discover-nodes')) return { source: 'none', peers: [] };
    if (path.includes('/podman/status')) return { available: false, binary: null, runtime: null, version: null, machine: null, connected: false, hint: null };
    if (path.includes('/runtime/version')) return { current: '2.2.1', latest: null, has_update: false, release_url: null, published_at: null, checked_at: '' };
    return [];
  };
  const get = vi.fn(async (path: string) => ({ data: data(path), headers: {} }));
  const apiClient = { get, post: vi.fn(), put: vi.fn(), delete: vi.fn(), interceptors: { request: { use: () => 0 }, response: { use: () => 0 } } };
  return { default: apiClient, apiClient, getLastRequestId: () => 'test' };
});

import MenubarWidget from '@/components/MenubarWidget';

afterEach(() => cleanup());

function mount() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <MenubarWidget onClose={() => {}} />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('MenubarWidget zero state (signed out)', () => {
  it('shows a Sign in row, not an account identity', async () => {
    mount();
    expect(await screen.findByText('Sign in')).toBeTruthy();
    expect(await screen.findByText(/Connect GitHub/)).toBeTruthy();
  });

  it('the Sign in row links to /login', async () => {
    mount();
    const link = (await screen.findByText('Sign in')).closest('a');
    expect(link?.getAttribute('href')).toBe('/login');
  });
});
