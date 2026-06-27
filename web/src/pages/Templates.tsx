import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import apiClient from '@/lib/api';
import Skeleton from '@/components/Skeleton';
import EmptyState from '@/components/EmptyState';

type EnvVar = {
  key: string;
  value: string;
  description: string;
  placeholder: boolean;
};

type Template = {
  slug: string;
  name: string;
  description: string;
  category: string;
  repo_url: string;
  repo_branch: string;
  documentation_url: string | null;
  icon_slug: string | null;
  default_env_vars: EnvVar[];
  memory_hint_mb: number | null;
  notes: string | null;
};

const CATEGORY_BADGE: Record<string, string> = {
  automation: 'border-violet-300 bg-violet-50 text-violet-700',
  analytics: 'border-blue-300 bg-blue-50 text-blue-700',
  content: 'border-emerald-300 bg-emerald-50 text-emerald-700',
  monitoring: 'border-amber-300 bg-amber-50 text-amber-700',
  database: 'border-slate-300 bg-slate-50 text-slate-700',
  static: 'border-slate-300 bg-slate-50 text-slate-700',
  other: 'border-slate-300 bg-slate-50 text-slate-700',
};

// Slug-safe project name: lowercase, hyphenated, no leading digit issues.
function slugifyName(raw: string): string {
  return raw.trim().toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
}

function TemplateCard({
  template,
  creating,
  onCreate,
}: {
  template: Template;
  creating: boolean;
  onCreate: (name: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState(`my-${template.slug}`);
  const placeholders = template.default_env_vars.filter((v) => v.placeholder);
  const validName = slugifyName(name).length >= 2;

  return (
    <article
      className="anim-fade-in-up rounded-xl border border-border bg-card p-4 shadow-retro flex flex-col gap-3 transition-shadow hover:shadow-retro"
    >
      <div className="flex items-start gap-3">
        <div className="w-9 h-9 rounded-lg border border-border bg-amber-100 flex items-center justify-center text-[11px] font-mono font-bold text-slate-900 shadow-retro uppercase">
          {template.slug.slice(0, 2)}
        </div>
        <div className="flex-1 min-w-0">
          <h2 className="text-sm font-semibold text-slate-900 truncate">{template.name}</h2>
          <span
            className={`inline-flex text-[10px] px-2 py-0.5 rounded-full border font-medium mt-1 ${
              CATEGORY_BADGE[template.category] ?? CATEGORY_BADGE.other
            }`}
          >
            {template.category}
          </span>
        </div>
      </div>

      <p className="text-xs text-slate-700 leading-relaxed">{template.description}</p>

      <div className="text-[11px] text-slate-500 space-y-0.5">
        <p>
          Repo: <a href={template.repo_url} target="_blank" rel="noopener noreferrer" className="font-mono text-slate-700 hover:text-slate-900 underline-offset-2 hover:underline">{template.repo_url.replace('https://github.com/', '')}</a>
        </p>
        {template.memory_hint_mb && <p>Memory hint: {template.memory_hint_mb} MB</p>}
        {template.default_env_vars.length > 0 && (
          <p>Pre-fills {template.default_env_vars.length} env var{template.default_env_vars.length === 1 ? '' : 's'}{placeholders.length > 0 && `, ${placeholders.length} need${placeholders.length === 1 ? 's' : ''} your input`}</p>
        )}
      </div>

      {template.notes && (
        <p className="text-[10px] text-amber-800 bg-amber-50 border border-amber-200 rounded px-2 py-1">
          {template.notes}
        </p>
      )}

      {/* Inline create panel — replaces the old window.prompt/alert flow
          so the user sees exactly what they're creating and what they'll
          need to fill in, before committing. */}
      {open ? (
        <div className="rounded-lg border border-slate-300 bg-slate-50 p-3 space-y-2.5">
          <label className="block">
            <span className="text-[11px] font-medium text-slate-600">Project name</span>
            <input
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && validName && !creating) onCreate(slugifyName(name)); }}
              className="mt-1 w-full text-xs font-mono rounded border border-slate-300 px-2 py-1.5 focus:border-border focus:outline-none"
            />
            {name && !validName && (
              <span className="text-[10px] text-red-600">Name needs at least 2 letters/digits.</span>
            )}
          </label>

          {placeholders.length > 0 && (
            <div>
              <p className="text-[11px] font-medium text-slate-600 mb-1">You'll set these after creating:</p>
              <ul className="space-y-1">
                {placeholders.map((v) => (
                  <li key={v.key} className="text-[10.5px] text-slate-600 flex items-start gap-1.5">
                    <code className="font-mono text-amber-800 bg-amber-50 border border-amber-200 rounded px-1 shrink-0">{v.key}</code>
                    {v.description && <span className="text-slate-500">{v.description}</span>}
                  </li>
                ))}
              </ul>
            </div>
          )}

          <div className="flex items-center gap-2 pt-0.5">
            <button
              onClick={() => onCreate(slugifyName(name))}
              disabled={creating || !validName}
              className="flex-1 text-xs px-3 py-1.5 rounded-lg border border-border bg-amber-400 hover:bg-amber-500 text-slate-900 font-semibold shadow-retro disabled:opacity-50 disabled:cursor-wait"
            >
              {creating ? 'Creating…' : 'Create project →'}
            </button>
            <button
              onClick={() => setOpen(false)}
              disabled={creating}
              className="text-[11px] px-2.5 py-1.5 rounded-lg border border-slate-300 text-slate-600 hover:border-slate-400 disabled:opacity-50"
            >
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <div className="flex items-center gap-2 pt-1 mt-auto">
          <button
            onClick={() => setOpen(true)}
            className="flex-1 text-xs px-3 py-1.5 rounded-lg border border-border bg-amber-400 hover:bg-amber-500 text-slate-900 font-semibold shadow-retro"
          >
            Use this template
          </button>
          {template.documentation_url && (
            <a
              href={template.documentation_url}
              target="_blank"
              rel="noopener noreferrer"
              className="text-[11px] text-slate-600 hover:text-slate-900"
              title="Open upstream documentation"
            >
              docs ↗
            </a>
          )}
        </div>
      )}
    </article>
  );
}

export default function Templates() {
  const navigate = useNavigate();
  const [templates, setTemplates] = useState<Template[] | null>(null);
  // Track HTTP status alongside the message so we can render different
  // affordances per error class (auth → sign-in CTA, 5xx → retry hint).
  // Earlier the page just showed "Could not load templates" for every
  // failure, which made an expired session look like a backend outage.
  const [error, setError] = useState<{ status: number; message: string } | null>(null);
  const [creating, setCreating] = useState<string | null>(null);
  const [creatingError, setCreatingError] = useState<string | null>(null);
  const [filter, setFilter] = useState('');

  useEffect(() => {
    let cancelled = false;
    void apiClient
      .get('/templates')
      .then(r => { if (!cancelled) setTemplates(r.data.templates); })
      .catch(e => {
        if (cancelled) return;
        const httpStatus = (e as { response?: { status?: number } })?.response?.status ?? 0;
        const detail = (e as { response?: { data?: { detail?: string } } })?.response?.data?.detail;
        const message =
          httpStatus === 401 ? 'Sign in to view the template catalog.'
          : httpStatus === 403 ? (detail ?? 'Your account does not have access to templates.')
          : httpStatus >= 500 ? 'Server error — try again in a moment.'
          : detail ?? 'Could not load templates.';
        setError({ status: httpStatus, message });
      });
    return () => { cancelled = true; };
  }, []);

  async function handleCreate(template: Template, name: string) {
    // Inline create flow (no browser prompt/alert): the card collects
    // the name and previews the env vars, then we create + navigate to
    // the project detail page where placeholder vars are pre-populated.
    setCreating(template.slug);
    setCreatingError(null);
    try {
      const r = await apiClient.post(
        `/templates/${template.slug}/create`,
        { name },
      );
      const projectId = r.data?.project_id;
      if (projectId) {
        navigate(`/projects/${projectId}`);
      }
    } catch (e) {
      const msg = (e as { response?: { data?: { detail?: string } } })?.response?.data?.detail
        ?? 'Could not create project from template.';
      setCreatingError(msg);
    } finally {
      setCreating(null);
    }
  }

  const filtered = (templates ?? []).filter(t => {
    if (!filter) return true;
    const f = filter.toLowerCase();
    return (
      t.name.toLowerCase().includes(f) ||
      t.description.toLowerCase().includes(f) ||
      t.category.toLowerCase().includes(f)
    );
  });

  return (
    <div className="flex-1 overflow-auto bg-slate-50">
      <header
        className="px-4 sm:px-6 lg:px-8 py-4 border-b flex items-center justify-between"
        style={{ borderColor: 'hsl(var(--border-soft))' }}
      >
        <div>
          <h1 className="text-lg font-semibold text-slate-900">Templates</h1>
          <p className="text-xs text-slate-600 mt-0.5">
            Pre-baked recipes for common self-hosted apps. One click → new project pre-filled with the right repo, env vars, and config hints.
          </p>
        </div>
        <input
          type="search"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Filter…"
          className="text-xs px-3 py-1.5 rounded border border-slate-300 focus:border-border focus:outline-none w-48"
        />
      </header>

      <main className="px-4 sm:px-6 lg:px-8 py-6 max-w-6xl mx-auto w-full">
        {error && (
          <div className={`rounded-lg p-3 mb-4 text-xs flex items-center justify-between gap-3 ${
            error.status === 401
              ? 'border border-blue-300 bg-blue-50 text-blue-800'
              : 'border border-red-300 bg-red-50 text-red-800'
          }`}>
            <span>{error.message}</span>
            {error.status === 401 && (
              <Link
                to="/login"
                className="shrink-0 px-2.5 py-1 rounded-md bg-slate-900 text-white text-[11px] font-medium hover:bg-slate-800"
              >
                Sign in →
              </Link>
            )}
            {error.status >= 500 && (
              <button
                type="button"
                onClick={() => window.location.reload()}
                className="shrink-0 px-2.5 py-1 rounded-md border border-red-300 text-red-800 text-[11px] font-medium hover:bg-red-100"
              >
                Retry
              </button>
            )}
          </div>
        )}
        {creatingError && (
          <div className="rounded-lg border border-red-300 bg-red-50 p-3 mb-4 text-xs text-red-800">
            {creatingError}
          </div>
        )}
        {!templates && !error && (
          <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-3" aria-busy="true" aria-label="Loading templates">
            {Array.from({ length: 6 }).map((_, i) => (
              <article
                key={i}
                className="rounded-xl border border-slate-200 bg-white p-4 flex flex-col gap-3"
              >
                <div className="flex items-start gap-3">
                  <Skeleton className="w-9 h-9 rounded-lg" />
                  <div className="flex-1 space-y-2">
                    <Skeleton className="h-3.5 w-24" />
                    <Skeleton className="h-3 w-16" />
                  </div>
                </div>
                <Skeleton className="h-3 w-full" />
                <Skeleton className="h-3 w-5/6" />
                <Skeleton className="h-7 w-full mt-2" />
              </article>
            ))}
          </div>
        )}
        {templates && filtered.length === 0 && (
          <EmptyState
            title={filter ? 'Nothing matches that filter' : 'No templates available'}
            description={
              filter
                ? `No template name, description, or category matches "${filter}". Try a different search.`
                : 'The template catalog is empty. Restart the API or check the server-side template_catalog module.'
            }
            action={
              filter ? (
                <button
                  type="button"
                  onClick={() => setFilter('')}
                  className="text-xs px-3 py-1.5 rounded-lg border border-slate-300 hover:bg-slate-50 font-medium"
                >
                  Clear filter
                </button>
              ) : null
            }
          />
        )}

        <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-3 anim-stagger">
          {filtered.map(template => (
            <TemplateCard
              key={template.slug}
              template={template}
              creating={creating === template.slug}
              onCreate={(name) => void handleCreate(template, name)}
            />
          ))}
        </div>
      </main>
    </div>
  );
}
