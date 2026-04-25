const SERVICES = [
  { icon: '🔍', name: 'Meilisearch',    desc: 'Lightning-fast search engine.' },
  { icon: '📧', name: 'Mailpit',        desc: 'Email testing for development.' },
  { icon: '📊', name: 'Grafana',        desc: 'Beautiful metrics dashboards.' },
  { icon: '📈', name: 'Prometheus',     desc: 'Metrics collection and alerting.' },
  { icon: '🗂', name: 'MinIO',          desc: 'S3-compatible object storage.' },
  { icon: '🔐', name: 'Vaultwarden',   desc: 'Bitwarden-compatible password manager.' },
  { icon: '🖼', name: 'Gitea',          desc: 'Lightweight self-hosted Git service.' },
  { icon: '📝', name: 'Plausible',      desc: 'Privacy-friendly web analytics.' },
  { icon: '💬', name: 'Rocket.Chat',    desc: 'Open-source team messaging.' },
];

const Services = () => (
  <div className="flex-1 overflow-auto bg-slate-50">
    <header
      className="px-8 py-5 flex items-center justify-between border-b"
      style={{ borderColor: 'hsl(214 32% 88%)' }}
    >
      <div>
        <h1 className="text-lg font-semibold text-slate-900">Services</h1>
        <p className="text-xs text-slate-600 mt-0.5">One-click self-hosted services</p>
      </div>
    </header>

    <main className="px-8 py-6 max-w-5xl">
      <div className="rounded-xl border border-border bg-card p-5">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-sm font-semibold text-slate-900">Available Services</h2>
          <span className="text-xs text-slate-600">{SERVICES.length}+ services</span>
        </div>
        <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-3">
          {SERVICES.map(({ icon, name, desc }) => (
            <div key={name}
              className="p-4 rounded-xl border border-border bg-muted/20 hover:border-red-300 hover:bg-red-50/40 transition-all cursor-pointer group">
              <div className="flex items-center gap-2 mb-2">
                <span className="text-2xl">{icon}</span>
                <p className="text-sm font-semibold text-slate-900">{name}</p>
              </div>
              <p className="text-xs text-slate-600">{desc}</p>
              <p className="text-xs text-red-700 mt-3 opacity-0 group-hover:opacity-100 transition-opacity">
                Deploy now →
              </p>
            </div>
          ))}
        </div>
      </div>
    </main>
  </div>
);

export default Services;
