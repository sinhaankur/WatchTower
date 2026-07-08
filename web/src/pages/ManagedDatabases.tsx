/**
 * ManagedDatabases — WatchTower creates Postgres pods in Podman on this host.
 *
 * Fits the "PC → website server + database + backup" vision: the user picks
 * "+ New Database", picks an engine + version, and WatchTower spins up a
 * named, persistent Postgres pod that other apps on the same machine
 * (or, with Tailscale Remote Access enabled, across the tailnet) can connect to.
 *
 * v0 is single-node, postgres-only. The page is structured so multi-engine
 * and external-DB-connection tabs slot in without restructuring.
 */

import { useEffect, useState } from 'react';
import {
  BackupDiagram,
  ExternalDbDiagram,
  ManagedDbDiagram,
  ReplicationDiagram,
} from '@/components/SectionDiagrams';
import {
  type BackupSchedule,
  type DetectedDatabase,
  type DiscoveredDb,
  type ExternalDatabase,
  type ManagedDatabase,
  type ManagedDatabaseCreateResponse,
  type ManagedDbBackup,
  type ManagedDbReplica,
  useAddReplica,
  useTailscalePeers,
  type TailscalePeer,
  useDiscoverLocalDatabases,
  useBackupSchedule,
  useCreateBackup,
  useImportDatabase,
  useUpdateBackupSchedule,
  useCreateExternalDatabase,
  useCreateManagedDatabase,
  useDeleteBackup,
  useRestoreBackup,
  useDeleteExternalDatabase,
  useDeleteManagedDatabase,
  useExternalDatabases,
  useManagedDatabases,
  useManagedDbBackups,
  useManagedDbBackupUsage,
  useManagedDbEngines,
  useManagedDbReplicas,
  useManagedDbRuntime,
  usePromoteReplica,
  useRemoveReplica,
  useRevealExternalDatabase,
  useRevealManagedDatabase,
  useScanDatabases,
  useProjects,
  useStartManagedDatabase,
  useStopManagedDatabase,
  useTestManagedDbConnection,
} from '@/hooks/queries';

type Tab = 'managed' | 'external';

export default function ManagedDatabases() {
  const [tab, setTab] = useState<Tab>('managed');
  const { data: runtime } = useManagedDbRuntime();
  const managed = useManagedDatabases();
  const external = useExternalDatabases();
  const [showCreate, setShowCreate] = useState(false);
  const [showCreateExternal, setShowCreateExternal] = useState(false);
  const [justCreated, setJustCreated] = useState<ManagedDatabaseCreateResponse | null>(null);

  const refetch = tab === 'managed' ? managed.refetch : external.refetch;
  const isFetching = tab === 'managed' ? managed.isFetching : external.isFetching;

  return (
    <div className="flex-1 overflow-auto bg-transparent">
      <header
        className="px-4 sm:px-6 lg:px-8 py-4 flex items-center justify-between border-b sticky top-0 z-10 backdrop-blur-sm"
        style={{ borderColor: 'hsl(var(--border-soft))', background: 'hsl(var(--surface-soft) / 0.9)' }}
      >
        <div>
          <h1 className="text-lg font-semibold text-slate-900">Databases</h1>
          <p className="text-xs text-slate-600 mt-0.5 hidden sm:block">
            Managed databases run in Podman on this PC. External connections point at a DB you run yourself.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => refetch()}
            disabled={isFetching}
            className="px-3 py-1.5 rounded-lg border border-border text-xs text-slate-700 hover:bg-slate-100 transition-colors disabled:opacity-50"
          >
            {isFetching ? 'Refreshing…' : 'Refresh'}
          </button>
          {tab === 'managed' ? (
            <button
              onClick={() => setShowCreate(true)}
              disabled={!runtime?.available}
              className="px-3 sm:px-4 py-1.5 rounded-lg bg-primary hover:bg-primary/90 text-white text-xs sm:text-sm font-medium transition-colors border border-border shadow-retro disabled:opacity-50 disabled:cursor-not-allowed"
              title={runtime?.available ? '' : 'Install Podman or Docker first'}
            >
              + New Database
            </button>
          ) : (
            <button
              onClick={() => setShowCreateExternal(true)}
              className="px-3 sm:px-4 py-1.5 rounded-lg bg-primary hover:bg-primary/90 text-white text-xs sm:text-sm font-medium transition-colors border border-border shadow-retro"
            >
              + Connect External
            </button>
          )}
        </div>
      </header>

      <main className="px-4 sm:px-6 lg:px-8 py-6 max-w-4xl mx-auto space-y-5 fade-in-up">
        <div className="flex items-center gap-1 border-b border-border">
          <TabButton active={tab === 'managed'} onClick={() => setTab('managed')}>
            Managed ({managed.data?.length ?? 0})
          </TabButton>
          <TabButton active={tab === 'external'} onClick={() => setTab('external')}>
            External ({external.data?.length ?? 0})
          </TabButton>
        </div>

        {tab === 'managed' && (
          <ManagedTabContent
            runtime={runtime}
            data={managed.data}
            isLoading={managed.isLoading}
          />
        )}

        {tab === 'external' && (
          <ExternalTabContent
            data={external.data}
            isLoading={external.isLoading}
          />
        )}
      </main>

      {showCreate && (
        <CreateModal
          onClose={() => setShowCreate(false)}
          onCreated={(resp) => {
            setShowCreate(false);
            setJustCreated(resp);
          }}
        />
      )}

      {showCreateExternal && (
        <CreateExternalModal onClose={() => setShowCreateExternal(false)} />
      )}

      {justCreated && (
        <CredentialsModal
          response={justCreated}
          onClose={() => setJustCreated(null)}
        />
      )}
    </div>
  );
}

function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className={`px-4 py-2 text-xs font-medium transition-colors border-b-2 -mb-px ${
        active
          ? 'border-primary text-red-700'
          : 'border-transparent text-slate-600 hover:text-slate-900'
      }`}
    >
      {children}
    </button>
  );
}

function ScanBanner({
  runtime,
}: {
  runtime: { available: boolean; tailscale_ip?: string | null; tailscale_connected?: boolean } | undefined;
}) {
  const [scanEnabled, setScanEnabled] = useState(false);
  const { data: detected, refetch, isFetching } = useScanDatabases(scanEnabled);
  const importDb = useImportDatabase();
  const [importName, setImportName] = useState<Record<string, string>>({});
  const [importError, setImportError] = useState<string | null>(null);

  if (!runtime?.available) return null;

  const onScan = async () => {
    setScanEnabled(true);
    await refetch();
  };

  const onImport = async (containerName: string) => {
    const displayName = importName[containerName]?.trim() || containerName;
    setImportError(null);
    try {
      await importDb.mutateAsync({ container_name: containerName, display_name: displayName });
    } catch (err: unknown) {
      const msg =
        err && typeof err === 'object' && 'response' in err
          ? ((err as { response?: { data?: { detail?: string } } }).response?.data?.detail ?? String(err))
          : String(err);
      setImportError(msg);
    }
  };

  return (
    <div className="mb-4 rounded-xl border border-border bg-white p-4 space-y-3">
      <div className="flex items-center justify-between">
        <div>
          <p className="text-sm font-semibold text-slate-800">Detect existing databases</p>
          <p className="text-xs text-slate-500 mt-0.5">
            Find Postgres containers already running in Podman that aren't registered here yet.
          </p>
        </div>
        <button
          onClick={onScan}
          disabled={isFetching}
          className="rounded-lg border border-border bg-slate-50 px-3 py-1.5 text-xs font-medium hover:bg-slate-100 disabled:opacity-50"
        >
          {isFetching ? 'Scanning…' : 'Scan'}
        </button>
      </div>

      {runtime.tailscale_connected && (
        <p className="text-xs text-emerald-700">
          Tailscale connected ({runtime.tailscale_ip}) — remote standby available.
        </p>
      )}

      {importError && (
        <p className="text-xs text-red-600">{importError}</p>
      )}

      {detected && detected.length === 0 && scanEnabled && !isFetching && (
        <p className="text-xs text-slate-500">No unmanaged Postgres containers found.</p>
      )}

      {detected && detected.length > 0 && (
        <div className="space-y-2">
          {detected.map((d: DetectedDatabase) => (
            <div
              key={d.container_name}
              className="rounded-lg border border-border bg-slate-50 p-3 space-y-2"
            >
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="text-xs font-mono font-semibold text-slate-800 truncate">
                    {d.container_name}
                  </p>
                  <p className="text-xs text-slate-500">{d.image}</p>
                  <p className="text-xs text-slate-500">
                    Port {d.host_port} · user <span className="font-mono">{d.db_user}</span> · db{' '}
                    <span className="font-mono">{d.db_name}</span>
                    {d.replication_slots.length > 0 && (
                      <> · {d.replication_slots.length} replication slot{d.replication_slots.length !== 1 ? 's' : ''}</>
                    )}
                    {d.active_standbys > 0 && (
                      <> · {d.active_standbys} active standby{d.active_standbys !== 1 ? 's' : ''}</>
                    )}
                  </p>
                </div>
              </div>
              <div className="flex items-center gap-2">
                <input
                  type="text"
                  placeholder={d.container_name}
                  value={importName[d.container_name] ?? ''}
                  onChange={(e) =>
                    setImportName((prev) => ({ ...prev, [d.container_name]: e.target.value }))
                  }
                  className="flex-1 rounded border border-border bg-white px-2 py-1 text-xs outline-none focus:ring-1 focus:ring-primary"
                />
                <button
                  onClick={() => onImport(d.container_name)}
                  disabled={importDb.isPending}
                  className="rounded-lg border border-border bg-white px-3 py-1 text-xs font-medium hover:bg-slate-100 disabled:opacity-50"
                >
                  Import
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function ManagedTabContent({
  runtime,
  data,
  isLoading,
}: {
  runtime: { available: boolean; tailscale_ip?: string | null; tailscale_connected?: boolean } | undefined;
  data: ManagedDatabase[] | undefined;
  isLoading: boolean;
}) {
  return (
    <>
      <ManagedDbDiagram />
      {runtime && !runtime.available && (
        <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-xs text-amber-900">
          No container runtime found on this host.{' '}
          <a
            href="https://podman.io/docs/installation"
            target="_blank"
            rel="noreferrer"
            className="underline font-medium"
          >
            Install Podman
          </a>{' '}
          (or Docker) and refresh.
        </div>
      )}

      <ScanBanner runtime={runtime} />

      {isLoading && (
        <div className="rounded-xl border border-border bg-card p-6 text-sm text-slate-600">
          Loading databases…
        </div>
      )}

      {!isLoading && data && data.length === 0 && (
        <div className="rounded-xl border border-border bg-card p-8 text-center text-sm text-slate-600">
          <p className="font-semibold text-slate-800">No managed databases yet</p>
          <p className="mt-1 text-xs">
            Click <span className="font-semibold">+ New Database</span> to spin one up in Podman.
          </p>
        </div>
      )}

      {data && data.length > 0 && (
        <div className="space-y-3">
          {data.map((db) => (
            <DatabaseCard key={db.id} db={db} />
          ))}
        </div>
      )}
    </>
  );
}

function ExternalTabContent({
  data,
  isLoading,
}: {
  data: ExternalDatabase[] | undefined;
  isLoading: boolean;
}) {
  return (
    <>
      <ExternalDbDiagram />
      {isLoading && (
        <div className="rounded-xl border border-border bg-card p-6 text-sm text-slate-600">
          Loading external connections…
        </div>
      )}

      {!isLoading && data && data.length === 0 && (
        <div className="rounded-xl border border-border bg-card p-8 text-center text-sm text-slate-600">
          <p className="font-semibold text-slate-800">No external databases yet</p>
          <p className="mt-1 text-xs">
            Point WatchTower at a database you already run (RDS, Supabase, NAS, another PC).
          </p>
        </div>
      )}

      {data && data.length > 0 && (
        <div className="space-y-3">
          {data.map((db) => (
            <ExternalDatabaseCard key={db.id} db={db} />
          ))}
        </div>
      )}
    </>
  );
}

function ExternalDatabaseCard({ db }: { db: ExternalDatabase }) {
  const del = useDeleteExternalDatabase();
  const reveal = useRevealExternalDatabase();
  const [confirm, setConfirm] = useState(false);
  const [creds, setCreds] = useState<{ password: string; connection_string: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const handleErr = (err: unknown) => {
    const detail = (err as { response?: { data?: { detail?: string } } })?.response?.data?.detail;
    setError(typeof detail === 'string' ? detail : 'Action failed.');
  };

  return (
    <div className="rounded-xl border border-border bg-card p-5 space-y-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <h3 className="text-sm font-semibold text-slate-900 truncate">{db.name}</h3>
            <span className="text-[11px] px-2 py-0.5 rounded-full border font-medium bg-violet-50 text-violet-700 border-violet-200">
              external
            </span>
            <span className="text-[11px] text-slate-500 font-mono">{db.engine}</span>
            {db.use_tls && (
              <span className="text-[11px] px-2 py-0.5 rounded-full border font-medium bg-emerald-50 text-emerald-700 border-emerald-200">
                TLS
              </span>
            )}
          </div>
          <p className="text-xs text-slate-600 mt-1 font-mono break-all">
            {db.host}:{db.port}
            {db.database_name && ` · db=${db.database_name}`}
            {db.username && ` · user=${db.username}`}
          </p>
          {db.notes && <p className="text-xs text-slate-500 mt-1">{db.notes}</p>}
        </div>
      </div>

      {error && (
        <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700 break-all">
          {error}
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <button
          onClick={() => {
            setError(null);
            reveal.mutate(db.id, { onSuccess: setCreds, onError: handleErr });
          }}
          disabled={reveal.isPending}
          className="px-3 py-1.5 rounded-lg border border-border text-xs text-slate-700 hover:bg-slate-100 transition-colors disabled:opacity-50"
        >
          {reveal.isPending ? 'Loading…' : 'Show connection'}
        </button>
        <button
          onClick={() => setConfirm(true)}
          disabled={del.isPending}
          className="ml-auto px-3 py-1.5 rounded-lg border border-red-200 text-xs text-red-700 hover:bg-red-50 transition-colors disabled:opacity-50"
        >
          Remove
        </button>
      </div>

      {confirm && (
        <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-3 space-y-2">
          <p className="text-xs text-red-900">
            Remove <span className="font-mono">{db.name}</span>? This only forgets the connection details — it does not touch the remote database itself.
          </p>
          <div className="flex items-center gap-2">
            <button
              onClick={() => {
                setError(null);
                del.mutate(db.id, { onError: handleErr });
              }}
              disabled={del.isPending}
              className="px-3 py-1 rounded-md bg-primary hover:bg-primary/90 text-white text-xs font-medium disabled:opacity-50"
            >
              {del.isPending ? 'Removing…' : 'Confirm remove'}
            </button>
            <button
              onClick={() => setConfirm(false)}
              disabled={del.isPending}
              className="px-3 py-1 rounded-md border border-red-300 bg-white text-xs text-red-800 disabled:opacity-50"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {creds && (
        <ExternalCredentialsModal db={db} creds={creds} onClose={() => setCreds(null)} />
      )}
    </div>
  );
}

function ExternalCredentialsModal({
  db,
  creds,
  onClose,
}: {
  db: ExternalDatabase;
  creds: { password: string; connection_string: string };
  onClose: () => void;
}) {
  const [copied, setCopied] = useState<string | null>(null);
  const copy = async (text: string, key: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(key);
      window.setTimeout(() => setCopied(null), 1500);
    } catch {
      /* ignore */
    }
  };
  return (
    <Modal onClose={onClose}>
      <h2 className="text-base font-semibold text-slate-900">
        Connection — <span className="font-mono">{db.name}</span>
      </h2>
      <p className="text-xs text-slate-600 mt-1">External database — WatchTower stored these credentials.</p>
      <div className="mt-4 space-y-3">
        <CredField label="Connection string" value={creds.connection_string}
          copied={copied === 'c'} onCopy={() => copy(creds.connection_string, 'c')} />
        {creds.password && (
          <CredField label="Password" value={creds.password}
            copied={copied === 'p'} onCopy={() => copy(creds.password, 'p')} mono />
        )}
      </div>
      <div className="mt-5 flex items-center justify-end">
        <button
          onClick={onClose}
          className="px-4 py-1.5 rounded-lg bg-primary hover:bg-primary/90 text-white text-xs font-medium border border-border shadow-retro"
        >
          Done
        </button>
      </div>
    </Modal>
  );
}

function CreateExternalModal({ onClose }: { onClose: () => void }) {
  const { data: engines } = useManagedDbEngines();
  const { data: discovered } = useDiscoverLocalDatabases();
  const [name, setName] = useState('');
  const [engineId, setEngineId] = useState('postgres');
  const [host, setHost] = useState('');
  const [port, setPort] = useState<number>(5432);
  const [databaseName, setDatabaseName] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [useTls, setUseTls] = useState(true);
  const [notes, setNotes] = useState('');
  const [error, setError] = useState<string | null>(null);

  const create = useCreateExternalDatabase();

  // Snap the default port when the engine changes.
  const onEngineChange = (id: string) => {
    setEngineId(id);
    const defaultPorts: Record<string, number> = {
      postgres: 5432, mysql: 3306, mariadb: 3306, mongodb: 27017, redis: 6379,
    };
    setPort(defaultPorts[id] ?? 5432);
  };

  const submit = () => {
    if (!name.trim()) return setError('Name is required.');
    if (!host.trim()) return setError('Host is required.');
    setError(null);
    create.mutate(
      {
        name: name.trim(),
        engine: engineId,
        host: host.trim(),
        port,
        database_name: databaseName || undefined,
        username: username || undefined,
        password: password || undefined,
        use_tls: useTls,
        notes: notes || undefined,
      },
      {
        onSuccess: onClose,
        onError: (err) => {
          const detail = (err as { response?: { data?: { detail?: string } } })?.response?.data?.detail;
          setError(typeof detail === 'string' ? detail : 'Could not save connection.');
        },
      },
    );
  };

  // Pre-fill the form from a discovered local DB container — the user then
  // just adds the password and saves.
  const adopt = (d: DiscoveredDb) => {
    setName(d.container_name);
    onEngineChange(d.engine);
    setHost(d.suggested_host || '127.0.0.1');
    if (d.suggested_port) setPort(d.suggested_port);
    if (d.suggested_username) setUsername(d.suggested_username);
    setUseTls(false); // local containers are plaintext on loopback
  };

  const adoptable = (discovered ?? []).filter((d) => !d.already_connected);

  return (
    <Modal onClose={onClose}>
      <h2 className="text-base font-semibold text-slate-900">Connect external database</h2>
      <p className="text-xs text-slate-600 mt-1">
        Point WatchTower at a database you already run. Credentials are encrypted at rest.
      </p>

      {adoptable.length > 0 && (
        <div className="mt-3 rounded-lg border border-border-soft bg-surface-soft p-3">
          <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground mb-2">
            Found on this PC
          </p>
          <div className="space-y-1.5">
            {adoptable.map((d) => (
              <div key={d.container_id} className="flex items-center gap-2 text-xs">
                <span className={`inline-block w-1.5 h-1.5 rounded-full shrink-0 ${d.state === 'running' ? 'bg-emerald-500' : 'bg-slate-400'}`} />
                <span className="font-mono text-foreground truncate">{d.container_name}</span>
                <span className="text-muted-foreground">· {d.engine}{d.suggested_port ? ` :${d.suggested_port}` : ''}</span>
                <button
                  type="button"
                  onClick={() => adopt(d)}
                  className="ml-auto px-2 py-0.5 rounded border border-border bg-card text-foreground hover:bg-muted transition-colors shrink-0"
                >
                  Adopt
                </button>
              </div>
            ))}
          </div>
          <p className="text-[10px] text-muted-foreground mt-2">
            Adopt pre-fills the form — just add the password and save.
          </p>
        </div>
      )}

      <div className="mt-4 space-y-3">
        <Field label="Name">
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="prod-rds"
            className="w-full rounded-lg border border-border bg-white px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-red-300"
          />
        </Field>

        <div className="grid grid-cols-2 gap-3">
          <Field label="Engine">
            <select
              value={engineId}
              onChange={(e) => onEngineChange(e.target.value)}
              className="w-full rounded-lg border border-border bg-white px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-red-300"
            >
              {(engines ?? [{ id: 'postgres', name: 'PostgreSQL' }]).map((e) => (
                <option key={e.id} value={e.id}>{e.name}</option>
              ))}
            </select>
          </Field>
          <Field label="Port">
            <input
              type="number"
              value={port}
              min={1}
              max={65535}
              onChange={(e) => setPort(Number(e.target.value) || 0)}
              className="w-full rounded-lg border border-border bg-white px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-red-300"
            />
          </Field>
        </div>

        <Field label="Host" hint="DNS name or IP (e.g. db.example.com, 100.64.5.7)">
          <input
            value={host}
            onChange={(e) => setHost(e.target.value)}
            placeholder="db.example.com"
            className="w-full rounded-lg border border-border bg-white px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-red-300"
          />
        </Field>

        {engineId !== 'redis' && (
          <div className="grid grid-cols-2 gap-3">
            <Field label="Database name (optional)">
              <input
                value={databaseName}
                onChange={(e) => setDatabaseName(e.target.value)}
                className="w-full rounded-lg border border-border bg-white px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-red-300"
              />
            </Field>
            <Field label="Username (optional)">
              <input
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                className="w-full rounded-lg border border-border bg-white px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-red-300"
              />
            </Field>
          </div>
        )}

        <Field label="Password (optional)">
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="leave blank for no-auth"
            className="w-full rounded-lg border border-border bg-white px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-red-300"
          />
        </Field>

        <label className="flex items-center gap-2 text-xs text-slate-700">
          <input
            type="checkbox"
            checked={useTls}
            onChange={(e) => setUseTls(e.target.checked)}
          />
          Use TLS for connections
        </label>

        <Field label="Notes (optional)">
          <input
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder="e.g. read replica for analytics"
            className="w-full rounded-lg border border-border bg-white px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-red-300"
          />
        </Field>
      </div>

      {error && (
        <div className="mt-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700 break-all">
          {error}
        </div>
      )}

      <div className="mt-5 flex items-center justify-end gap-2">
        <button
          onClick={onClose}
          disabled={create.isPending}
          className="px-3 py-1.5 rounded-lg border border-border text-xs text-slate-700 hover:bg-slate-100 transition-colors disabled:opacity-50"
        >
          Cancel
        </button>
        <button
          onClick={submit}
          disabled={create.isPending}
          className="px-4 py-1.5 rounded-lg bg-primary hover:bg-primary/90 text-white text-xs font-medium border border-border shadow-retro disabled:opacity-50"
        >
          {create.isPending ? 'Saving…' : 'Save connection'}
        </button>
      </div>
    </Modal>
  );
}

/* ---------------------------------------------------------------- card */

function DatabaseCard({ db }: { db: ManagedDatabase }) {
  const start = useStartManagedDatabase();
  const stop = useStopManagedDatabase();
  const del = useDeleteManagedDatabase();
  const reveal = useRevealManagedDatabase();
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [purge, setPurge] = useState(false);
  const [showCreds, setShowCreds] = useState<{ password: string; connection_string: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const busy = start.isPending || stop.isPending || del.isPending;
  const handleErr = (err: unknown) => {
    const detail = (err as { response?: { data?: { detail?: string } } })?.response?.data?.detail;
    setError(typeof detail === 'string' ? detail : 'Action failed.');
  };

  return (
    <div className="rounded-xl border border-border bg-card p-5 space-y-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <h3 className="text-sm font-semibold text-slate-900 truncate">{db.name}</h3>
            <StatusBadge status={db.status} />
            <span className="text-[11px] text-slate-500 font-mono">
              {db.engine} {db.version}
            </span>
          </div>
          <p className="text-xs text-slate-600 mt-1 font-mono break-all">
            {db.host}:{db.port} · db={db.database_name} · user={db.username}
          </p>
          {db.status_message && (
            <p className="text-xs text-red-700 mt-1">{db.status_message}</p>
          )}
        </div>
      </div>

      {error && (
        <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700 break-all">
          {error}
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2">
        {db.status === 'stopped' && (
          <button
            onClick={() => {
              setError(null);
              start.mutate(db.id, { onError: handleErr });
            }}
            disabled={busy}
            className="px-3 py-1.5 rounded-lg bg-emerald-700 hover:bg-emerald-800 text-white text-xs font-medium border border-border shadow-retro disabled:opacity-50"
          >
            Start
          </button>
        )}
        {db.status === 'running' && (
          <button
            onClick={() => {
              setError(null);
              stop.mutate(db.id, { onError: handleErr });
            }}
            disabled={busy}
            className="px-3 py-1.5 rounded-lg border border-border text-xs text-slate-700 hover:bg-slate-100 transition-colors disabled:opacity-50"
          >
            Stop
          </button>
        )}
        <button
          onClick={() => {
            setError(null);
            reveal.mutate(db.id, {
              onSuccess: (data) => setShowCreds(data),
              onError: handleErr,
            });
          }}
          disabled={reveal.isPending}
          className="px-3 py-1.5 rounded-lg border border-border text-xs text-slate-700 hover:bg-slate-100 transition-colors disabled:opacity-50"
        >
          {reveal.isPending ? 'Loading…' : 'Show credentials'}
        </button>
        <button
          onClick={() => setConfirmDelete(true)}
          disabled={busy}
          className="ml-auto px-3 py-1.5 rounded-lg border border-red-200 text-xs text-red-700 hover:bg-red-50 transition-colors disabled:opacity-50"
        >
          Delete
        </button>
      </div>

      {confirmDelete && (
        <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-3 space-y-2">
          <p className="text-xs text-red-900 font-medium">
            Delete <span className="font-mono">{db.name}</span>?
          </p>
          <label className="flex items-center gap-2 text-xs text-red-900">
            <input
              type="checkbox"
              checked={purge}
              onChange={(e) => setPurge(e.target.checked)}
            />
            Also delete the data volume (cannot be undone)
          </label>
          <div className="flex items-center gap-2">
            <button
              onClick={() => {
                setError(null);
                del.mutate(
                  { id: db.id, purge },
                  {
                    onError: handleErr,
                    onSuccess: () => setConfirmDelete(false),
                  },
                );
              }}
              disabled={del.isPending}
              className="px-3 py-1 rounded-md bg-primary hover:bg-primary/90 text-white text-xs font-medium disabled:opacity-50"
            >
              {del.isPending ? 'Deleting…' : 'Confirm delete'}
            </button>
            <button
              onClick={() => setConfirmDelete(false)}
              disabled={del.isPending}
              className="px-3 py-1 rounded-md border border-red-300 bg-white text-xs text-red-800 disabled:opacity-50"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {showCreds && (
        <CredentialsModal
          response={{ ...db, password: showCreds.password, connection_string: showCreds.connection_string }}
          onClose={() => setShowCreds(null)}
        />
      )}

      {db.engine === 'postgres' && <ReplicasSection primaryDb={db} />}
      {db.engine === 'postgres' && <BackupsSection primaryDb={db} />}
    </div>
  );
}

/* ---------------------------------------------------------------- replicas */

type ReplicaMode = 'local' | 'remote';

function AddReplicaModal({
  primaryDb,
  onClose,
}: {
  primaryDb: ManagedDatabase;
  onClose: () => void;
}) {
  const [mode, setMode] = useState<ReplicaMode>('local');
  const [selectedPeer, setSelectedPeer] = useState<TailscalePeer | null>(null);
  const [error, setError] = useState<string | null>(null);
  const add = useAddReplica(primaryDb.id);
  const { data: peers = [], isLoading: peersLoading } = useTailscalePeers();

  const onSubmit = () => {
    setError(null);
    const payload =
      mode === 'remote' && selectedPeer
        ? { node_tailscale_ip: selectedPeer.tailscale_ip }
        : {};
    add.mutate(payload, {
      onError: (err) => {
        const detail = (err as { response?: { data?: { detail?: string } } })?.response?.data?.detail;
        setError(typeof detail === 'string' ? detail : 'Provisioning failed.');
      },
      onSuccess: () => onClose(),
    });
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm">
      <div className="bg-white rounded-xl shadow-xl border border-border w-full max-w-md mx-4 p-5 space-y-4">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold text-slate-900">Add Standby Replica</h2>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-600 text-lg leading-none">×</button>
        </div>

        {/* Mode tabs */}
        <div className="flex rounded-lg border border-border overflow-hidden text-xs font-medium">
          {(['local', 'remote'] as ReplicaMode[]).map((m) => (
            <button
              key={m}
              onClick={() => { setMode(m); setSelectedPeer(null); }}
              className={`flex-1 py-2 transition-colors ${
                mode === m
                  ? 'bg-slate-900 text-white'
                  : 'bg-white text-slate-600 hover:bg-slate-50'
              }`}
            >
              {m === 'local' ? 'Local (this PC)' : 'Remote (Tailscale)'}
            </button>
          ))}
        </div>

        {mode === 'local' && (
          <p className="text-xs text-slate-500">
            Provisions a standby pod on this machine. It streams WAL from the primary
            and can be promoted if the primary fails.
          </p>
        )}

        {mode === 'remote' && (
          <div className="space-y-3">
            <p className="text-xs text-slate-500">
              Sets up replication to a remote machine on your Tailnet. WatchTower
              configures the primary and generates a compose file you run on the
              remote machine — it handles the <code className="font-mono">pg_basebackup</code> automatically.
            </p>
            <p className="text-[11px] font-semibold text-slate-700">Select remote machine:</p>
            {peersLoading && <p className="text-xs text-slate-400">Discovering Tailscale peers…</p>}
            {!peersLoading && peers.length === 0 && (
              <p className="text-xs text-slate-400 italic">
                No Tailscale peers found. Make sure Tailscale is running.
              </p>
            )}
            <div className="space-y-1 max-h-40 overflow-y-auto">
              {peers.map((peer) => (
                <button
                  key={peer.tailscale_ip}
                  onClick={() => setSelectedPeer(peer)}
                  className={`w-full flex items-center justify-between px-3 py-2 rounded-lg border text-xs transition-colors ${
                    selectedPeer?.tailscale_ip === peer.tailscale_ip
                      ? 'border-slate-900 bg-slate-50'
                      : 'border-border hover:border-slate-400'
                  }`}
                >
                  <span className="font-medium text-slate-800">{peer.hostname}</span>
                  <div className="flex items-center gap-2 text-slate-500">
                    <span className="font-mono">{peer.tailscale_ip}</span>
                    <span className="text-[10px]">{peer.os}</span>
                    <span className={`w-1.5 h-1.5 rounded-full ${peer.online ? 'bg-green-500' : 'bg-slate-300'}`} />
                  </div>
                </button>
              ))}
            </div>
            {selectedPeer && (
              <p className="text-[11px] text-slate-500 bg-blue-50 border border-blue-200 rounded-md px-3 py-2">
                After clicking "Add standby", download the compose file from the replica
                card and run it on <span className="font-medium">{selectedPeer.hostname}</span>.
              </p>
            )}
          </div>
        )}

        {error && (
          <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700 break-all">
            {error}
          </div>
        )}

        <div className="flex items-center gap-2 pt-1">
          <button
            onClick={onSubmit}
            disabled={
              add.isPending ||
              primaryDb.status !== 'running' ||
              (mode === 'remote' && !selectedPeer)
            }
            className="flex-1 py-2 rounded-md bg-red-700 hover:bg-red-800 text-white text-xs font-medium disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {add.isPending ? 'Provisioning…' : 'Add standby'}
          </button>
          <button
            onClick={onClose}
            className="px-4 py-2 rounded-md border border-border text-xs text-slate-600 hover:bg-slate-50"
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}

function ReplicasSection({ primaryDb }: { primaryDb: ManagedDatabase }) {
  const [open, setOpen] = useState(false);
  const [showAddModal, setShowAddModal] = useState(false);
  const { data: replicas, isLoading } = useManagedDbReplicas(primaryDb.id, open);

  return (
    <div className="border-t border-border -mx-5 -mb-5 mt-2 px-5 pt-3 pb-4 bg-slate-50/40 rounded-b-xl">
      <button
        onClick={() => setOpen(!open)}
        className="flex items-center gap-2 text-xs font-semibold text-slate-700 hover:text-slate-900"
      >
        <span>{open ? '▾' : '▸'}</span>
        Replicas {replicas && replicas.length > 0 ? `(${replicas.length})` : ''}
      </button>

      {open && (
        <div className="mt-3 space-y-3">
          <ReplicationDiagram />
          <div className="flex items-center justify-between">
            <p className="text-[11px] text-slate-500">
              Postgres streaming replication — local pod on this PC, or remote machine via Tailscale.
            </p>
            <button
              onClick={onAdd}
              disabled={add.isPending || primaryDb.status !== 'running'}
              className="px-3 py-1 rounded-md bg-primary hover:bg-primary/90 text-white text-[11px] font-medium border border-border shadow-retro disabled:opacity-50 disabled:cursor-not-allowed"
              title={primaryDb.status !== 'running' ? 'Primary must be running' : ''}
            >
              + Add standby
            </button>
          </div>

          {isLoading && <p className="text-xs text-slate-500">Loading replicas…</p>}

          {replicas && replicas.length === 0 && (
            <p className="text-xs text-slate-500 italic">
              No replicas yet. Add one to get a hot standby.
            </p>
          )}

          {replicas && replicas.length > 0 && (
            <div className="space-y-2">
              {replicas.map((r) => (
                <ReplicaRow key={r.id} primaryDb={primaryDb} replica={r} />
              ))}
            </div>
          )}
        </div>
      )}

      {showAddModal && (
        <AddReplicaModal primaryDb={primaryDb} onClose={() => setShowAddModal(false)} />
      )}
    </div>
  );
}

function ReplicaRow({
  primaryDb,
  replica,
}: {
  primaryDb: ManagedDatabase;
  replica: ManagedDbReplica;
}) {
  const promote = usePromoteReplica(primaryDb.id);
  const remove = useRemoveReplica(primaryDb.id);
  const [confirm, setConfirm] = useState<'promote' | 'remove' | null>(null);
  const [error, setError] = useState<string | null>(null);

  const handleErr = (err: unknown) => {
    const detail = (err as { response?: { data?: { detail?: string } } })?.response?.data?.detail;
    setError(typeof detail === 'string' ? detail : 'Action failed.');
    setConfirm(null);
  };

  const busy = promote.isPending || remove.isPending;

  return (
    <div className="rounded-lg border border-border bg-white px-3 py-2 space-y-2">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div className="flex items-center gap-2 flex-wrap min-w-0">
          <span className="text-xs font-semibold text-slate-800 truncate">{replica.name}</span>
          <ReplicaStatusBadge status={replica.status} />
          <ReplicaRoleBadge role={replica.role} />
          {replica.is_remote && (
            <span className="text-[10px] px-1.5 py-0.5 rounded bg-blue-100 text-blue-700 font-medium">
              Tailscale {replica.node_tailscale_ip}
            </span>
          )}
          {!replica.is_remote && (
            <span className="text-[11px] text-slate-500 font-mono">{replica.host}:{replica.port}</span>
          )}
        </div>
        <div className="flex items-center gap-1">
          {replica.is_remote && replica.status === 'initializing' && (
            <a
              href={`/api/managed-databases/${primaryDb.id}/replicas/${replica.id}/compose`}
              download
              className="px-2 py-1 rounded-md border border-blue-300 bg-blue-50 text-[11px] text-blue-800 hover:bg-blue-100 transition-colors"
              title="Download compose file and run on the remote machine"
            >
              Download compose
            </a>
          )}
          {replica.role === 'standby' && replica.status === 'streaming' && (
            <button
              onClick={() => setConfirm('promote')}
              disabled={busy}
              className="px-2 py-1 rounded-md border border-amber-300 bg-amber-50 text-[11px] text-amber-900 hover:bg-amber-100 transition-colors disabled:opacity-50"
              title="Promote this standby to primary (manual failover)"
            >
              Promote
            </button>
          )}
          <button
            onClick={() => setConfirm('remove')}
            disabled={busy}
            className="px-2 py-1 rounded-md border border-red-200 text-[11px] text-red-700 hover:bg-red-50 transition-colors disabled:opacity-50"
          >
            Remove
          </button>
        </div>
      </div>

      {replica.status_message && (
        <p className="text-[11px] text-slate-500 break-all">{replica.status_message}</p>
      )}

      {error && (
        <div className="rounded-md border border-red-200 bg-red-50 px-2 py-1 text-[11px] text-red-700 break-all">
          {error}
        </div>
      )}

      {confirm === 'promote' && (
        <div className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 space-y-2">
          <p className="text-[11px] text-amber-900">
            Promote <span className="font-mono">{replica.name}</span> to primary? The current primary will be stopped and apps must switch connection strings to <span className="font-mono">{replica.host}:{replica.port}</span>.
          </p>
          <div className="flex items-center gap-2">
            <button
              onClick={() => {
                setError(null);
                promote.mutate(replica.id, {
                  onError: handleErr,
                  onSuccess: () => setConfirm(null),
                });
              }}
              disabled={busy}
              className="px-2 py-1 rounded-md bg-amber-700 hover:bg-amber-800 text-white text-[11px] font-medium disabled:opacity-50"
            >
              {promote.isPending ? 'Promoting…' : 'Confirm promote'}
            </button>
            <button
              onClick={() => setConfirm(null)}
              disabled={busy}
              className="px-2 py-1 rounded-md border border-amber-400 bg-white text-[11px] text-amber-900 disabled:opacity-50"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {confirm === 'remove' && (
        <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 space-y-2">
          <p className="text-[11px] text-red-900">
            Remove <span className="font-mono">{replica.name}</span>? This stops the standby pod and drops the replication slot on the primary. Primary data is untouched.
          </p>
          <div className="flex items-center gap-2">
            <button
              onClick={() => {
                setError(null);
                remove.mutate(replica.id, {
                  onError: handleErr,
                  onSuccess: () => setConfirm(null),
                });
              }}
              disabled={busy}
              className="px-2 py-1 rounded-md bg-primary hover:bg-primary/90 text-white text-[11px] font-medium disabled:opacity-50"
            >
              {remove.isPending ? 'Removing…' : 'Confirm remove'}
            </button>
            <button
              onClick={() => setConfirm(null)}
              disabled={busy}
              className="px-2 py-1 rounded-md border border-red-300 bg-white text-[11px] text-red-800 disabled:opacity-50"
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function ReplicaStatusBadge({ status }: { status: ManagedDbReplica['status'] }) {
  const map: Record<ManagedDbReplica['status'], string> = {
    initializing: 'bg-blue-50 text-blue-700 border-blue-200',
    streaming: 'bg-emerald-50 text-emerald-700 border-emerald-200',
    failed: 'bg-red-50 text-red-700 border-red-200',
    promoted: 'bg-amber-50 text-amber-800 border-amber-200',
  };
  return (
    <span className={`text-[10px] px-1.5 py-0.5 rounded-full border font-medium ${map[status]}`}>
      {status}
    </span>
  );
}

/* ---------------------------------------------------------------- backups */
// Third pillar of the PC-appliance vision: durability. v0 = on-demand
// pg_dump backups stored under ~/.watchtower/managed_db_backups/.

function formatBytes(n: number | null | undefined): string {
  if (n == null) return '—';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function BackupsSection({ primaryDb }: { primaryDb: ManagedDatabase }) {
  const [open, setOpen] = useState(false);
  const { data: backups, isLoading } = useManagedDbBackups(primaryDb.id, open);
  const { data: usage } = useManagedDbBackupUsage(primaryDb.id, open);
  const { data: schedule } = useBackupSchedule(primaryDb.id, open);
  const create = useCreateBackup(primaryDb.id);
  const [label, setLabel] = useState('');
  const [error, setError] = useState<string | null>(null);

  const handleErr = (err: unknown) => {
    const detail = (err as { response?: { data?: { detail?: string } } })?.response?.data?.detail;
    setError(typeof detail === 'string' ? detail : 'Action failed.');
  };

  const onCreate = () => {
    setError(null);
    create.mutate(
      { label: label.trim() || undefined },
      {
        onError: handleErr,
        onSuccess: () => setLabel(''),
      },
    );
  };

  return (
    <div className="border-t border-border -mx-5 -mb-5 mt-2 px-5 pt-3 pb-4 bg-slate-50/40 rounded-b-xl">
      <button
        onClick={() => setOpen(!open)}
        className="flex items-center gap-2 text-xs font-semibold text-slate-700 hover:text-slate-900"
      >
        <span>{open ? '▾' : '▸'}</span>
        Backups {backups && backups.length > 0 ? `(${backups.length})` : ''}
      </button>

      {open && (
        <div className="mt-3 space-y-3">
          <BackupDiagram />
          <ScheduleControls primaryDb={primaryDb} schedule={schedule} />
          <div className="flex items-start justify-between gap-3 flex-wrap">
            <p className="text-[11px] text-slate-500 max-w-md">
              On-demand <code className="font-mono">pg_dump</code> snapshots stored under{' '}
              <code className="font-mono">~/.watchtower/managed_db_backups/</code>.
              Schedule above for automatic recurring backups.
            </p>
            {usage && (
              <p className="text-[11px] text-slate-500 whitespace-nowrap">
                Used: <span className="font-mono">{formatBytes(usage.used_bytes)}</span>
                {' · '}
                Free: <span className="font-mono">{formatBytes(usage.free_bytes)}</span>
              </p>
            )}
          </div>

          <div className="flex items-center gap-2 flex-wrap">
            <input
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder="label (optional, e.g. 'pre-migration')"
              className="flex-1 min-w-0 rounded-md border border-border bg-white px-3 py-1.5 text-xs focus:outline-none focus:ring-2 focus:ring-red-300"
            />
            <button
              onClick={onCreate}
              disabled={create.isPending || primaryDb.status !== 'running'}
              className="px-3 py-1.5 rounded-md bg-primary hover:bg-primary/90 text-white text-[11px] font-medium border border-border shadow-retro disabled:opacity-50 disabled:cursor-not-allowed whitespace-nowrap"
              title={primaryDb.status !== 'running' ? 'Database must be running' : ''}
            >
              {create.isPending ? 'Backing up…' : 'Backup now'}
            </button>
          </div>

          {error && (
            <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700 break-all">
              {error}
            </div>
          )}

          {isLoading && <p className="text-xs text-slate-500">Loading backups…</p>}

          {backups && backups.length === 0 && (
            <p className="text-xs text-slate-500 italic">
              No backups yet. Click <span className="font-semibold">Backup now</span> to create one.
            </p>
          )}

          {backups && backups.length > 0 && (
            <div className="space-y-1.5">
              {backups.map((b) => (
                <BackupRow key={b.id} primaryDb={primaryDb} backup={b} />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function BackupRow({
  primaryDb,
  backup,
}: {
  primaryDb: ManagedDatabase;
  backup: ManagedDbBackup;
}) {
  const del = useDeleteBackup(primaryDb.id);
  const restore = useRestoreBackup(primaryDb.id);
  const [confirm, setConfirm] = useState<'delete' | 'restore' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [restoreSuccess, setRestoreSuccess] = useState<string | null>(null);

  const busy = del.isPending || restore.isPending;
  const handleErr = (err: unknown, fallback: string) => {
    const detail = (err as { response?: { data?: { detail?: string } } })?.response?.data?.detail;
    setError(typeof detail === 'string' ? detail : fallback);
  };

  return (
    <div className="rounded-lg border border-border bg-white px-3 py-2 text-xs">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div className="min-w-0 flex items-center gap-2 flex-wrap">
          <BackupStatusBadge status={backup.status} />
          <span className="font-mono text-slate-700 truncate max-w-xs" title={backup.file_path}>
            {backup.file_path.split('/').pop()}
          </span>
          {backup.label && (
            <span className="text-[11px] text-slate-500">— {backup.label}</span>
          )}
          <span className="text-[11px] text-slate-500 font-mono">
            {formatBytes(backup.size_bytes)}
          </span>
        </div>
        <div className="flex items-center gap-1">
          {backup.status === 'ready' && (
            <button
              onClick={() => {
                setError(null);
                setRestoreSuccess(null);
                setConfirm('restore');
              }}
              disabled={busy || primaryDb.status !== 'running'}
              className="px-2 py-1 rounded-md border border-amber-300 bg-amber-50 text-[11px] text-amber-900 hover:bg-amber-100 transition-colors disabled:opacity-50"
              title={primaryDb.status !== 'running' ? 'Target DB must be running' : 'Restore this backup, replacing live data'}
            >
              Restore
            </button>
          )}
          <button
            onClick={() => {
              setError(null);
              setRestoreSuccess(null);
              setConfirm('delete');
            }}
            disabled={busy}
            className="px-2 py-1 rounded-md border border-red-200 text-[11px] text-red-700 hover:bg-red-50 transition-colors disabled:opacity-50"
          >
            Delete
          </button>
        </div>
      </div>
      {backup.status_message && (
        <p className="text-[11px] text-red-600 mt-1 break-all">{backup.status_message}</p>
      )}
      {error && (
        <p className="text-[11px] text-red-600 mt-1 break-all">{error}</p>
      )}
      {restoreSuccess && (
        <p className="text-[11px] text-emerald-700 mt-1">{restoreSuccess}</p>
      )}
      {confirm === 'delete' && (
        <div className="mt-2 rounded-md border border-red-200 bg-red-50 px-2 py-1.5 flex items-center gap-2 flex-wrap">
          <p className="text-[11px] text-red-900 flex-1 min-w-0">Delete this backup file?</p>
          <button
            onClick={() => {
              setError(null);
              del.mutate(backup.id, {
                onSuccess: () => setConfirm(null),
                onError: (err) => handleErr(err, 'Failed to delete backup.'),
              });
            }}
            disabled={busy}
            className="px-2 py-1 rounded-md bg-primary hover:bg-primary/90 text-white text-[11px] font-medium disabled:opacity-50"
          >
            {del.isPending ? 'Deleting…' : 'Confirm'}
          </button>
          <button
            onClick={() => setConfirm(null)}
            disabled={busy}
            className="px-2 py-1 rounded-md border border-red-300 bg-white text-[11px] text-red-800 disabled:opacity-50"
          >
            Cancel
          </button>
        </div>
      )}
      {confirm === 'restore' && (
        <RestoreConfirm
          primaryDb={primaryDb}
          onCancel={() => setConfirm(null)}
          onConfirm={(payload) => {
            setError(null);
            restore.mutate(
              payload.mode === 'new'
                ? { mode: 'new', backupId: backup.id, newName: payload.newName }
                : { mode: 'in-place', backupId: backup.id, confirmDbName: payload.confirmDbName },
              {
                onSuccess: (data) => {
                  setConfirm(null);
                  if (data.mode === 'new') {
                    setRestoreSuccess(
                      `Created ${data.new_db_name} from ${data.restored_from.label ?? 'this backup'} — running on port ${data.new_db_port}.`
                    );
                  } else {
                    setRestoreSuccess(
                      `Restored ${data.database_name} from ${data.restored_from.label ?? 'this backup'}.`
                    );
                  }
                },
                onError: (err) => handleErr(err, 'Failed to restore backup.'),
              },
            );
          }}
          isPending={restore.isPending}
        />
      )}
    </div>
  );
}

// Scheduled-backups control. Cron string in UTC, with a preset
// dropdown for common cases ("Hourly", "Daily 3am UTC", "Weekly Sun
// 3am UTC") + a raw-cron escape hatch. Retention cap stops a
// misconfigured schedule from filling the disk.

const CRON_PRESETS: { label: string; cron: string; describe: string }[] = [
  { label: 'Hourly', cron: '0 * * * *', describe: 'Every hour at :00' },
  { label: 'Every 6 hours', cron: '0 */6 * * *', describe: '00:00, 06:00, 12:00, 18:00 UTC' },
  { label: 'Daily 3am UTC', cron: '0 3 * * *', describe: 'Every day at 03:00 UTC' },
  { label: 'Daily 0am UTC', cron: '0 0 * * *', describe: 'Every day at midnight UTC' },
  { label: 'Weekly Sun 3am UTC', cron: '0 3 * * 0', describe: 'Every Sunday at 03:00 UTC' },
];

function formatNextRun(iso: string | null): string {
  if (!iso) return '—';
  try {
    const d = new Date(iso);
    if (isNaN(d.getTime())) return iso;
    const diffMs = d.getTime() - Date.now();
    const absMin = Math.round(Math.abs(diffMs) / 60_000);
    const when = d.toLocaleString();
    if (diffMs < 0) return `${when} (overdue)`;
    if (absMin < 60) return `${when} (in ${absMin} min)`;
    const hrs = Math.round(absMin / 60);
    if (hrs < 24) return `${when} (in ${hrs} h)`;
    const days = Math.round(hrs / 24);
    return `${when} (in ${days} d)`;
  } catch {
    return iso;
  }
}

function ScheduleControls({
  primaryDb,
  schedule,
}: {
  primaryDb: ManagedDatabase;
  schedule: BackupSchedule | undefined;
}) {
  const update = useUpdateBackupSchedule(primaryDb.id);
  const currentCron = schedule?.schedule_cron ?? '';
  const currentPreset = CRON_PRESETS.find((p) => p.cron === currentCron)?.cron ?? (currentCron ? 'custom' : '');

  const [selectedPreset, setSelectedPreset] = useState<string>(currentPreset);
  const [customCron, setCustomCron] = useState<string>(currentPreset === 'custom' ? currentCron : '');
  const [retention, setRetention] = useState<number>(schedule?.schedule_retention_count ?? 7);
  const [error, setError] = useState<string | null>(null);
  const [savedFlash, setSavedFlash] = useState<boolean>(false);

  // Sync local state when schedule arrives / changes.
  useEffect(() => {
    if (!schedule) return;
    const cur = schedule.schedule_cron ?? '';
    const preset = CRON_PRESETS.find((p) => p.cron === cur)?.cron ?? (cur ? 'custom' : '');
    setSelectedPreset(preset);
    setCustomCron(preset === 'custom' ? cur : '');
    setRetention(schedule.schedule_retention_count);
  }, [schedule]);

  const isCustom = selectedPreset === 'custom';
  const effectiveCron = isCustom ? customCron.trim() : selectedPreset;

  const save = () => {
    setError(null);
    setSavedFlash(false);
    update.mutate(
      {
        cron: effectiveCron || null,  // empty/null clears the schedule
        retention_count: retention,
      },
      {
        onSuccess: () => {
          setSavedFlash(true);
          window.setTimeout(() => setSavedFlash(false), 2000);
        },
        onError: (err) => {
          const detail = (err as { response?: { data?: { detail?: string } } })?.response?.data?.detail;
          setError(typeof detail === 'string' ? detail : 'Failed to save schedule.');
        },
      },
    );
  };

  const clear = () => {
    setError(null);
    setSavedFlash(false);
    update.mutate(
      { cron: null },
      {
        onSuccess: () => {
          setSelectedPreset('');
          setCustomCron('');
          setSavedFlash(true);
          window.setTimeout(() => setSavedFlash(false), 2000);
        },
      },
    );
  };

  return (
    <div className="rounded-lg border border-indigo-200 bg-indigo-50/60 px-3 py-2.5 space-y-2">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div className="text-[11px] font-semibold text-indigo-900">
          Schedule {schedule?.schedule_cron ? '· active' : '· off'}
        </div>
        {schedule?.next_run_at && (
          <div className="text-[11px] text-indigo-700">
            Next: <span className="font-mono">{formatNextRun(schedule.next_run_at)}</span>
          </div>
        )}
      </div>

      <div className="flex flex-col sm:flex-row gap-2">
        <select
          value={selectedPreset}
          onChange={(e) => setSelectedPreset(e.target.value)}
          className="flex-1 rounded-md border border-indigo-300 bg-white px-2 py-1 text-xs focus:outline-none focus:ring-2 focus:ring-indigo-300"
        >
          <option value="">— Off (no schedule) —</option>
          {CRON_PRESETS.map((p) => (
            <option key={p.cron} value={p.cron}>
              {p.label} ({p.describe})
            </option>
          ))}
          <option value="custom">Custom cron expression…</option>
        </select>

        {isCustom && (
          <input
            value={customCron}
            onChange={(e) => setCustomCron(e.target.value)}
            placeholder="0 3 * * *"
            className="flex-1 rounded-md border border-indigo-300 bg-white px-2 py-1 text-xs font-mono focus:outline-none focus:ring-2 focus:ring-indigo-300"
            aria-label="Custom cron expression"
          />
        )}

        <div className="flex items-center gap-1 whitespace-nowrap">
          <label className="text-[11px] text-indigo-900">Keep</label>
          <input
            type="number"
            min={1}
            max={1000}
            value={retention}
            onChange={(e) => setRetention(Math.max(1, Math.min(1000, Number(e.target.value) || 1)))}
            className="w-14 rounded-md border border-indigo-300 bg-white px-2 py-1 text-xs focus:outline-none focus:ring-2 focus:ring-indigo-300"
          />
        </div>

        <button
          onClick={save}
          disabled={update.isPending || (isCustom && !customCron.trim() && !schedule?.schedule_cron)}
          className="px-3 py-1 rounded-md bg-indigo-700 hover:bg-indigo-800 text-white text-[11px] font-medium disabled:opacity-50 disabled:cursor-not-allowed whitespace-nowrap"
        >
          {update.isPending ? 'Saving…' : 'Save schedule'}
        </button>
        {schedule?.schedule_cron && (
          <button
            onClick={clear}
            disabled={update.isPending}
            className="px-2 py-1 rounded-md border border-indigo-300 bg-white text-[11px] text-indigo-800 hover:bg-indigo-100 disabled:opacity-50"
          >
            Clear
          </button>
        )}
      </div>

      {error && (
        <p className="text-[11px] text-red-700 break-all">{error}</p>
      )}
      {savedFlash && (
        <p className="text-[11px] text-emerald-700">Saved.</p>
      )}
      <p className="text-[11px] text-indigo-800">
        All times UTC. Manual backups are never auto-deleted. Older scheduled backups beyond the keep count are pruned after each successful run.
      </p>
    </div>
  );
}

// Restore is destructive — every object in the live DB is dropped and
// recreated from the backup. The confirmation requires typing the DB
// name exactly, same UX pattern GitHub/AWS/Stripe use for "delete
// repo / drop bucket / etc."
type RestoreConfirmPayload =
  | { mode: 'in-place'; confirmDbName: string; newName?: never }
  | { mode: 'new'; newName: string; confirmDbName?: never };

function RestoreConfirm({
  primaryDb,
  onCancel,
  onConfirm,
  isPending,
}: {
  primaryDb: ManagedDatabase;
  onCancel: () => void;
  onConfirm: (payload: RestoreConfirmPayload) => void;
  isPending: boolean;
}) {
  // Default to "in-place" since it's the lightweight choice (no extra
  // pod, no doubled disk usage). The user opts into "new" deliberately.
  const [mode, setMode] = useState<'in-place' | 'new'>('in-place');
  const [typed, setTyped] = useState('');
  const [newName, setNewName] = useState(`${primaryDb.name}-restored`);

  const matches = typed.trim() === primaryDb.name;
  const newNameClean = newName.trim();
  const newNameValid = /^[A-Za-z0-9_-]+$/.test(newNameClean) && newNameClean !== primaryDb.name;
  const canSubmit = mode === 'in-place' ? matches : newNameValid;

  return (
    <div className="mt-2 rounded-md border border-amber-300 bg-amber-50 px-2 py-2 space-y-2">
      {/* Mode picker */}
      <div className="flex items-center gap-3 text-[11px]">
        <label className="flex items-center gap-1.5 cursor-pointer">
          <input
            type="radio"
            name={`restore-mode-${primaryDb.id}`}
            value="in-place"
            checked={mode === 'in-place'}
            onChange={() => setMode('in-place')}
          />
          <span className="text-amber-900">In place (replace live data)</span>
        </label>
        <label className="flex items-center gap-1.5 cursor-pointer">
          <input
            type="radio"
            name={`restore-mode-${primaryDb.id}`}
            value="new"
            checked={mode === 'new'}
            onChange={() => setMode('new')}
          />
          <span className="text-amber-900">To a new database (keeps original)</span>
        </label>
      </div>

      {mode === 'in-place' && (
        <>
          <p className="text-[11px] text-amber-900">
            <span className="font-semibold">Destructive:</span> drops every object in{' '}
            <span className="font-mono">{primaryDb.name}</span> and recreates it from the backup.
            Click <span className="font-semibold">Backup now</span> first if you want a rollback point.
          </p>
          <div className="flex items-center gap-2 flex-wrap">
            <p className="text-[11px] text-amber-900 whitespace-nowrap">
              Type <span className="font-mono font-semibold">{primaryDb.name}</span> to confirm:
            </p>
            <input
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              placeholder={primaryDb.name}
              className="flex-1 min-w-[140px] rounded-md border border-amber-300 bg-white px-2 py-1 text-[11px] font-mono focus:outline-none focus:ring-2 focus:ring-amber-300"
              autoFocus
            />
          </div>
        </>
      )}

      {mode === 'new' && (
        <>
          <p className="text-[11px] text-amber-900">
            Creates a fresh pod alongside <span className="font-mono">{primaryDb.name}</span> and restores into it.
            Nothing existing is touched. <span className="font-semibold">Runs 2× resources</span> until you delete one.
          </p>
          <div className="flex items-center gap-2 flex-wrap">
            <p className="text-[11px] text-amber-900 whitespace-nowrap">New database name:</p>
            <input
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              placeholder={`${primaryDb.name}-restored`}
              className="flex-1 min-w-[140px] rounded-md border border-amber-300 bg-white px-2 py-1 text-[11px] font-mono focus:outline-none focus:ring-2 focus:ring-amber-300"
              autoFocus
            />
          </div>
          {!newNameValid && newNameClean !== '' && (
            <p className="text-[11px] text-red-700">
              Must contain only letters/numbers/dashes/underscores, and differ from the source name.
            </p>
          )}
        </>
      )}

      <div className="flex items-center gap-2">
        <button
          onClick={() =>
            onConfirm(
              mode === 'in-place'
                ? { mode: 'in-place', confirmDbName: typed.trim() }
                : { mode: 'new', newName: newNameClean },
            )
          }
          disabled={!canSubmit || isPending}
          className="px-2 py-1 rounded-md bg-amber-700 hover:bg-amber-800 text-white text-[11px] font-medium disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {isPending
            ? mode === 'new' ? 'Creating + restoring…' : 'Restoring…'
            : mode === 'new' ? 'Create + restore' : 'Restore now'}
        </button>
        <button
          onClick={onCancel}
          disabled={isPending}
          className="px-2 py-1 rounded-md border border-amber-400 bg-white text-[11px] text-amber-900 disabled:opacity-50"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

function BackupStatusBadge({ status }: { status: ManagedDbBackup['status'] }) {
  const map: Record<ManagedDbBackup['status'], string> = {
    running: 'bg-blue-50 text-blue-700 border-blue-200',
    ready: 'bg-emerald-50 text-emerald-700 border-emerald-200',
    failed: 'bg-red-50 text-red-700 border-red-200',
  };
  return (
    <span className={`text-[10px] px-1.5 py-0.5 rounded-full border font-medium ${map[status]}`}>
      {status}
    </span>
  );
}

function ReplicaRoleBadge({ role }: { role: ManagedDbReplica['role'] }) {
  if (role === 'promoted') {
    return (
      <span className="text-[10px] px-1.5 py-0.5 rounded-full border font-medium bg-amber-100 text-amber-900 border-amber-300">
        new primary
      </span>
    );
  }
  return (
    <span className="text-[10px] px-1.5 py-0.5 rounded-full border font-medium bg-slate-100 text-slate-600 border-slate-200">
      standby
    </span>
  );
}

/* ---------------------------------------------------------------- create modal */

function CreateModal({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (resp: ManagedDatabaseCreateResponse) => void;
}) {
  const { data: engines } = useManagedDbEngines();
  const { data: projects } = useProjects();
  const [name, setName] = useState('');
  const [engineId, setEngineId] = useState<string>('postgres');
  const [version, setVersion] = useState<string>('16');
  const [databaseName, setDatabaseName] = useState('appdb');
  const [username, setUsername] = useState('watchtower');
  const [linkProjectId, setLinkProjectId] = useState<string>('');
  const [linkEnvVar, setLinkEnvVar] = useState<string>('DATABASE_URL');
  const [autoBackup, setAutoBackup] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);

  const create = useCreateManagedDatabase();
  const engine = engines?.find((e) => e.id === engineId);

  // When the engine changes, snap the version + defaults to that engine's
  // values. Avoids "MySQL 17" being submitted.
  const onEngineChange = (id: string) => {
    setEngineId(id);
    const next = engines?.find((e) => e.id === id);
    if (next) {
      setVersion(next.versions[0]);
      setDatabaseName(next.default_db_name);
      setUsername(next.default_user);
    }
  };

  const isRedis = engineId === 'redis';

  const submit = () => {
    if (!name.trim()) {
      setError('Name is required.');
      return;
    }
    setError(null);
    create.mutate(
      {
        name: name.trim(),
        engine: engineId,
        version,
        database_name: isRedis ? 'appdb' : databaseName,
        username: isRedis ? 'watchtower' : username,
        // Plug-and-play: when a project is chosen, wire the connection
        // string straight into its deploy env as link_env_var_name.
        link_project_id: linkProjectId || undefined,
        link_env_var_name: linkProjectId ? (linkEnvVar.trim() || 'DATABASE_URL') : undefined,
        // Data safety: protect the DB from day one with a daily backup.
        auto_backup: autoBackup,
      },
      {
        onSuccess: onCreated,
        onError: (err) => {
          const detail = (err as { response?: { data?: { detail?: string } } })?.response?.data?.detail;
          setError(typeof detail === 'string' ? detail : 'Could not create database.');
        },
      },
    );
  };

  return (
    <Modal onClose={onClose}>
      <h2 className="text-base font-semibold text-slate-900">Create managed database</h2>
      <p className="text-xs text-slate-600 mt-1">
        A new container will run on this PC in a Podman pod with a persistent volume.
      </p>

      <div className="mt-4 space-y-3">
        <Field label="Name" hint="Used in the UI. Letters, numbers, dashes, underscores.">
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="blog-prod"
            className="w-full rounded-lg border border-border bg-white px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-red-300"
          />
        </Field>

        <div className="grid grid-cols-2 gap-3">
          <Field label="Engine">
            <select
              value={engineId}
              onChange={(e) => onEngineChange(e.target.value)}
              className="w-full rounded-lg border border-border bg-white px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-red-300"
            >
              {(engines ?? [{ id: 'postgres', name: 'PostgreSQL', versions: ['16'], default_db_name: 'appdb', default_user: 'watchtower' }]).map((e) => (
                <option key={e.id} value={e.id}>
                  {e.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Version">
            <select
              value={version}
              onChange={(e) => setVersion(e.target.value)}
              className="w-full rounded-lg border border-border bg-white px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-red-300"
            >
              {(engine?.versions ?? [version]).map((v) => (
                <option key={v} value={v}>
                  {v}
                </option>
              ))}
            </select>
          </Field>
        </div>

        {!isRedis && (
          <div className="grid grid-cols-2 gap-3">
            <Field label="Database name">
              <input
                value={databaseName}
                onChange={(e) => setDatabaseName(e.target.value)}
                className="w-full rounded-lg border border-border bg-white px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-red-300"
              />
            </Field>
            <Field label="Username">
              <input
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                className="w-full rounded-lg border border-border bg-white px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-red-300"
              />
            </Field>
          </div>
        )}

        {isRedis && (
          <p className="text-[11px] text-slate-500">
            Redis only uses a password for authentication — no database name or username needed.
          </p>
        )}

        {/* Plug-and-play: optionally wire the connection string straight into
            a project's deploy env so there's no separate "link" step. */}
        <div className="pt-1 border-t border-border-soft">
          <Field
            label="Connect to a project (optional)"
            hint="Auto-injects the connection string into that project's deploy environment."
          >
            <select
              value={linkProjectId}
              onChange={(e) => setLinkProjectId(e.target.value)}
              className="w-full rounded-lg border border-border bg-white px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
            >
              <option value="">Don't connect — just create the database</option>
              {(projects ?? []).map((p) => (
                <option key={p.id} value={p.id}>{p.name}</option>
              ))}
            </select>
          </Field>
          {linkProjectId && (
            <div className="mt-2">
              <Field label="Inject as env var" hint="The project reads this on deploy.">
                <input
                  value={linkEnvVar}
                  onChange={(e) => setLinkEnvVar(e.target.value)}
                  placeholder="DATABASE_URL"
                  className="w-full rounded-lg border border-border bg-white px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-ring"
                />
              </Field>
            </div>
          )}
        </div>

        {/* Data safety: default a daily backup on so the DB is protected from
            day one. Off by hand if the user really wants no backups. */}
        <label className="flex items-start gap-2.5 pt-1 cursor-pointer">
          <input
            type="checkbox"
            checked={autoBackup}
            onChange={(e) => setAutoBackup(e.target.checked)}
            className="mt-0.5 h-4 w-4 rounded border-border accent-[hsl(var(--primary))]"
          />
          <span className="text-xs text-foreground">
            Back up automatically
            <span className="text-muted-foreground"> — daily at 03:00 UTC, keeping the last 7. You can change this later.</span>
          </span>
        </label>
      </div>

      {error && (
        <div className="mt-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700 break-all">
          {error}
        </div>
      )}

      <div className="mt-5 flex items-center justify-end gap-2">
        <button
          onClick={onClose}
          disabled={create.isPending}
          className="px-3 py-1.5 rounded-lg border border-border text-xs text-slate-700 hover:bg-slate-100 transition-colors disabled:opacity-50"
        >
          Cancel
        </button>
        <button
          onClick={submit}
          disabled={create.isPending}
          className="px-4 py-1.5 rounded-lg bg-primary hover:bg-primary/90 text-white text-xs font-medium border border-border shadow-retro disabled:opacity-50"
        >
          {create.isPending ? 'Creating…' : 'Create database'}
        </button>
      </div>
    </Modal>
  );
}

/* ---------------------------------------------------------------- credentials modal */

function CredentialsModal({
  response,
  onClose,
}: {
  response: ManagedDatabaseCreateResponse | (ManagedDatabase & { password: string; connection_string: string });
  onClose: () => void;
}) {
  const [copied, setCopied] = useState<string | null>(null);
  const test = useTestManagedDbConnection();
  const [testResult, setTestResult] = useState<{ ok: boolean; message: string } | null>(null);
  const copy = async (text: string, key: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(key);
      window.setTimeout(() => setCopied(null), 1500);
    } catch {
      /* ignore */
    }
  };

  const runTest = () => {
    setTestResult(null);
    test.mutate(response.id, {
      onSuccess: (r) => setTestResult(r),
      onError: () => setTestResult({ ok: false, message: 'Could not run the connection test.' }),
    });
  };

  return (
    <Modal onClose={onClose}>
      <h2 className="text-base font-semibold text-slate-900">
        Credentials — <span className="font-mono">{response.name}</span>
      </h2>
      <p className="text-xs text-slate-600 mt-1">
        Save these somewhere safe. The connection string is the easiest way to plug into your app.
      </p>

      <div className="mt-4 space-y-3">
        <CredField label="Connection string" value={response.connection_string}
          copied={copied === 'conn'} onCopy={() => copy(response.connection_string, 'conn')} />
        <CredField label="Password" value={response.password}
          copied={copied === 'pw'} onCopy={() => copy(response.password, 'pw')} mono />
        <div className="grid grid-cols-2 gap-3 text-xs">
          <div>
            <p className="text-slate-500">Host</p>
            <p className="font-mono text-slate-800">{response.host}</p>
          </div>
          <div>
            <p className="text-slate-500">Port</p>
            <p className="font-mono text-slate-800">{response.port}</p>
          </div>
          <div>
            <p className="text-slate-500">Database</p>
            <p className="font-mono text-slate-800">{response.database_name}</p>
          </div>
          <div>
            <p className="text-slate-500">Username</p>
            <p className="font-mono text-slate-800">{response.username}</p>
          </div>
        </div>
      </div>

      {/* Test connection — confirms the DB is reachable right after create. */}
      {testResult && (
        <div
          className={`mt-4 rounded-lg border px-3 py-2 text-xs ${
            testResult.ok
              ? 'border-emerald-200 bg-emerald-50 text-emerald-700'
              : 'border-red-200 bg-red-50 text-red-700'
          }`}
        >
          {testResult.ok ? '✓ ' : '✗ '}{testResult.message}
        </div>
      )}

      <div className="mt-5 flex items-center justify-between gap-2">
        <button
          onClick={runTest}
          disabled={test.isPending}
          className="px-4 py-1.5 rounded-lg border border-border bg-white text-xs font-medium text-foreground hover:bg-muted transition-colors disabled:opacity-50"
        >
          {test.isPending ? 'Testing…' : 'Test connection'}
        </button>
        <button
          onClick={onClose}
          className="px-4 py-1.5 rounded-lg bg-primary hover:bg-primary/90 text-white text-xs font-medium border border-border shadow-retro"
        >
          Done
        </button>
      </div>
    </Modal>
  );
}

/* ---------------------------------------------------------------- primitives */

function Modal({ children, onClose }: { children: React.ReactNode; onClose: () => void }) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="bg-white rounded-2xl border border-border shadow-xl p-6 max-w-lg w-full mx-4"
        onClick={(e) => e.stopPropagation()}
      >
        {children}
      </div>
    </div>
  );
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <span className="text-xs font-medium text-slate-700">{label}</span>
      {children}
      {hint && <p className="text-[11px] text-slate-500 mt-1">{hint}</p>}
    </label>
  );
}

function CredField({
  label,
  value,
  copied,
  onCopy,
  mono,
}: {
  label: string;
  value: string;
  copied: boolean;
  onCopy: () => void;
  mono?: boolean;
}) {
  return (
    <div>
      <p className="text-[11px] uppercase tracking-wide text-slate-500 font-semibold mb-1">
        {label}
      </p>
      <div className="flex items-stretch gap-2">
        <code
          className={`flex-1 rounded-lg border border-border bg-slate-50 px-3 py-2 text-xs ${mono ? 'font-mono' : ''} break-all`}
        >
          {value}
        </code>
        <button
          onClick={onCopy}
          className="px-3 rounded-lg border border-border bg-white text-xs text-slate-700 hover:bg-slate-100 transition-colors"
        >
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
    </div>
  );
}

function StatusBadge({ status }: { status: ManagedDatabase['status'] }) {
  const map: Record<ManagedDatabase['status'], string> = {
    creating: 'bg-blue-50 text-blue-700 border-blue-200',
    running: 'bg-emerald-50 text-emerald-700 border-emerald-200',
    stopped: 'bg-slate-100 text-slate-600 border-slate-200',
    failed: 'bg-red-50 text-red-700 border-red-200',
    deleting: 'bg-amber-50 text-amber-800 border-amber-200',
  };
  return (
    <span className={`text-[11px] px-2 py-0.5 rounded-full border font-medium ${map[status]}`}>
      {status}
    </span>
  );
}
