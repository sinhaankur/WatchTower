import { useEffect, useMemo, useState } from 'react';
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
      className={`text-xs px-2 py-0.5 rounded-full border ${
        ok
          ? 'border-emerald-300 bg-emerald-50 text-emerald-700'
          : 'border-amber-300 bg-amber-50 text-amber-700'
      }`}
    >
      {label}
    </span>
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

const DATABASE_PROVIDERS = [
  { id: 'mongodb_atlas', label: 'MongoDB Atlas' },
  { id: 'aws_rds_postgres', label: 'AWS RDS PostgreSQL' },
  { id: 'oracle_freedb', label: 'Oracle FreeDB' },
  { id: 'supabase', label: 'Supabase' },
] as const;

const HostConnect = () => {
  const [loading, setLoading] = useState(true);
  const [integrations, setIntegrations] = useState<IntegrationsPayload | null>(null);
  const [commands, setCommands] = useState<InstallCommandsPayload | null>(null);
  const [error, setError] = useState<string>('');

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
      const [statusResp, cmdResp] = await Promise.all([
        apiClient.get('/runtime/integrations/status'),
        apiClient.get('/runtime/integrations/install-commands'),
      ]);
      setIntegrations(statusResp.data as IntegrationsPayload);
      setCommands(cmdResp.data as InstallCommandsPayload);
      const terminalPolicyResp = await apiClient.get('/runtime/terminal/policy');
      setTerminalPolicy(terminalPolicyResp.data as TerminalPolicyResponse);
    } catch {
      setError('Failed to load integration status. Check API connectivity and token.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadAll();
  }, []);

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

  const generateDatabasePlan = async () => {
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
    if (!terminalCommand.trim()) return;
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
      <header
        className="px-8 py-5 flex items-center justify-between border-b"
        style={{ borderColor: 'hsl(214 32% 88%)' }}
      >
        <div>
          <h1 className="text-lg font-semibold text-slate-900">Host Connect</h1>
          <p className="text-xs text-slate-600 mt-0.5">
            Team onboarding for Podman, Docker, Coolify, Tailscale, and Cloudflare.
          </p>
        </div>
        <button
          onClick={() => void loadAll()}
          disabled={loading}
          className="px-3 py-1.5 rounded-lg border border-border text-xs text-slate-700 hover:bg-slate-100 disabled:opacity-50"
        >
          {loading ? 'Refreshing...' : 'Refresh'}
        </button>
      </header>

      <main className="px-8 py-6 max-w-6xl space-y-6">
        {error && (
          <div className="rounded-lg border border-red-300 bg-red-50 text-red-700 px-4 py-3 text-sm">
            {error}
          </div>
        )}

        <section className="rounded-xl border border-border bg-card p-5">
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-sm font-semibold text-slate-900">Readiness Overview</h2>
            <span className="text-xs text-slate-600">{readiness} / 6 tools installed</span>
          </div>
          <div className="h-2 rounded-full bg-muted overflow-hidden">
            <div
              className="h-full bg-red-700 transition-all"
              style={{ width: `${(readiness / 5) * 100}%` }}
            />
          </div>
        </section>

        <section className="grid lg:grid-cols-2 gap-4">
          <div className="rounded-xl border border-border bg-card p-5">
            <h2 className="text-sm font-semibold text-slate-900 mb-3">Tool Status</h2>
            <div className="space-y-2">
              {TOOL_ORDER.map((name) => {
                const row = integrations?.[name] as IntegrationStatus | undefined;
                const installed = Boolean(row?.installed);
                return (
                  <div key={name} className="rounded-lg border border-border bg-muted/30 px-3 py-2.5">
                    <div className="flex items-center justify-between gap-3">
                      <div>
                        <p className="text-sm font-medium text-slate-900 capitalize">{name}</p>
                        <p className="text-xs text-slate-600 truncate">{row?.version || 'Not installed'}</p>
                      </div>
                      <StatusBadge ok={installed} label={installed ? 'Installed' : 'Missing'} />
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          <div className="rounded-xl border border-border bg-card p-5">
            <h2 className="text-sm font-semibold text-slate-900 mb-3">Install Commands (Linux)</h2>
            <div className="space-y-3 max-h-[420px] overflow-auto pr-1">
              {TOOL_ORDER.map((name) => (
                <div key={name} className="rounded-lg border border-border bg-muted/30 p-3">
                  <p className="text-xs font-semibold text-slate-700 uppercase tracking-wider mb-2">{name}</p>
                  <pre className="text-xs text-slate-700 whitespace-pre-wrap break-words">
                    {(commands?.commands?.[name] || ['No command recipe available.']).join('\n')}
                  </pre>
                </div>
              ))}
            </div>
          </div>
        </section>

        <section className="rounded-xl border border-border bg-card p-5 space-y-4">
          <div>
            <h2 className="text-sm font-semibold text-slate-900">Cloudflare Domain Connect</h2>
            <p className="text-xs text-slate-600 mt-1">
              Generate copy-ready tunnel commands so each team device can expose hosted apps with custom domains.
            </p>
          </div>

          <div className="grid md:grid-cols-3 gap-3">
            <label className="text-xs text-slate-700">
              Domain
              <input
                value={domain}
                onChange={(e) => setDomain(e.target.value)}
                className="mt-1.5 w-full bg-white border border-border rounded-md px-3 py-2 text-slate-900"
                placeholder="example.com"
              />
            </label>
            <label className="text-xs text-slate-700">
              Subdomain
              <input
                value={subdomain}
                onChange={(e) => setSubdomain(e.target.value)}
                className="mt-1.5 w-full bg-white border border-border rounded-md px-3 py-2 text-slate-900"
                placeholder="app"
              />
            </label>
            <label className="text-xs text-slate-700">
              Target Host
              <input
                value={targetHost}
                onChange={(e) => setTargetHost(e.target.value)}
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
            {domainLoading ? 'Generating...' : 'Generate Cloudflare Plan'}
          </button>

          {domainPlan && (
            <div className="rounded-lg border border-border bg-muted/30 p-4 space-y-3">
              <div>
                <p className="text-xs text-slate-600">Hostname</p>
                <p className="text-sm text-slate-900 font-medium">{domainPlan.hostname}</p>
              </div>
              <div>
                <p className="text-xs text-slate-600 mb-1">Commands</p>
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

        <section className="grid lg:grid-cols-2 gap-4">
          <div className="rounded-xl border border-border bg-card p-5 space-y-4">
            <div>
              <h2 className="text-sm font-semibold text-slate-900">Managed Database Setup</h2>
              <p className="text-xs text-slate-600 mt-1">
                Generate setup guides for MongoDB Atlas, AWS RDS, Oracle FreeDB,
                and Supabase.
              </p>
            </div>

            <div className="grid md:grid-cols-2 gap-3">
              <label className="text-xs text-slate-700">
                Provider
                <select
                  value={provider}
                  onChange={(e) => setProvider(e.target.value)}
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
                  onChange={(e) => setAppName(e.target.value)}
                  className="mt-1.5 w-full bg-white border border-border rounded-md px-3 py-2 text-slate-900"
                />
              </label>
              <label className="text-xs text-slate-700">
                DB Name
                <input
                  value={dbName}
                  onChange={(e) => setDbName(e.target.value)}
                  className="mt-1.5 w-full bg-white border border-border rounded-md px-3 py-2 text-slate-900"
                />
              </label>
              <label className="text-xs text-slate-700">
                Username
                <input
                  value={dbUser}
                  onChange={(e) => setDbUser(e.target.value)}
                  className="mt-1.5 w-full bg-white border border-border rounded-md px-3 py-2 text-slate-900"
                />
              </label>
              <label className="text-xs text-slate-700 md:col-span-2">
                Region (for AWS plans)
                <input
                  value={dbRegion}
                  onChange={(e) => setDbRegion(e.target.value)}
                  className="mt-1.5 w-full bg-white border border-border rounded-md px-3 py-2 text-slate-900"
                />
              </label>
            </div>

            <button
              onClick={() => void generateDatabasePlan()}
              disabled={dbPlanLoading}
              className="px-4 py-2 rounded-lg bg-red-700 hover:bg-red-800 text-white text-sm disabled:opacity-50 border border-slate-800 shadow-[2px_2px_0_0_#1f2937]"
            >
              {dbPlanLoading ? 'Generating...' : 'Generate Database Plan'}
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
                  <pre className="text-xs text-slate-800 whitespace-pre-wrap break-words">
                    {dbPlan.connection_example}
                  </pre>
                </div>
                <div>
                  <p className="text-xs text-slate-600 mb-1">Env Variables</p>
                  <pre className="text-xs text-slate-800 whitespace-pre-wrap break-words">
                    {Object.entries(dbPlan.env)
                      .map(([k, v]) => `${k}=${v}`)
                      .join('\n')}
                  </pre>
                </div>
              </div>
            )}
          </div>

          <div className="rounded-xl border border-border bg-card p-5 space-y-4">
            <div>
              <h2 className="text-sm font-semibold text-slate-900">Nginx Setup (Essential)</h2>
              <p className="text-xs text-slate-600 mt-1">
                Generate reverse-proxy config for your app and domain.
              </p>
            </div>

            <div className="grid md:grid-cols-2 gap-3">
              <label className="text-xs text-slate-700">
                Server Name
                <input
                  value={nginxServerName}
                  onChange={(e) => setNginxServerName(e.target.value)}
                  className="mt-1.5 w-full bg-white border border-border rounded-md px-3 py-2 text-slate-900"
                />
              </label>
              <label className="text-xs text-slate-700">
                Upstream Host
                <input
                  value={nginxUpstream}
                  onChange={(e) => setNginxUpstream(e.target.value)}
                  className="mt-1.5 w-full bg-white border border-border rounded-md px-3 py-2 text-slate-900"
                />
              </label>
            </div>

            <button
              onClick={() => void generateNginxPlan()}
              disabled={nginxPlanLoading}
              className="px-4 py-2 rounded-lg bg-red-700 hover:bg-red-800 text-white text-sm disabled:opacity-50 border border-slate-800 shadow-[2px_2px_0_0_#1f2937]"
            >
              {nginxPlanLoading ? 'Generating...' : 'Generate Nginx Config'}
            </button>

            {nginxPlan && (
              <div className="rounded-lg border border-border bg-muted/30 p-4 space-y-3">
                <div>
                  <p className="text-xs text-slate-600 mb-1">Config</p>
                  <pre className="text-xs text-slate-800 whitespace-pre-wrap break-words">
                    {nginxPlan.config}
                  </pre>
                </div>
                <div>
                  <p className="text-xs text-slate-600 mb-1">Steps</p>
                  <ol className="text-xs text-slate-700 list-decimal pl-4 space-y-1">
                    {nginxPlan.steps.map((s) => (
                      <li key={s}>{s}</li>
                    ))}
                  </ol>
                </div>
              </div>
            )}
          </div>
        </section>

        <section className="rounded-xl border border-border bg-card p-5 space-y-4">
          <div>
            <h2 className="text-sm font-semibold text-slate-900">Secure Terminal Command Runner</h2>
            <p className="text-xs text-slate-600 mt-1">
              Commands run through a locked allow-list with encrypted audit logging.
              Use this instead of raw shell access for safer operations.
            </p>
          </div>

          <div className="rounded-lg border border-border bg-muted/30 p-3 text-xs text-slate-700 space-y-1">
            <p>
              Encryption: <strong>{terminalPolicy?.enabled ? 'Enabled' : 'Disabled'}</strong>
              {' '}({terminalPolicy?.encryption_required ? 'required' : 'optional'})
            </p>
            <p>Audit log: <code>{terminalPolicy?.audit_log || '.dev/terminal-audit.log.enc'}</code></p>
            <p>Max timeout: {terminalPolicy?.max_timeout_seconds ?? 120}s</p>
          </div>

          <div className="grid md:grid-cols-4 gap-3">
            <label className="text-xs text-slate-700 md:col-span-2">
              Command
              <input
                value={terminalCommand}
                onChange={(e) => setTerminalCommand(e.target.value)}
                className="mt-1.5 w-full bg-white border border-border rounded-md px-3 py-2 text-slate-900"
                placeholder="docker ps"
              />
            </label>
            <label className="text-xs text-slate-700">
              Timeout (s)
              <input
                type="number"
                min={1}
                max={terminalPolicy?.max_timeout_seconds ?? 120}
                value={terminalTimeout}
                onChange={(e) => setTerminalTimeout(Number(e.target.value || 20))}
                className="mt-1.5 w-full bg-white border border-border rounded-md px-3 py-2 text-slate-900"
              />
            </label>
            <label className="text-xs text-slate-700 flex items-end">
              <span className="inline-flex items-center gap-2 mb-2">
                <input
                  type="checkbox"
                  checked={terminalRequireSudo}
                  onChange={(e) => setTerminalRequireSudo(e.target.checked)}
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
            {terminalRunning ? 'Running...' : 'Run Secure Command'}
          </button>

          <div className="rounded-lg border border-border bg-muted/30 p-4 space-y-2">
            <p className="text-xs font-semibold text-slate-700">Allowed Commands</p>
            <div className="flex flex-wrap gap-2">
              {(terminalPolicy?.allowed_commands || []).map((c) => (
                <span
                  key={c.command}
                  className="text-[11px] px-2 py-0.5 rounded-full border border-slate-300 bg-white text-slate-700"
                >
                  {c.command}{c.must_sudo ? ' (sudo required)' : c.allow_sudo ? ' (sudo optional)' : ''}
                </span>
              ))}
            </div>
          </div>

          {terminalResult && (
            <div className="rounded-lg border border-border bg-muted/30 p-4 space-y-2">
              <p className="text-xs text-slate-700">
                Exit code: <strong>{terminalResult.exit_code}</strong> · Status:{' '}
                <strong>{terminalResult.ok ? 'Success' : 'Failed'}</strong>
              </p>
              <div>
                <p className="text-xs text-slate-600 mb-1">STDOUT</p>
                <pre className="text-xs text-slate-800 whitespace-pre-wrap break-words">
                  {terminalResult.stdout || '(empty)'}
                </pre>
              </div>
              <div>
                <p className="text-xs text-slate-600 mb-1">STDERR</p>
                <pre className="text-xs text-slate-800 whitespace-pre-wrap break-words">
                  {terminalResult.stderr || '(empty)'}
                </pre>
              </div>
            </div>
          )}
        </section>
      </main>
    </div>
  );
};

export default HostConnect;
