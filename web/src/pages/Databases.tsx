import { Link } from 'react-router-dom';

const DB_TYPES = [
  { icon: '🐘', name: 'PostgreSQL', desc: 'Powerful open-source relational database.' },
  { icon: '🐬', name: 'MySQL / MariaDB', desc: 'Popular relational database for web apps.' },
  { icon: '🍃', name: 'MongoDB', desc: 'Flexible NoSQL document database.' },
  { icon: '🔴', name: 'Redis', desc: 'In-memory data store for caching and queues.' },
  { icon: '🖱', name: 'ClickHouse', desc: 'Columnar OLAP database for analytics.' },
  { icon: '🦆', name: 'DragonflyDB', desc: 'Modern drop-in Redis replacement.' },
];

const Databases = () => (
  <div className="flex-1 overflow-auto bg-slate-50">
    <header
      className="px-8 py-5 flex items-center justify-between border-b"
      style={{ borderColor: 'hsl(214 32% 88%)' }}
    >
      <div>
        <h1 className="text-lg font-semibold text-slate-900">Databases</h1>
        <p className="text-xs text-slate-600 mt-0.5">Deploy and manage self-hosted databases</p>
      </div>
      <Link to="/setup"
        className="px-4 py-1.5 rounded-lg bg-red-700 hover:bg-red-800 text-white text-sm font-medium transition-colors border border-slate-800 shadow-[2px_2px_0_0_#1f2937]">
        + New Database
      </Link>
    </header>

    <main className="px-8 py-6 max-w-5xl space-y-6">
      {/* Empty state */}
      <div className="rounded-xl border border-border bg-card p-5">
        <div className="text-center py-10 border border-dashed border-border rounded-xl mb-6">
          <div className="w-12 h-12 rounded-xl bg-red-50 border border-red-200 flex items-center justify-center mx-auto mb-3">
            <span className="text-xl">🗄</span>
          </div>
          <p className="text-sm font-medium text-slate-900">No databases running</p>
          <p className="text-xs text-slate-600 mt-1">Choose a database below to deploy it on your server.</p>
        </div>

        <h2 className="text-sm font-semibold text-slate-900 mb-3">Available Databases</h2>
        <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-3">
          {DB_TYPES.map(({ icon, name, desc }) => (
            <div key={name}
              className="p-4 rounded-xl border border-border bg-muted/20 hover:border-red-300 hover:bg-red-50/40 transition-all cursor-pointer group">
              <div className="flex items-center gap-2 mb-2">
                <span className="text-2xl">{icon}</span>
                <p className="text-sm font-semibold text-slate-900">{name}</p>
              </div>
              <p className="text-xs text-slate-600">{desc}</p>
              <p className="text-xs text-red-700 mt-3 opacity-0 group-hover:opacity-100 transition-opacity">
                Deploy on your server →
              </p>
            </div>
          ))}
        </div>
      </div>
    </main>
  </div>
);

export default Databases;
