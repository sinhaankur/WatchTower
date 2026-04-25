import { Link } from 'react-router-dom';

const DB_TYPES = [
  { icon: '🐘', name: 'PostgreSQL', desc: 'Powerful open-source relational database. Great for most apps.' },
  { icon: '🐬', name: 'MySQL / MariaDB', desc: 'Popular relational database for web apps.' },
  { icon: '🍃', name: 'MongoDB', desc: 'Flexible NoSQL document database for dynamic schemas.' },
  { icon: '🔴', name: 'Redis', desc: 'In-memory data store for caching, sessions, and queues.' },
  { icon: '🖱', name: 'ClickHouse', desc: 'Columnar OLAP database for high-speed analytics.' },
  { icon: '🦆', name: 'DragonflyDB', desc: 'Modern drop-in Redis replacement with better performance.' },
];

const Databases = () => (
  <div className="flex-1 overflow-auto bg-slate-50">
    <header
      className="px-4 sm:px-6 lg:px-8 py-4 flex items-center justify-between border-b sticky top-0 z-10 bg-white/95 backdrop-blur-sm"
      style={{ borderColor: 'hsl(214 32% 88%)' }}
    >
      <div>
        <h1 className="text-lg font-semibold text-slate-900">Databases</h1>
        <p className="text-xs text-slate-600 mt-0.5 hidden sm:block">Deploy and manage self-hosted databases</p>
      </div>
      <Link to="/host-connect?tab=database"
        className="px-3 sm:px-4 py-1.5 rounded-lg bg-red-700 hover:bg-red-800 text-white text-xs sm:text-sm font-medium transition-colors border border-slate-800 shadow-[2px_2px_0_0_#1f2937]">
        Setup Guide
      </Link>
    </header>

    <main className="px-4 sm:px-6 lg:px-8 py-6 max-w-5xl mx-auto w-full space-y-6">
      {/* Getting started tip */}
      <div className="rounded-xl border border-amber-200 bg-amber-50 p-4 flex items-start gap-3">
        <span className="text-lg shrink-0">💡</span>
        <div>
          <p className="text-sm font-semibold text-slate-900">Deploy a database in minutes</p>
          <p className="text-xs text-slate-600 mt-0.5">
            Pick a database below, then visit <Link to="/host-connect?tab=database" className="text-red-700 underline">Host Connect → Database</Link> to generate a step-by-step setup guide and connection credentials.
          </p>
        </div>
      </div>

      <div className="rounded-xl border border-border bg-card p-5">
        <h2 className="text-sm font-semibold text-slate-900 mb-3">Available Databases</h2>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
          {DB_TYPES.map(({ icon, name, desc }) => (
            <Link key={name} to="/host-connect?tab=database"
              className="p-4 rounded-xl border border-border bg-muted/20 hover:border-red-300 hover:bg-red-50/40 transition-all cursor-pointer group">
              <div className="flex items-center gap-2 mb-2">
                <span className="text-2xl">{icon}</span>
                <p className="text-sm font-semibold text-slate-900">{name}</p>
              </div>
              <p className="text-xs text-slate-600">{desc}</p>
              <p className="text-xs text-red-700 mt-3 opacity-0 group-hover:opacity-100 transition-opacity">
                Set up with guide →
              </p>
            </Link>
          ))}
        </div>
      </div>
    </main>
  </div>
);

export default Databases;
