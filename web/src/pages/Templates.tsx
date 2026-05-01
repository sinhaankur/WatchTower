import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import apiClient from '@/lib/api';

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

export default function Templates() {
  const navigate = useNavigate();
  const [templates, setTemplates] = useState<Template[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState<string | null>(null);
  const [creatingError, setCreatingError] = useState<string | null>(null);
  const [filter, setFilter] = useState('');

  useEffect(() => {
    let cancelled = false;
    void apiClient
      .get('/templates')
      .then(r => { if (!cancelled) setTemplates(r.data.templates); })
      .catch(e => {
        if (!cancelled) setError((e as { response?: { data?: { detail?: string } } })?.response?.data?.detail ?? 'Could not load templates');
      });
    return () => { cancelled = true; };
  }, []);

  async function handleCreate(template: Template) {
    // Quick name prompt — full create flow lands users on the new
    // project's detail page where they can fill in placeholder env
    // vars before deploy.
    const suggested = `my-${template.slug}`;
    const name = window.prompt(
      `Create a project from ${template.name}?\n\nGive it a name:`,
      suggested
    );
    if (!name) return;

    setCreating(template.slug);
    setCreatingError(null);
    try {
      const r = await apiClient.post(
        `/templates/${template.slug}/create`,
        { name },
      );
      const projectId = r.data?.project_id;
      const placeholders: string[] = r.data?.placeholder_env_var_keys ?? [];
      if (placeholders.length > 0) {
        // The user needs to fill these in before deploy succeeds.
        // We send them straight to the project detail view; the env
        // vars tab will already show the rows pre-populated.
        window.alert(
          `Project created!\n\nBefore your first deploy, edit these placeholder env vars:\n  ${placeholders.join(', ')}\n\nWe'll take you to the project page now.`
        );
      }
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
          className="text-xs px-3 py-1.5 rounded border border-slate-300 focus:border-slate-800 focus:outline-none w-48"
        />
      </header>

      <main className="px-4 sm:px-6 lg:px-8 py-6 max-w-6xl mx-auto w-full">
        {error && (
          <div className="rounded-lg border border-red-300 bg-red-50 p-3 mb-4 text-xs text-red-800">
            {error}
          </div>
        )}
        {creatingError && (
          <div className="rounded-lg border border-red-300 bg-red-50 p-3 mb-4 text-xs text-red-800">
            {creatingError}
          </div>
        )}
        {!templates && !error && (
          <p className="text-sm text-slate-600">Loading templates…</p>
        )}
        {templates && filtered.length === 0 && (
          <p className="text-sm text-slate-600">
            {filter ? 'No templates match your filter.' : 'No templates available.'}
          </p>
        )}

        <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-3">
          {filtered.map(template => (
            <article
              key={template.slug}
              className="rounded-xl border border-slate-800 bg-card p-4 shadow-[2px_2px_0_0_#1f2937] flex flex-col gap-3"
            >
              <div className="flex items-start gap-3">
                <div className="w-9 h-9 rounded-lg border border-slate-800 bg-amber-100 flex items-center justify-center text-[11px] font-mono font-bold text-slate-900 shadow-[1px_1px_0_0_#1f2937] uppercase">
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
                  <p>Pre-fills {template.default_env_vars.length} env var{template.default_env_vars.length === 1 ? '' : 's'}{template.default_env_vars.some(v => v.placeholder) && ' (some need your input)'}</p>
                )}
              </div>

              {template.notes && (
                <p className="text-[10px] text-amber-800 bg-amber-50 border border-amber-200 rounded px-2 py-1">
                  ⓘ {template.notes}
                </p>
              )}

              <div className="flex items-center gap-2 pt-1 mt-auto">
                <button
                  onClick={() => void handleCreate(template)}
                  disabled={creating === template.slug}
                  className="flex-1 text-xs px-3 py-1.5 rounded-lg border border-slate-800 bg-amber-400 hover:bg-amber-500 text-slate-900 font-semibold shadow-[1px_1px_0_0_#1f2937] disabled:opacity-50 disabled:cursor-wait"
                >
                  {creating === template.slug ? 'Creating…' : 'Create from template'}
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
            </article>
          ))}
        </div>
      </main>
    </div>
  );
}
