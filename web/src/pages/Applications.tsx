import { Link } from 'react-router-dom';

const Applications = () => (
  <div className="flex-1 overflow-auto bg-slate-50">
    <header
      className="px-8 py-5 flex items-center justify-between border-b"
      style={{ borderColor: 'hsl(214 32% 88%)' }}
    >
      <div>
        <h1 className="text-lg font-semibold text-slate-900">Applications</h1>
        <p className="text-xs text-slate-600 mt-0.5">Manage your deployed applications</p>
      </div>
      <Link to="/setup"
        className="px-4 py-1.5 rounded-lg bg-red-700 hover:bg-red-800 text-white text-sm font-medium transition-colors border border-slate-800 shadow-[2px_2px_0_0_#1f2937]">
        + New Application
      </Link>
    </header>

    <main className="px-8 py-6 max-w-5xl">
      <div className="rounded-xl border border-border bg-card p-5">
        <div className="text-center py-14 border border-dashed border-border rounded-xl">
          <div className="w-12 h-12 rounded-xl bg-red-50 border border-red-200 flex items-center justify-center mx-auto mb-3">
            <span className="text-xl">📦</span>
          </div>
          <p className="text-sm font-medium text-slate-900">No applications yet</p>
          <p className="text-xs text-slate-600 mt-1 mb-4">
            Deploy your first application using the Setup Wizard.
          </p>
          <Link to="/setup"
            className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-red-700 hover:bg-red-800 text-white text-sm transition-colors border border-slate-800 shadow-[2px_2px_0_0_#1f2937]">
            Deploy Application →
          </Link>
        </div>

        <div className="mt-6 grid sm:grid-cols-3 gap-3">
          {[
            { icon: '🌐', title: 'Static Site', desc: 'Deploy React, Vue, Angular, or any static build to your server.' },
            { icon: '⚡', title: 'Node.js App',  desc: 'Run SSR apps, APIs, or full-stack Next.js / Nuxt projects.' },
            { icon: '🐳', title: 'Docker App',   desc: 'Deploy any containerized application using a Dockerfile.' },
          ].map(({ icon, title, desc }) => (
            <div key={title} className="p-4 rounded-lg border border-border bg-muted/20 hover:border-red-300 hover:bg-red-50/40 transition-all">
              <span className="text-2xl">{icon}</span>
              <p className="text-sm font-semibold text-slate-900 mt-2">{title}</p>
              <p className="text-xs text-slate-600 mt-1">{desc}</p>
            </div>
          ))}
        </div>
      </div>
    </main>
  </div>
);

export default Applications;
