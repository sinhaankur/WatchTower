import { Link } from 'react-router-dom';

const SERVICES = [
  { icon: '🔍', name: 'Meilisearch',   category: 'Search',   desc: 'Lightning-fast full-text search engine for your apps.' },
  { icon: '📧', name: 'Mailpit',       category: 'Dev Tools', desc: 'Email testing and capture for local development.' },
  { icon: '📊', name: 'Grafana',       category: 'Monitoring', desc: 'Beautiful, flexible metrics and log dashboards.' },
  { icon: '📈', name: 'Prometheus',    category: 'Monitoring', desc: 'Metrics collection, alerting, and time-series data.' },
  { icon: '🗂', name: 'MinIO',         category: 'Storage',   desc: 'S3-compatible self-hosted object storage.' },
  { icon: '🔐', name: 'Vaultwarden',  category: 'Security',  desc: 'Bitwarden-compatible self-hosted password manager.' },
  { icon: '🖼', name: 'Gitea',         category: 'Dev Tools', desc: 'Lightweight self-hosted Git service and CI.' },
  { icon: '📝', name: 'Plausible',     category: 'Analytics', desc: 'Privacy-friendly web analytics without tracking.' },
  { icon: '💬', name: 'Rocket.Chat',   category: 'Comms',    desc: 'Open-source team messaging and collaboration.' },
];

const Services = () => (
  <div className="flex-1 overflow-auto bg-slate-50">
    <header
      className="px-4 sm:px-6 lg:px-8 py-4 flex items-center justify-between border-b sticky top-0 z-10 bg-white/95 backdrop-blur-sm"
      style={{ borderColor: 'hsl(214 32% 88%)' }}
    >
      <div>
        <h1 className="text-lg font-semibold text-slate-900">Services</h1>
        <p className="text-xs text-slate-600 mt-0.5 hidden sm:block">One-click self-hosted services</p>
      </div>
      <span className="text-xs text-slate-500 bg-slate-100 px-2 py-1 rounded-full border border-border">{SERVICES.length} available</span>
    </header>

    <main className="px-4 sm:px-6 lg:px-8 py-6 max-w-5xl mx-auto w-full space-y-6">
      {/* Info banner */}
      <div className="rounded-xl border border-blue-200 bg-blue-50 p-4 flex items-start gap-3">
        <span className="text-lg shrink-0">📦</span>
        <div>
          <p className="text-sm font-semibold text-slate-900">Deploy any service via Docker</p>
          <p className="text-xs text-slate-600 mt-0.5">
            Each service below runs as a Docker container. Use the <Link to="/setup" className="text-red-700 underline">Setup Wizard</Link> with <strong>Docker App</strong> type and paste the service's Docker image to deploy it on your server.
          </p>
        </div>
      </div>

      <div className="rounded-xl border border-border bg-card p-5">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-sm font-semibold text-slate-900">Available Services</h2>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
          {SERVICES.map(({ icon, name, category, desc }) => (
            <Link key={name} to="/setup"
              className="p-4 rounded-xl border border-border bg-muted/20 hover:border-red-300 hover:bg-red-50/40 transition-all cursor-pointer group">
              <div className="flex items-start justify-between gap-2 mb-2">
                <div className="flex items-center gap-2">
                  <span className="text-2xl">{icon}</span>
                  <p className="text-sm font-semibold text-slate-900">{name}</p>
                </div>
                <span className="text-[10px] px-1.5 py-0.5 rounded bg-slate-100 text-slate-500 border border-border shrink-0">{category}</span>
              </div>
              <p className="text-xs text-slate-600">{desc}</p>
              <p className="text-xs text-red-700 mt-3 opacity-0 group-hover:opacity-100 transition-opacity">
                Deploy now →
              </p>
            </Link>
          ))}
        </div>
      </div>
    </main>
  </div>
);

export default Services;
