import { useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import apiClient from '@/lib/api';

type IntegrationStatus = {
  installed: boolean;
  version?: string | null;
  [key: string]: unknown;
};

type IntegrationsPayload = {
  podman: IntegrationStatus & { running_containers?: number };
  docker: IntegrationStatus & { daemon_available?: boolean; running_containers?: number };
  coolify: IntegrationStatus & { source?: string };
  tailscale: IntegrationStatus & { connected?: boolean; ip?: string | null };
  cloudflared: IntegrationStatus & { authenticated?: boolean; tunnels?: Array<{ id: string; name: string; status: string }> };
  nginx: IntegrationStatus & { running?: boolean; config_test_ok?: boolean };
};

type InstallCommandsPayload = {
  os: string;
  commands: Record<string, string[]>;
};

type DomainConnectResponse = {
  hostname: string;
  tunnel_name: string;
  target_host: string;
  commands: string[];
  notes: string[];
};

type DatabasePlanResponse = {
  provider: string;
  id: string;
  steps: string[];
  connection_example: string;
  env: Record<string, string>;
  notes: string[];
};

type NginxConfigResponse = {
  server_name: string;
  upstream_host: string;
  config: string;
  steps: string[];
};

type TerminalPolicyResponse = {
  enabled: boolean;
  encryption_required: boolean;
  audit_log: string;
  max_timeout_seconds: number;
  allowed_commands: Array<{
    command: string;
    allow_sudo: boolean;
    must_sudo: boolean;
  }>;
};

type TerminalExecutionResponse = {
  ok: boolean;
  command: string;
  args: string[];
  require_sudo: boolean;
  exit_code: number;
  stdout: string;
  stderr: string;
};

function StatusBadge({ ok, label }: { ok: boolean; label: string }) {
  return (
    <span
      className={`shrink-0 text-xs px-2 py-0.5 rounded-full border ${
        ok
          ? 'border-emerald-300 bg-emerald-50 text-emerald-700'
          : 'border-amber-300 bg-amber-50 text-amber-700'
      }`}
    >
      {label}
    </span>
  );
}

function CopyButton({
  copied,
  onClick,
  label = 'Copy',
}: {
  copied: boolean;
  onClick: () => void;
  label?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="shrink-0 rounded-md border border-slate-300 bg-white px-2.5 py-1 text-[11px] font-medium text-slate-700 hover:bg-slate-50"
    >
      {copied ? 'Copied' : label}
    </button>
  );
}

const TOOL_ORDER = [
  'podman',
  'docker',
  'coolify',
  'tailscale',
  'cloudflared',
  'nginx',
] as const;
type ToolName = typeof TOOL_ORDER[number];

const TOOL_LABELS: Record<ToolName, string> = {
  podman: 'Podman',
  docker: 'Docker',
  coolify: 'Coolify',
  tailscale: 'Tailscale',
  cloudflared: 'Cloudflared',
  nginx: 'Nginx',
};

const DATABASE_PROVIDERS = [
  { id: 'mongodb_atlas', label: 'MongoDB Atlas' },
  { id: 'aws_rds_postgres', label: 'AWS RDS PostgreSQL' },
  { id: 'oracle_freedb', label: 'Oracle FreeDB' },
  { id: 'supabase', label: 'Supabase' },
] as const;

const TABS = ['Tools', 'Domain', 'Database', 'Nginx', 'Terminal'] as const;
type Tab = typeof TABS[number];

const TAB_QUERY: Record<Tab, string> = {
  Tools: 'tools',
  Domain: 'domain',
  Database: 'database',
  Nginx: 'nginx',
  Terminal: 'terminal',
};

const QUERY_TAB = Object.fromEntries(
  Object.entries(TAB_QUERY).map(([tab, value]) => [value, tab as Tab]),
) as Record<string, Tab>;

const TAB_COPY: Record<Tab, { title: string; description: string }> = {
  Tools: {
    title: 'Prepare the host first',
    description: 'Check runtime dependencies and copy exact install commands before you connect services or deploy apps.',
  },
  Domain: {
    title: 'Expose an app safely',
    description: 'Generate a Cloudflare Tunnel plan for a host that sits behind NAT, firewalls, or a home connection.',
  },
  Database: {
    title: 'Provision app data next',
    description: 'Create a managed database checklist and environment variables without leaving the current flow.',
  },
  Nginx: {
    title: 'Front your app with a proxy',
    description: 'Generate a ready-to-paste Nginx config once your app is already running on the host.',
  },
  Terminal: {
    title: 'Verify the host safely',
    description: 'Run allow-listed commands to inspect the machine without handing out unrestricted shell access.',
  },
};

const HostConnect = () => {
  const [searchParams, setSearchParams] = useSearchParams();
  const [loading, setLoading] = useState(true);
  const [integrations, setIntegrations] = useState<IntegrationsPayload | null>(null);
  const [commands, setCommands] = useState<InstallCommandsPayload | null>(null);
  const [error, setError] = useState<string>('');
  const [activeTab, setActiveTab] = useState<Tab>('Tools');
  const [copiedKey, setCopiedKey] = useState('');

  const [domain, setDomain] = useState('example.com');
  const [subdomain, setSubdomain] = useState('app');
  const [targetHost, setTargetHost] = useState('localhost:3000');
  const [domainPlan, setDomainPlan] = useState<DomainConnectResponse | null>(null);
  const [domainLoading, setDomainLoading] = useState(false);

  const [provider, setProvider] = useState<string>('mongodb_atlas');
  const [appName, setAppName] = useState('watchtower-app');
  const [dbName, setDbName] = useState('appdb');
  const [dbUser, setDbUser] = useState('appuser');
  const [dbRegion, setDbRegion] = useState('us-east-1');
  const [dbPlanLoading, setDbPlanLoading] = useState(false);
  const [dbPlan, setDbPlan] = useState<DatabasePlanResponse | null>(null);

  const [nginxServerName, setNginxServerName] = useState('app.example.com');
  const [nginxUpstream, setNginxUpstream] = useState('127.0.0.1:3000');
  const [nginxPlanLoading, setNginxPlanLoading] = useState(false);
  const [nginxPlan, setNginxPlan] = useState<NginxConfigResponse | null>(null);
  const [terminalPolicy, setTerminalPolicy] = useState<TerminalPolicyResponse | null>(null);
  const [terminalCommand, setTerminalCommand] = useState('docker ps');
  const [terminalRequireSudo, setTerminalRequireSudo] = useState(false);
  const [terminalTimeout, setTerminalTimeout] = useState(20);
  const [terminalRunning, setTerminalRunning] = useState(false);
  const [terminalResult, setTerminalResult] = useState<TerminalExecutionResponse | null>(null);

  const loadAll = async () => {
    setLoading(true);
    setError('');
    try {
      const [statusResp, cmdResp, terminalPolicyResp] = await Promise.allSettled([
        apiClient.get('/runtime/integrations/status'),
        apiClient.get('/runtime/integrations/install-commands'),
        apiClient.get('/runtime/terminal/policy'),
      ]);

      const failedSections: string[] = [];

      if (statusResp.status === 'fulfilled') {
        setIntegrations(statusResp.value.data as IntegrationsPayload);
      } else {
        setIntegrations(null);
        failedSections.push('tool status');
      }

      if (cmdResp.status === 'fulfilled') {
        setCommands(cmdResp.value.data as InstallCommandsPayload);
      } else {
        setCommands(null);
        failedSections.push('install commands');
      }

      if (terminalPolicyResp.status === 'fulfilled') {
        setTerminalPolicy(terminalPolicyResp.value.data as TerminalPolicyResponse);
      } else {
        setTerminalPolicy(null);
        failedSections.push('terminal policy');
      }

      if (failedSections.length > 0) {
        setError(`Some Host Connect sections failed to load (${failedSections.join(', ')}). Check API connectivity and token.`);
      }
    } catch {
      setError('Failed to load Host Connect data. Check API connectivity and token.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadAll();
  }, []);

  useEffect(() => {
    const requestedTab = QUERY_TAB[searchParams.get('tab') || ''];
    if (requestedTab && requestedTab !== activeTab) {
      setActiveTab(requestedTab);
    }
  }, [activeTab, searchParams]);

  const readiness = useMemo(() => {
    if (!integrations) return 0;
    const checks = [
      integrations.podman?.installed,
      integrations.docker?.installed,
      integrations.coolify?.installed,
      integrations.tailscale?.installed,
      integrations.cloudflared?.installed,
      integrations.nginx?.installed,
    ].filter(Boolean).length;
    return checks;
  }, [integrations]);

  const missingTools = useMemo(
    () => TOOL_ORDER.filter((name) => !(integrations?.[name] as IntegrationStatus | undefined)?.installed),
    [integrations],
  );

  const recommendedTab: Tab = missingTools.length > 0 ? 'Tools' : 'Domain';

  const setTab = (tab: Tab) => {
    setActiveTab(tab);
    const next = new URLSearchParams(searchParams);
    next.set('tab', TAB_QUERY[tab]);
    setSearchParams(next, { replace: true });
  };

  const copyText = async (key: string, text: string) => {
    await navigator.clipboard.writeText(text).catch(() => {});
    setCopiedKey(key);
    window.setTimeout(() => setCopiedKey((current) => (current === key ? '' : current)), 1800);
  };

  const generateDatabasePlan = async () => {
    if (!appName.trim() || !dbName.trim() || !dbUser.trim()) {
      setTab('Database');
      setError('Enter app name, database name, and username before generating a database plan.');
      setDbPlan(null);
      return;
    }
    setDbPlanLoading(true);
    setError('');
    try {
      const resp = await apiClient.post('/runtime/integrations/database/plan', {
        provider,
        app_name: appName,
        db_name: dbName,
        username: dbUser,
        region: dbRegion,
      });
      setDbPlan(resp.data as DatabasePlanResponse);
    } catch {
      setError('Could not generate database setup plan.');
      setDbPlan(null);
    } finally {
      setDbPlanLoading(false);
    }
  };

  const generateNginxPlan = async () => {
    if (!nginxServerName.trim() || !nginxUpstream.trim()) {
      setTab('Nginx');
      setError('Enter both the server name and upstream host before generating an Nginx config.');
      setNginxPlan(null);
      return;
    }
    setNginxPlanLoading(true);
    setError('');
    try {
      const resp = await apiClient.post('/runtime/integrations/nginx/config', {
        server_name: nginxServerName,
        upstream_host: nginxUpstream,
      });
      setNginxPlan(resp.data as NginxConfigResponse);
    } catch {
      setError('Could not generate Nginx configuration plan.');
      setNginxPlan(null);
    } finally {
      setNginxPlanLoading(false);
    }
  };

  const generateDomainPlan = async () => {
    if (!domain.trim() || !subdomain.trim() || !targetHost.trim()) {
      setTab('Domain');
      setError('Enter a domain, subdomain, and target host before generating a Cloudflare plan.');
      setDomainPlan(null);
      return;
    }
    setDomainLoading(true);
    setError('');
    try {
      const resp = await apiClient.post('/runtime/integrations/domain/connect', {
        domain,
        subdomain,
        target_host: targetHost,
      });
      setDomainPlan(resp.data as DomainConnectResponse);
    } catch {
      setError('Could not generate Cloudflare domain plan. Check domain format and try again.');
      setDomainPlan(null);
    } finally {
      setDomainLoading(false);
    }
  };

  const runSecureTerminalCommand = async () => {
    const trimmedCommand = terminalCommand.trim();
    const allowedCommands = terminalPolicy?.allowed_commands || [];
    const commandName = trimmedCommand.split(/\s+/)[0] || '';

    if (!trimmedCommand) {
      setTab('Terminal');
      setError('Enter a command before running a secure terminal action.');
      return;
    }

    if (allowedCommands.length > 0 && !allowedCommands.some((entry) => entry.command === commandName)) {
      setTab('Terminal');
      setError(`Command must start with one of the allow-listed tools: ${allowedCommands.map((entry) => entry.command).join(', ')}.`);
      setTerminalResult(null);
      return;
    }

    if (terminalTimeout < 1 || terminalTimeout > (terminalPolicy?.max_timeout_seconds ?? 120)) {
      setTab('Terminal');
      setError(`Timeout must be between 1 and ${terminalPolicy?.max_timeout_seconds ?? 120} seconds.`);
      return;
    }

    setTerminalRunning(true);
    setTerminalResult(null);
    setError('');
    try {
      const resp = await apiClient.post('/runtime/terminal/execute', {
        command: terminalCommand,
        require_sudo: terminalRequireSudo,
        timeout_seconds: terminalTimeout,
      });
      setTerminalResult(resp.data as TerminalExecutionResponse);
    } catch {
      setError('Secure terminal command failed. Ensure command is allow-listed and encryption key is configured.');
    } finally {
      setTerminalRunning(false);
    }
  };

  return (
    <div className="flex-1 overflow-auto bg-slate-50">
      {/* Header */}
      <header
        className="px-4 sm:px-6 lg:px-8 py-4 flex items-center justify-between border-b sticky top-0 z-10 bg-white/95 backdrop-blur-sm"
        style={{ borderColor: 'hsl(var(--border-soft))' }}
      >
        <div>
          <h1 className="text-lg font-semibold text-slate-900">Host Connect</h1>
          <p className="text-xs text-slate-600 mt-0.5 hidden sm:block">
            Set up tools, domains, databases, and secure terminal access.
          </p>
        </div>
        <div className="flex items-center gap-2">
          {/* Readiness pill */}
          <span className={`hidden sm:inline-flex items-center gap-1.5 text-xs px-2.5 py-1 rounded-full border font-medium ${
            readiness >= 4
              ? 'bg-emerald-500/10 text-emerald-700 border-emerald-300'
              : readiness >= 2
                ? 'bg-amber-500/10 text-amber-700 border-amber-300'
                : 'bg-red-500/10 text-red-700 border-red-300'
          }`}>
            {readiness}/6 ready
          </span>
          <button
            onClick={() => void loadAll()}
            disabled={loading}
            className="px-3 py-1.5 rounded-lg border border-border text-xs text-slate-700 hover:bg-slate-100 disabled:opacity-50"
          >
            {loading ? 'Loading…' : 'Refresh'}
          </button>
        </div>
      </header>

      {/* Tab bar */}
      <div
        className="flex items-center gap-1 px-4 sm:px-6 lg:px-8 border-b overflow-x-auto"
        style={{ borderColor: 'hsl(var(--border-soft))', background: 'hsl(var(--sidebar))' }}
      >
        {TABS.map((tab) => (
          <button
            key={tab}
            onClick={() => setActiveTab(tab)}
            className={`px-4 py-2.5 text-sm font-medium whitespace-nowrap border-b-2 transition-colors ${
              activeTab === tab
                ? 'border-red-700 text-red-700'
                : 'border-transparent text-slate-600 hover:text-slate-900 hover:border-slate-300'
            }`}
          >
            {tab}
          </button>
        ))}
      </div>

      <main className="px-4 sm:px-6 lg:px-8 py-6 max-w-6xl mx-auto w-full">
        {error && (
          <div className="mb-4 rounded-lg border border-red-300 bg-red-50 text-red-700 px-4 py-3 text-sm">
            {error}
          </div>
        )}

        <section className="mb-6 rounded-2xl border border-border bg-gradient-to-br from-white to-amber-50 p-5">
          <div className="grid gap-4 lg:grid-cols-[1.6fr_1fr]">
            <div>
              <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-red-700">Guided Host Setup</p>
              <h2 className="mt-2 text-xl font-bold text-slate-900">{TAB_COPY[activeTab].title}</h2>
              <p className="mt-1.5 max-w-2xl text-sm text-slate-600">{TAB_COPY[activeTab].description}</p>
              <div className="mt-4 flex flex-wrap gap-2">
                {TABS.map((tab) => (
                  <button
                    key={tab}
                    type="button"
                    onClick={() => setTab(tab)}
                    className={`rounded-full border px-3 py-1.5 text-xs font-medium transition-colors ${
                      activeTab === tab
                        ? 'border-red-700 bg-red-700 text-white'
                        : 'border-slate-300 bg-white text-slate-700 hover:border-slate-400 hover:bg-slate-50'
                    }`}
                  >
                    {tab}
                  </button>
                ))}
              </div>
              <div className="mt-4 flex flex-wrap gap-2">
                <Link
                  to="/servers"
                  className="rounded-lg border border-slate-800 bg-white px-3 py-2 text-xs font-semibold text-slate-900 shadow-[2px_2px_0_0_#1f2937] hover:bg-amber-50"
                >
                  Open Servers
                </Link>
                <Link
                  to="/setup"
                  className="rounded-lg border border-slate-800 bg-red-700 px-3 py-2 text-xs font-semibold text-white shadow-[2px_2px_0_0_#1f2937] hover:bg-red-800"
                >
                  Deploy an App
                </Link>
              </div>
            </div>

            <div className="rounded-xl border border-amber-200 bg-white/80 p-4">
              <p className="text-xs font-semibold uppercase tracking-[0.14em] text-slate-500">Recommended Next Step</p>
              <p className="mt-2 text-sm font-semibold text-slate-900">
                {missingTools.length > 0
                  ? `Install ${TOOL_LABELS[missingTools[0]]} first`
                  : 'Your host is ready to connect apps'}
              </p>
              <p className="mt-1 text-xs text-slate-600">
                {missingTools.length > 0
                  ? `${missingTools.length} dependency${missingTools.length === 1 ? '' : 'ies'} still missing. Finish the tools tab, then connect a domain or deploy an app.`
                  : 'Move on to Domain, Nginx, or Deploy an App depending on how you want traffic to reach the host.'}
              </p>
              <button
                type="button"
                onClick={() => setTab(recommendedTab)}
                className="mt-3 rounded-lg border border-slate-800 bg-white px-3 py-2 text-xs font-semibold text-slate-900 shadow-[2px_2px_0_0_#1f2937] hover:bg-slate-50"
              >
                Open {recommendedTab}
              </button>
              {missingTools.length > 0 && (
                <div className="mt-3 flex flex-wrap gap-2">
                  {missingTools.map((name) => (
                    <span key={name} className="rounded-full border border-amber-300 bg-amber-50 px-2 py-1 text-[11px] font-medium text-amber-800">
                      {TOOL_LABELS[name]}
                    </span>
                  ))}
                </div>
              )}
            </div>
          </div>
        </section>

        {/* ── Tools tab ── */}
        {activeTab === 'Tools' && (
          <div className="space-y-6">
            {/* Readiness bar */}
            <section className="rounded-xl border border-border bg-card p-5">
              <div className="flex items-center justify-between mb-3">
                <div>
                  <h2 className="text-sm font-semibold text-slate-900">Setup Readiness</h2>
                  <p className="text-xs text-slate-600 mt-0.5">Install all tools below to unlock full WatchTower capabilities.</p>
                </div>
                <span className="text-xs text-slate-600 shrink-0">{readiness} / 6 tools</span>
              </div>
              <div className="h-2.5 rounded-full bg-slate-100 border border-slate-200 overflow-hidden">
                <div
                  className={`h-full transition-all rounded-full ${readiness >= 5 ? 'bg-emerald-500' : readiness >= 3 ? 'bg-amber-500' : 'bg-red-600'}`}
                  style={{ width: `${Math.round((readiness / 6) * 100)}%` }}
                />
              </div>
              {readiness === 0 && !loading && (
                <p className="text-xs text-slate-600 mt-2">
                  No tools detected. Use the <strong>Install Commands</strong> below to get started.
                </p>
              )}
              {missingTools.length > 0 && !loading && (
                <div className="mt-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900">
                  Missing now: {missingTools.map((tool) => TOOL_LABELS[tool]).join(', ')}.
                </div>
              )}
            </section>

            <div className="grid lg:grid-cols-2 gap-4">
              {/* Tool status */}
              <div className="rounded-xl border border-border bg-card p-5">
                <h2 className="text-sm font-semibold text-slate-900 mb-3">Tool Status</h2>
                {loading ? (
                  <p className="text-xs text-slate-500 py-4 text-center">Checking tools…</p>
                ) : (
                  <div className="space-y-2">
                    {TOOL_ORDER.map((name) => {
                      const row = integrations?.[name] as IntegrationStatus | undefined;
                      const installed = Boolean(row?.installed);
                      return (
                        <div key={name} className="rounded-lg border border-border bg-muted/30 px-3 py-2.5">
                          <div className="flex items-center justify-between gap-3">
                            <div className="min-w-0 flex-1">
                              <p className="text-sm font-medium text-slate-900 capitalize">{name}</p>
                              <p className="text-xs text-slate-600 truncate" title={row?.version ?? 'Not installed'}>{row?.version || 'Not installed'}</p>
                            </div>
                            <StatusBadge ok={installed} label={installed ? 'Installed' : 'Missing'} />
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>

              {/* Install commands */}
              <div className="rounded-xl border border-border bg-card p-5">
                <h2 className="text-sm font-semibold text-slate-900 mb-1">Install Commands</h2>
                <p className="text-xs text-slate-600 mb-3">Copy and run these commands on your Linux server to install each tool.</p>
                <div className="space-y-3 max-h-[420px] overflow-y-auto pr-1">
                  {TOOL_ORDER.map((name) => (
                    <div key={name} className="rounded-lg border border-border bg-muted/30 p-3">
                      <div className="mb-2 flex items-center justify-between gap-2">
                        <p className="text-xs font-semibold uppercase tracking-wider text-slate-700">{name}</p>
                        <CopyButton
                          copied={copiedKey === `install-${name}`}
                          onClick={() => void copyText(`install-${name}`, (commands?.commands?.[name] || ['No command recipe available.']).join('\n'))}
                        />
                      </div>
                      <pre className="text-xs text-slate-700 whitespace-pre-wrap break-words">
                        {(commands?.commands?.[name] || ['No command recipe available.']).join('\n')}
                      </pre>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </div>
        )}

        {/* ── Domain tab ── */}
        {activeTab === 'Domain' && (
          <div className="space-y-6">
            <section className="rounded-xl border border-border bg-card p-5 space-y-4">
              <div>
                <h2 className="text-sm font-semibold text-slate-900">Cloudflare Domain Connect</h2>
                <p className="text-xs text-slate-600 mt-1">
                  Generate copy-ready tunnel commands to expose your hosted apps with a custom domain via Cloudflare Tunnel.
                  No open ports required — works behind NAT and firewalls.
                </p>
              </div>

              <div className="grid sm:grid-cols-3 gap-3">
                <label className="text-xs text-slate-700">
                  Domain
                  <input
                    value={domain}
                    onChange={(e) => {
                      setDomain(e.target.value);
                      setDomainPlan(null);
                    }}
                    className="mt-1.5 w-full bg-white border border-border rounded-md px-3 py-2 text-slate-900"
                    placeholder="example.com"
                  />
                </label>
                <label className="text-xs text-slate-700">
                  Subdomain
                  <input
                    value={subdomain}
                    onChange={(e) => {
                      setSubdomain(e.target.value);
                      setDomainPlan(null);
                    }}
                    className="mt-1.5 w-full bg-white border border-border rounded-md px-3 py-2 text-slate-900"
                    placeholder="app"
                  />
                </label>
                <label className="text-xs text-slate-700">
                  Target Host
                  <input
                    value={targetHost}
                    onChange={(e) => {
                      setTargetHost(e.target.value);
                      setDomainPlan(null);
                    }}
                    className="mt-1.5 w-full bg-white border border-border rounded-md px-3 py-2 text-slate-900"
                    placeholder="localhost:3000"
                  />
                </label>
              </div>

              <button
                onClick={() => void generateDomainPlan()}
                disabled={domainLoading}
                className="px-4 py-2 rounded-lg bg-red-700 hover:bg-red-800 text-white text-sm disabled:opacity-50 border border-slate-800 shadow-[2px_2px_0_0_#1f2937]"
              >
                {domainLoading ? 'Generating…' : 'Generate Cloudflare Plan'}
              </button>

              {domainPlan && (
                <div className="rounded-lg border border-border bg-muted/30 p-4 space-y-3">
                  <div>
                    <p className="text-xs text-slate-600">Hostname</p>
                    <p className="text-sm text-slate-900 font-medium">{domainPlan.hostname}</p>
                  </div>
                  <div>
                    <div className="mb-1 flex items-center justify-between gap-2">
                      <p className="text-xs text-slate-600">Commands</p>
                      <CopyButton
                        copied={copiedKey === 'domain-commands'}
                        onClick={() => void copyText('domain-commands', domainPlan.commands.join('\n'))}
                      />
                    </div>
                    <pre className="text-xs text-slate-800 whitespace-pre-wrap break-words">
                      {domainPlan.commands.join('\n')}
                    </pre>
                  </div>
                  <div>
                    <p className="text-xs text-slate-600 mb-1">Notes</p>
                    <ul className="text-xs text-slate-700 list-disc pl-4 space-y-1">
                      {domainPlan.notes.map((note) => (
                        <li key={note}>{note}</li>
                      ))}
                    </ul>
                  </div>
                </div>
              )}
            </section>
          </div>
        )}

        {/* ── Database tab ── */}
        {activeTab === 'Database' && (
          <div className="space-y-6">
            <section className="rounded-xl border border-border bg-card p-5 space-y-4">
              <div>
                <h2 className="text-sm font-semibold text-slate-900">Managed Database Setup</h2>
                <p className="text-xs text-slate-600 mt-1">
                  Generate step-by-step setup guides and environment variables for cloud databases.
                  Supports MongoDB Atlas, AWS RDS, Oracle FreeDB, and Supabase.
                </p>
              </div>

              <div className="grid sm:grid-cols-2 gap-3">
                <label className="text-xs text-slate-700">
                  Provider
                  <select
                    value={provider}
                    onChange={(e) => {
                      setProvider(e.target.value);
                      setDbPlan(null);
                    }}
                    className="mt-1.5 w-full bg-white border border-border rounded-md px-3 py-2 text-slate-900"
                  >
                    {DATABASE_PROVIDERS.map((p) => (
                      <option key={p.id} value={p.id}>{p.label}</option>
                    ))}
                  </select>
                </label>
                <label className="text-xs text-slate-700">
                  App Name
                  <input
                    value={appName}
                    onChange={(e) => {
                      setAppName(e.target.value);
                      setDbPlan(null);
                    }}
                    className="mt-1.5 w-full bg-white border border-border rounded-md px-3 py-2 text-slate-900"
                  />
                </label>
                <label className="text-xs text-slate-700">
                  DB Name
                  <input
                    value={dbName}
                    onChange={(e) => {
                      setDbName(e.target.value);
                      setDbPlan(null);
                    }}
                    className="mt-1.5 w-full bg-white border border-border rounded-md px-3 py-2 text-slate-900"
                  />
                </label>
                <label className="text-xs text-slate-700">
                  Username
                  <input
                    value={dbUser}
                    onChange={(e) => {
                      setDbUser(e.target.value);
                      setDbPlan(null);
                    }}
                    className="mt-1.5 w-full bg-white border border-border rounded-md px-3 py-2 text-slate-900"
                  />
                </label>
                <label className="text-xs text-slate-700 sm:col-span-2">
                  Region (for AWS RDS plans)
                  <input
                    value={dbRegion}
                    onChange={(e) => {
                      setDbRegion(e.target.value);
                      setDbPlan(null);
                    }}
                    className="mt-1.5 w-full bg-white border border-border rounded-md px-3 py-2 text-slate-900"
                  />
                </label>
              </div>

              <button
                onClick={() => void generateDatabasePlan()}
                disabled={dbPlanLoading}
                className="px-4 py-2 rounded-lg bg-red-700 hover:bg-red-800 text-white text-sm disabled:opacity-50 border border-slate-800 shadow-[2px_2px_0_0_#1f2937]"
              >
                {dbPlanLoading ? 'Generating…' : 'Generate Database Plan'}
              </button>

              {dbPlan && (
                <div className="rounded-lg border border-border bg-muted/30 p-4 space-y-3">
                  <p className="text-sm font-semibold text-slate-900">{dbPlan.provider}</p>
                  <div>
                    <p className="text-xs text-slate-600 mb-1">Steps</p>
                    <ol className="text-xs text-slate-700 list-decimal pl-4 space-y-1">
                      {dbPlan.steps.map((step) => (
                        <li key={step}>{step}</li>
                      ))}
                    </ol>
                  </div>
                  <div>
                    <p className="text-xs text-slate-600 mb-1">Connection Example</p>
                    <div className="mb-1 flex items-center justify-end">
                      <CopyButton
                        copied={copiedKey === 'db-connection'}
                        onClick={() => void copyText('db-connection', dbPlan.connection_example)}
                      />
                    </div>
                    <pre className="text-xs text-slate-800 whitespace-pre-wrap break-words">
                      {dbPlan.connection_example}
                    </pre>
                  </div>
                  <div>
                    <div className="mb-1 flex items-center justify-between gap-2">
                      <p className="text-xs text-slate-600">Env Variables</p>
                      <CopyButton
                        copied={copiedKey === 'db-env'}
                        onClick={() => void copyText(
                          'db-env',
                          Object.entries(dbPlan.env)
                            .map(([k, v]) => `${k}=${v}`)
                            .join('\n'),
                        )}
                      />
                    </div>
                    <pre className="text-xs text-slate-800 whitespace-pre-wrap break-words">
                      {Object.entries(dbPlan.env)
                        .map(([k, v]) => `${k}=${v}`)
                        .join('\n')}
                    </pre>
                  </div>
                </div>
              )}
            </section>
          </div>
        )}

        {/* ── Nginx tab ── */}
        {activeTab === 'Nginx' && (
          <div className="space-y-6">
            <section className="rounded-xl border border-border bg-card p-5 space-y-4">
              <div>
                <h2 className="text-sm font-semibold text-slate-900">Nginx Reverse Proxy Setup</h2>
                <p className="text-xs text-slate-600 mt-1">
                  Generate a production-ready Nginx config that proxies traffic from your domain to your app.
                  Includes SSL, compression, and security headers.
                </p>
              </div>

              <div className="grid sm:grid-cols-2 gap-3">
                <label className="text-xs text-slate-700">
                  Server Name (domain)
                  <input
                    value={nginxServerName}
                    onChange={(e) => {
                      setNginxServerName(e.target.value);
                      setNginxPlan(null);
                    }}
                    className="mt-1.5 w-full bg-white border border-border rounded-md px-3 py-2 text-slate-900"
                    placeholder="app.example.com"
                  />
                </label>
                <label className="text-xs text-slate-700">
                  Upstream Host (where your app runs)
                  <input
                    value={nginxUpstream}
                    onChange={(e) => {
                      setNginxUpstream(e.target.value);
                      setNginxPlan(null);
                    }}
                    className="mt-1.5 w-full bg-white border border-border rounded-md px-3 py-2 text-slate-900"
                    placeholder="127.0.0.1:3000"
                  />
                </label>
              </div>

              <button
                onClick={() => void generateNginxPlan()}
                disabled={nginxPlanLoading}
                className="px-4 py-2 rounded-lg bg-red-700 hover:bg-red-800 text-white text-sm disabled:opacity-50 border border-slate-800 shadow-[2px_2px_0_0_#1f2937]"
              >
                {nginxPlanLoading ? 'Generating…' : 'Generate Nginx Config'}
              </button>

              {nginxPlan && (
                <div className="rounded-lg border border-border bg-muted/30 p-4 space-y-3">
                  <div>
                    <div className="mb-1 flex items-center justify-between gap-2">
                      <p className="text-xs text-slate-600">Config file — copy to <code className="font-mono bg-slate-100 px-1 rounded">/etc/nginx/sites-available/{nginxServerName}</code></p>
                      <CopyButton
                        copied={copiedKey === 'nginx-config'}
                        onClick={() => void copyText('nginx-config', nginxPlan.config)}
                      />
                    </div>
                    <pre className="text-xs text-slate-800 whitespace-pre-wrap break-words max-h-72 overflow-y-auto">
                      {nginxPlan.config}
                    </pre>
                  </div>
                  <div>
                    <p className="text-xs text-slate-600 mb-1">Steps to apply</p>
                    <ol className="text-xs text-slate-700 list-decimal pl-4 space-y-1">
                      {nginxPlan.steps.map((s) => (
                        <li key={s}>{s}</li>
                      ))}
                    </ol>
                  </div>
                </div>
              )}
            </section>
          </div>
        )}

        {/* ── Terminal tab ── */}
        {activeTab === 'Terminal' && (
          <div className="space-y-6">
            <section className="rounded-xl border border-border bg-card p-5 space-y-4">
              <div>
                <h2 className="text-sm font-semibold text-slate-900">Secure Terminal</h2>
                <p className="text-xs text-slate-600 mt-1">
                  Run allow-listed commands on your WatchTower host with encrypted audit logging.
                  This is safer than raw shell access — only pre-approved commands can execute.
                </p>
              </div>

              <div className="rounded-lg border border-border bg-muted/30 p-3 grid sm:grid-cols-3 gap-3 text-xs text-slate-700">
                <div>
                  <p className="text-slate-500 mb-0.5">Encryption</p>
                  <p className="font-medium">{terminalPolicy?.enabled ? (terminalPolicy.encryption_required ? 'Required' : 'Enabled') : 'Disabled'}</p>
                </div>
                <div>
                  <p className="text-slate-500 mb-0.5">Audit log</p>
                  <code className="font-mono text-[11px] break-all">{terminalPolicy?.audit_log || '.dev/terminal-audit.log.enc'}</code>
                </div>
                <div>
                  <p className="text-slate-500 mb-0.5">Max timeout</p>
                  <p className="font-medium">{terminalPolicy?.max_timeout_seconds ?? 120}s</p>
                </div>
              </div>

              <div className="rounded-lg border border-border bg-muted/30 p-3">
                <p className="text-xs font-semibold text-slate-700 mb-2">Allowed Commands</p>
                <div className="flex flex-wrap gap-2">
                  {(terminalPolicy?.allowed_commands || []).map((c) => (
                    <span
                      key={c.command}
                      className="text-[11px] px-2 py-0.5 rounded-full border border-slate-300 bg-white text-slate-700"
                    >
                      {c.command}{c.must_sudo ? ' (sudo required)' : c.allow_sudo ? ' (sudo optional)' : ''}
                    </span>
                  ))}
                  {(!terminalPolicy?.allowed_commands || terminalPolicy.allowed_commands.length === 0) && (
                    <span className="text-xs text-slate-500 italic">Loading policy…</span>
                  )}
                </div>
              </div>

              <div className="grid sm:grid-cols-4 gap-3">
                <label className="text-xs text-slate-700 sm:col-span-2">
                  Command
                  <input
                    value={terminalCommand}
                    onChange={(e) => {
                      setTerminalCommand(e.target.value);
                      setTerminalResult(null);
                    }}
                    className="mt-1.5 w-full bg-white border border-border rounded-md px-3 py-2 text-slate-900"
                    placeholder="docker ps"
                  />
                </label>
                <label className="text-xs text-slate-700">
                  Timeout (seconds)
                  <input
                    type="number"
                    min={1}
                    max={terminalPolicy?.max_timeout_seconds ?? 120}
                    value={terminalTimeout}
                    onChange={(e) => {
                      setTerminalTimeout(Number(e.target.value || 20));
                      setTerminalResult(null);
                    }}
                    className="mt-1.5 w-full bg-white border border-border rounded-md px-3 py-2 text-slate-900"
                  />
                </label>
                <label className="text-xs text-slate-700 flex items-end">
                  <span className="inline-flex items-center gap-2 mb-2">
                    <input
                      type="checkbox"
                      checked={terminalRequireSudo}
                      onChange={(e) => {
                        setTerminalRequireSudo(e.target.checked);
                        setTerminalResult(null);
                      }}
                      className="accent-red-700"
                    />
                    Require sudo
                  </span>
                </label>
              </div>

              <button
                onClick={() => void runSecureTerminalCommand()}
                disabled={terminalRunning || !terminalPolicy?.enabled}
                className="px-4 py-2 rounded-lg bg-red-700 hover:bg-red-800 text-white text-sm disabled:opacity-50 border border-slate-800 shadow-[2px_2px_0_0_#1f2937]"
              >
                {terminalRunning ? 'Running…' : terminalPolicy?.enabled ? 'Run Command' : 'Terminal Disabled'}
              </button>

              {terminalResult && (
                <div className="rounded-lg border border-border bg-muted/30 p-4 space-y-3">
                  <p className={`text-xs font-medium ${terminalResult.ok ? 'text-emerald-700' : 'text-red-600'}`}>
                    {terminalResult.ok ? '✓ Success' : '✗ Failed'} · Exit code {terminalResult.exit_code}
                  </p>
                  {terminalResult.stdout && (
                    <div>
                      <div className="mb-1 flex items-center justify-between gap-2">
                        <p className="text-xs text-slate-600">Output</p>
                        <CopyButton
                          copied={copiedKey === 'terminal-stdout'}
                          onClick={() => void copyText('terminal-stdout', terminalResult.stdout)}
                        />
                      </div>
                      <pre className="text-xs text-slate-800 whitespace-pre-wrap break-words max-h-48 overflow-y-auto">
                        {terminalResult.stdout}
                      </pre>
                    </div>
                  )}
                  {terminalResult.stderr && (
                    <div>
                      <div className="mb-1 flex items-center justify-between gap-2">
                        <p className="text-xs text-slate-600">Errors</p>
                        <CopyButton
                          copied={copiedKey === 'terminal-stderr'}
                          onClick={() => void copyText('terminal-stderr', terminalResult.stderr)}
                        />
                      </div>
                      <pre className="text-xs text-red-700 whitespace-pre-wrap break-words max-h-32 overflow-y-auto">
                        {terminalResult.stderr}
                      </pre>
                    </div>
                  )}
                </div>
              )}
            </section>
          </div>
        )}
      </main>
    </div>
  );
};

export default HostConnect;
