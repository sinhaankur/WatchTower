/**
 * MenubarWidget smoke test.
 *
 * The page-render smoke test mounts pages, not the app chrome, so the
 * Tailscale-style status menu (MenubarWidget + TopBarStatus) wouldn't be
 * covered otherwise. This asserts the widget renders its core structure
 * without throwing against benign API data, and that it names the DETECTED
 * container runtime rather than hardcoding "Podman" (the runtime-agnostic
 * contract — WatchTower runs on Podman OR Docker).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, cleanup, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

// Shape each endpoint the widget touches. Simulate Docker (not Podman) as the
// active runtime to prove the label is derived from `binary`, not assumed.
vi.mock('@/lib/api', () => {
  const data = (path: string) => {
    if (path.includes('/remote-access/providers'))
      return [{ id: 'tailscale', name: 'Tailscale', installed: true, ready: true, sharing: true, url: 'https://box.tailnet.ts.net', detail: null, hint: null, install_url: null }];
    if (path.includes('/remote-access/default-port')) return { port: 8000 };
    if (path.includes('/me'))
      return { user_id: '0', email: 'you@github', name: 'You', github_id: '1', avatar_url: null, org_id: 'o', org_name: 'My Org', role: 'owner', can_manage_team: true, can_manage_deployments: true, can_manage_nodes: true, can_create_projects: true, is_guest: false, is_github_authenticated: true, is_local_admin: true };
    if (path.includes('/this-pc/pairing-token'))
      return { token: 't', has_token: true, host: 'my-mac', tailscale_ip: '100.91.27.70', port: 8000, address: '100.91.27.70:8000' };
    if (path.includes('/this-pc/discover-nodes')) return { source: 'tailscale', peers: [{ hostname: 'a', dns_name: null, ip: '100.0.0.2', online: true, os: 'linux', runs_watchtower: true, reachable: true, watchtower_version: '2.1.3', watchtower_url: 'http://100.0.0.2:8000' }] };
    if (path.includes('/podman/status')) return { available: true, binary: '/usr/local/bin/docker', version: '27.0', machine: null, connected: true, hint: null };
    if (path.includes('/runtime/version')) return { current: '2.1.3', latest: null, has_update: false, release_url: null, published_at: null, checked_at: '' };
    return [];
  };
  const get = vi.fn(async (path: string) => ({ data: data(path), headers: { 'x-request-id': 'test' } }));
  const post = vi.fn(async () => ({ data: {}, headers: {} }));
  const apiClient = { get, post, put: vi.fn(), delete: vi.fn(), interceptors: { request: { use: () => 0 }, response: { use: () => 0 } } };
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

describe('MenubarWidget', () => {
  it('renders the hero, identity and dependency structure', async () => {
    mount();
    // Hero + connected state
    expect(await screen.findByText('WatchTower')).toBeTruthy();
    expect(await screen.findByText('Connected')).toBeTruthy();
    // Identity
    expect(await screen.findByText('You')).toBeTruthy();
    // This device shows the friendly device NAME (from the tailnet URL
    // https://box.tailnet.ts.net → "box"), not the raw IP. Scope to the
    // "This device" row so we don't match the sharing URL in the hero.
    const deviceRow = (await screen.findByText(/This device/)).closest('p')!;
    expect(deviceRow.textContent).toContain('box');
    expect(deviceRow.textContent).not.toContain('100.91.27.70');
    // Dependency rows exist
    expect(await screen.findByText('Tailscale')).toBeTruthy();
    expect(await screen.findByText('Container runtime')).toBeTruthy();
  });

  it('names the detected runtime (Docker), not a hardcoded Podman', async () => {
    mount();
    expect(await screen.findByText(/Docker/)).toBeTruthy();
    expect(screen.queryByText(/Podman/)).toBeNull();
  });

  it('exposes the remote-access toggle in the on state', async () => {
    mount();
    const toggle = await screen.findByRole('switch');
    // The on-state is data-driven (sharing === true from the mock) — wait for it.
    await waitFor(() => expect(toggle.getAttribute('aria-checked')).toBe('true'));
  });
});
