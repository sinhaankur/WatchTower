import { useState } from 'react';
import { Link } from 'react-router-dom';
import { toast } from '@/lib/toast';
import {
  usePodmanStatus,
  usePodmanContainers,
  useCreatePodmanContainer,
  usePodmanContainerAction,
  type PodmanPort,
} from '@/hooks/queries';

/**
 * Services — genuinely one-click now. Each catalogue entry carries a
 * real image + port mapping; "Run locally" creates and starts the
 * container through /api/podman (same engine as the Containers page),
 * and running services show an Open button instead of empty promises.
 *
 * Multi-container stacks (Plausible, Rocket.Chat need their own DB)
 * stay honest: they route to the Setup Wizard instead of pretending a
 * single container will work.
 */

type ServiceDef = {
  slug: string;
  name: string;
  category: string;
  desc: string;
  tone: string;             // avatar bg
  image?: string;           // one-click image; absent ⇒ wizard-only
  ports?: PodmanPort[];     // host → container
  openPort?: number;        // which host port the Open button uses
  env?: Record<string, string>;
};

const SERVICES: ServiceDef[] = [
  {
    slug: 'meilisearch', name: 'Meilisearch', category: 'Search', tone: 'bg-pink-100 text-pink-700',
    desc: 'Lightning-fast full-text search engine for your apps.',
    image: 'docker.io/getmeili/meilisearch:latest',
    ports: [{ host: 7700, container: 7700 }], openPort: 7700,
  },
  {
    slug: 'mailpit', name: 'Mailpit', category: 'Dev Tools', tone: 'bg-sky-100 text-sky-700',
    desc: 'Email testing and capture for local development.',
    image: 'docker.io/axllent/mailpit:latest',
    ports: [{ host: 8025, container: 8025 }, { host: 1025, container: 1025 }], openPort: 8025,
  },
  {
    slug: 'grafana', name: 'Grafana', category: 'Monitoring', tone: 'bg-orange-100 text-orange-700',
    desc: 'Beautiful, flexible metrics and log dashboards.',
    image: 'docker.io/grafana/grafana-oss:latest',
    ports: [{ host: 3300, container: 3000 }], openPort: 3300,
  },
  {
    slug: 'prometheus', name: 'Prometheus', category: 'Monitoring', tone: 'bg-red-100 text-red-700',
    desc: 'Metrics collection, alerting, and time-series data.',
    image: 'docker.io/prom/prometheus:latest',
    ports: [{ host: 9090, container: 9090 }], openPort: 9090,
  },
  {
    slug: 'minio', name: 'MinIO', category: 'Storage', tone: 'bg-rose-100 text-rose-700',
    desc: 'S3-compatible self-hosted object storage.',
    image: 'docker.io/minio/minio:latest',
    ports: [{ host: 9000, container: 9000 }, { host: 9001, container: 9001 }], openPort: 9001,
    env: { MINIO_ROOT_USER: 'admin', MINIO_ROOT_PASSWORD: 'watchtower' },
  },
  {
    slug: 'vaultwarden', name: 'Vaultwarden', category: 'Security', tone: 'bg-violet-100 text-violet-700',
    desc: 'Bitwarden-compatible self-hosted password manager.',
    image: 'docker.io/vaultwarden/server:latest',
    ports: [{ host: 8222, container: 80 }], openPort: 8222,
  },
  {
    slug: 'gitea', name: 'Gitea', category: 'Dev Tools', tone: 'bg-emerald-100 text-emerald-700',
    desc: 'Lightweight self-hosted Git service and CI.',
    image: 'docker.io/gitea/gitea:latest',
    ports: [{ host: 3030, container: 3000 }], openPort: 3030,
  },
  {
    slug: 'plausible', name: 'Plausible', category: 'Analytics', tone: 'bg-indigo-100 text-indigo-700',
    desc: 'Privacy-friendly web analytics. Needs its own Postgres + ClickHouse — use the Setup Wizard.',
  },
  {
    slug: 'rocketchat', name: 'Rocket.Chat', category: 'Comms', tone: 'bg-cyan-100 text-cyan-700',
    desc: 'Open-source team messaging. Needs MongoDB — use the Setup Wizard.',
  },
];

const containerNameFor = (slug: string) => `wt-svc-${slug}`;

function extractDetail(err: unknown, fallback: string): string {
  return (err as { response?: { data?: { detail?: string } } })?.response?.data?.detail ?? fallback;
}

function ServiceCard({ svc, connected }: { svc: ServiceDef; connected: boolean }) {
  const { data: containers } = usePodmanContainers(connected);
  const create = useCreatePodmanContainer();
  const act = usePodmanContainerAction();
  const [busy, setBusy] = useState(false);

  const existing = (containers ?? []).find((c) => c.name === containerNameFor(svc.slug));
  const running = existing && (existing.state || '').toLowerCase().includes('running');

  const runNow = async () => {
    if (!svc.image) return;
    setBusy(true);
    try {
      if (existing && !running) {
        await act.mutateAsync({ name: existing.name, action: 'start' });
        toast.success(`${svc.name} started`);
      } else {
        await create.mutateAsync({
          name: containerNameFor(svc.slug),
          image: svc.image,
          ports: svc.ports,
          env: svc.env,
        });
        toast.success(`${svc.name} is starting — first run pulls the image, give it a moment`);
      }
    } catch (e) {
      toast.error(extractDetail(e, `Could not start ${svc.name}`));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="p-4 rounded-xl border border-border bg-muted/20 hover:border-slate-300 transition-all flex flex-col">
      <div className="flex items-start justify-between gap-2 mb-2">
        <div className="flex items-center gap-2.5">
          <span className={`w-8 h-8 rounded-lg border border-border flex items-center justify-center text-sm font-bold ${svc.tone}`}>
            {svc.name[0]}
          </span>
          <p className="text-sm font-semibold text-slate-900">{svc.name}</p>
        </div>
        <span className="text-[10px] px-1.5 py-0.5 rounded bg-slate-100 text-slate-500 border border-border shrink-0">{svc.category}</span>
      </div>
      <p className="text-xs text-slate-600 flex-1">{svc.desc}</p>

      <div className="mt-3 flex items-center gap-2">
        {!svc.image ? (
          <Link to="/setup" className="text-xs px-3 py-1.5 rounded-lg border border-slate-300 text-slate-700 hover:border-slate-500">
            Open Setup Wizard →
          </Link>
        ) : running ? (
          <>
            <span className="text-[10px] px-1.5 py-0.5 rounded border text-emerald-700 bg-emerald-50 border-emerald-200">Running</span>
            {svc.openPort && (
              <a
                href={`http://localhost:${svc.openPort}`}
                target="_blank" rel="noopener noreferrer"
                className="text-xs px-3 py-1.5 rounded-lg border border-border bg-amber-400 hover:bg-amber-500 text-slate-900 font-semibold shadow-retro"
              >
                Open ↗
              </a>
            )}
            <Link to="/local-containers" className="text-xs text-slate-500 hover:text-slate-800 underline ml-auto">
              manage
            </Link>
          </>
        ) : (
          <button
            onClick={() => void runNow()}
            disabled={busy || !connected}
            title={connected ? `podman run ${svc.image}` : 'Start Podman first (Containers page)'}
            className="text-xs px-3 py-1.5 rounded-lg border border-border bg-amber-400 hover:bg-amber-500 text-slate-900 font-semibold shadow-retro disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {busy ? 'Starting…' : existing ? 'Start' : 'Run locally'}
          </button>
        )}
        {svc.image && !running && svc.openPort && (
          <span className="text-[10px] text-slate-400 font-mono ml-auto">:{svc.openPort}</span>
        )}
      </div>
    </div>
  );
}

const Services = () => {
  const { data: podman } = usePodmanStatus();
  const connected = Boolean(podman?.connected);

  return (
    <div className="flex-1 overflow-auto bg-slate-50">
      <header
        className="px-4 sm:px-6 lg:px-8 py-4 flex items-center justify-between border-b sticky top-0 z-10 bg-white/95 backdrop-blur-sm"
        style={{ borderColor: 'hsl(var(--border-soft))' }}
      >
        <div>
          <h1 className="text-lg font-semibold text-slate-900">Services</h1>
          <p className="text-xs text-slate-600 mt-0.5 hidden sm:block">One-click self-hosted services, run on this machine via Podman</p>
        </div>
        <span className="text-xs text-slate-500 bg-slate-100 px-2 py-1 rounded-full border border-border">{SERVICES.length} available</span>
      </header>

      <main className="px-4 sm:px-6 lg:px-8 py-6 max-w-5xl mx-auto w-full space-y-6">
        {!connected && (
          <div className="rounded-xl border border-amber-300 bg-amber-50 p-4">
            <p className="text-sm font-semibold text-amber-900">Podman isn't running</p>
            <p className="text-xs text-amber-800 mt-0.5">
              One-click services run as local Podman containers. Head to the{' '}
              <Link to="/local-containers" className="underline font-medium">Containers page</Link>{' '}
              and click <strong>Start Podman</strong>, then come back here.
            </p>
          </div>
        )}

        <div className="rounded-xl border border-border bg-card p-5">
          <div className="flex items-center justify-between mb-1">
            <h2 className="text-sm font-semibold text-slate-900">Available Services</h2>
          </div>
          <p className="text-xs text-slate-500 mb-4">
            "Run locally" pulls the image and starts it on this machine — try anything in one click.
            Containers are managed on the <Link to="/local-containers" className="underline">Containers page</Link>;
            for a production deploy to a server, use the <Link to="/setup" className="underline">Setup Wizard</Link>.
          </p>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
            {SERVICES.map((svc) => (
              <ServiceCard key={svc.slug} svc={svc} connected={connected} />
            ))}
          </div>
        </div>
      </main>
    </div>
  );
};

export default Services;
