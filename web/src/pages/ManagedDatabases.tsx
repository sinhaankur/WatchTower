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

import { useState } from 'react';
import {
  BackupDiagram,
  ExternalDbDiagram,
  ManagedDbDiagram,
  ReplicationDiagram,
} from '@/components/SectionDiagrams';
import {
  type ExternalDatabase,
  type ManagedDatabase,
  type ManagedDatabaseCreateResponse,
  type ManagedDbBackup,
  type ManagedDbReplica,
  useAddReplica,
  useCreateBackup,
  useCreateExternalDatabase,
  useCreateManagedDatabase,
  useDeleteBackup,
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
  useStartManagedDatabase,
  useStopManagedDatabase,
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
              className="px-3 sm:px-4 py-1.5 rounded-lg bg-red-700 hover:bg-red-800 text-white text-xs sm:text-sm font-medium transition-colors border border-slate-800 shadow-[2px_2px_0_0_#1f2937] disabled:opacity-50 disabled:cursor-not-allowed"
              title={runtime?.available ? '' : 'Install Podman or Docker first'}
            >
              + New Database
            </button>
          ) : (
            <button
              onClick={() => setShowCreateExternal(true)}
              className="px-3 sm:px-4 py-1.5 rounded-lg bg-red-700 hover:bg-red-800 text-white text-xs sm:text-sm font-medium transition-colors border border-slate-800 shadow-[2px_2px_0_0_#1f2937]"
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
          ? 'border-red-700 text-red-700'
          : 'border-transparent text-slate-600 hover:text-slate-900'
      }`}
    >
      {children}
    </button>
  );
}

function ManagedTabContent({
  runtime,
  data,
  isLoading,
}: {
  runtime: { available: boolean } | undefined;
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
              className="px-3 py-1 rounded-md bg-red-700 hover:bg-red-800 text-white text-xs font-medium disabled:opacity-50"
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
          className="px-4 py-1.5 rounded-lg bg-red-700 hover:bg-red-800 text-white text-xs font-medium border border-slate-800 shadow-[2px_2px_0_0_#1f2937]"
        >
          Done
        </button>
      </div>
    </Modal>
  );
}

function CreateExternalModal({ onClose }: { onClose: () => void }) {
  const { data: engines } = useManagedDbEngines();
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

  return (
    <Modal onClose={onClose}>
      <h2 className="text-base font-semibold text-slate-900">Connect external database</h2>
      <p className="text-xs text-slate-600 mt-1">
        Point WatchTower at a database you already run. Credentials are encrypted at rest.
      </p>

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
          className="px-4 py-1.5 rounded-lg bg-red-700 hover:bg-red-800 text-white text-xs font-medium border border-slate-800 shadow-[2px_2px_0_0_#1f2937] disabled:opacity-50"
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
            className="px-3 py-1.5 rounded-lg bg-emerald-700 hover:bg-emerald-800 text-white text-xs font-medium border border-slate-800 shadow-[2px_2px_0_0_#1f2937] disabled:opacity-50"
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
              className="px-3 py-1 rounded-md bg-red-700 hover:bg-red-800 text-white text-xs font-medium disabled:opacity-50"
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
// HA v1: lets the user spin up a standby pod and (when needed) promote
// it to primary. Postgres-only in v1; other engines still show the card
// gated above (`db.engine === 'postgres'`).

function ReplicasSection({ primaryDb }: { primaryDb: ManagedDatabase }) {
  const [open, setOpen] = useState(false);
  const { data: replicas, isLoading } = useManagedDbReplicas(primaryDb.id, open);
  const add = useAddReplica(primaryDb.id);
  const [error, setError] = useState<string | null>(null);

  const handleErr = (err: unknown) => {
    const detail = (err as { response?: { data?: { detail?: string } } })?.response?.data?.detail;
    setError(typeof detail === 'string' ? detail : 'Action failed.');
  };

  const onAdd = () => {
    setError(null);
    add.mutate({}, { onError: handleErr });
  };

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
              Postgres streaming replication. Standbys run as separate pods on this PC and stream WAL from the primary.
            </p>
            <button
              onClick={onAdd}
              disabled={add.isPending || primaryDb.status !== 'running'}
              className="px-3 py-1 rounded-md bg-red-700 hover:bg-red-800 text-white text-[11px] font-medium border border-slate-800 shadow-[2px_2px_0_0_#1f2937] disabled:opacity-50 disabled:cursor-not-allowed"
              title={primaryDb.status !== 'running' ? 'Primary must be running' : ''}
            >
              {add.isPending ? 'Provisioning…' : '+ Add standby'}
            </button>
          </div>

          {error && (
            <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700 break-all">
              {error}
            </div>
          )}

          {isLoading && <p className="text-xs text-slate-500">Loading replicas…</p>}

          {replicas && replicas.length === 0 && (
            <p className="text-xs text-slate-500 italic">
              No replicas yet. Add one to get a hot standby.
            </p>
          )}

          {replicas && replicas.length > 0 && (
            <div className="space-y-2">
              {replicas.map((r) => (
                <ReplicaRow
                  key={r.id}
                  primaryDb={primaryDb}
                  replica={r}
                />
              ))}
            </div>
          )}
        </div>
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
          <span className="text-[11px] text-slate-500 font-mono">{replica.host}:{replica.port}</span>
        </div>
        <div className="flex items-center gap-1">
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
              className="px-2 py-1 rounded-md bg-red-700 hover:bg-red-800 text-white text-[11px] font-medium disabled:opacity-50"
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
          <div className="flex items-start justify-between gap-3 flex-wrap">
            <p className="text-[11px] text-slate-500 max-w-md">
              On-demand <code className="font-mono">pg_dump</code> snapshots stored under{' '}
              <code className="font-mono">~/.watchtower/managed_db_backups/</code>. Custom-format
              so a future Restore feature can use <code className="font-mono">pg_restore</code>.
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
              className="px-3 py-1.5 rounded-md bg-red-700 hover:bg-red-800 text-white text-[11px] font-medium border border-slate-800 shadow-[2px_2px_0_0_#1f2937] disabled:opacity-50 disabled:cursor-not-allowed whitespace-nowrap"
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
  const [confirm, setConfirm] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
        <button
          onClick={() => setConfirm(true)}
          disabled={del.isPending}
          className="px-2 py-1 rounded-md border border-red-200 text-[11px] text-red-700 hover:bg-red-50 transition-colors disabled:opacity-50"
        >
          Delete
        </button>
      </div>
      {backup.status_message && (
        <p className="text-[11px] text-red-600 mt-1 break-all">{backup.status_message}</p>
      )}
      {error && (
        <p className="text-[11px] text-red-600 mt-1 break-all">{error}</p>
      )}
      {confirm && (
        <div className="mt-2 rounded-md border border-red-200 bg-red-50 px-2 py-1.5 flex items-center gap-2 flex-wrap">
          <p className="text-[11px] text-red-900 flex-1 min-w-0">Delete this backup file?</p>
          <button
            onClick={() => {
              setError(null);
              del.mutate(backup.id, {
                onSuccess: () => setConfirm(false),
                onError: (err) => {
                  const detail = (err as { response?: { data?: { detail?: string } } })?.response?.data?.detail;
                  setError(typeof detail === 'string' ? detail : 'Failed to delete backup.');
                },
              });
            }}
            disabled={del.isPending}
            className="px-2 py-1 rounded-md bg-red-700 hover:bg-red-800 text-white text-[11px] font-medium disabled:opacity-50"
          >
            {del.isPending ? 'Deleting…' : 'Confirm'}
          </button>
          <button
            onClick={() => setConfirm(false)}
            disabled={del.isPending}
            className="px-2 py-1 rounded-md border border-red-300 bg-white text-[11px] text-red-800 disabled:opacity-50"
          >
            Cancel
          </button>
        </div>
      )}
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
  const [name, setName] = useState('');
  const [engineId, setEngineId] = useState<string>('postgres');
  const [version, setVersion] = useState<string>('16');
  const [databaseName, setDatabaseName] = useState('appdb');
  const [username, setUsername] = useState('watchtower');
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
          className="px-4 py-1.5 rounded-lg bg-red-700 hover:bg-red-800 text-white text-xs font-medium border border-slate-800 shadow-[2px_2px_0_0_#1f2937] disabled:opacity-50"
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

      <div className="mt-5 flex items-center justify-end">
        <button
          onClick={onClose}
          className="px-4 py-1.5 rounded-lg bg-red-700 hover:bg-red-800 text-white text-xs font-medium border border-slate-800 shadow-[2px_2px_0_0_#1f2937]"
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
