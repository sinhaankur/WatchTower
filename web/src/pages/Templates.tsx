import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Workflow, BarChart3, FileText, Activity, Database, Globe, Package } from 'lucide-react';
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

// Category badges use alpha tints of each hue so they read correctly in BOTH
// light and dark (the old solid -50/-700 pairs looked washed-out on dark).
const CATEGORY_BADGE: Record<string, string> = {
  automation: 'border-violet-500/30 bg-violet-500/15 text-violet-400 dark:text-violet-300',
  analytics:  'border-blue-500/30 bg-blue-500/15 text-blue-500 dark:text-blue-300',
  content:    'border-emerald-500/30 bg-emerald-500/15 text-emerald-500 dark:text-emerald-300',
  monitoring: 'border-accent/30 bg-accent/15 text-accent',
  database:   'border-border bg-muted text-muted-foreground',
  static:     'border-border bg-muted text-muted-foreground',
  other:      'border-border bg-muted text-muted-foreground',
};

// A meaningful lucide icon per category — replaces the generic "first-two-letters"
// placeholder so each template reads at a glance.
const CATEGORY_ICON: Record<string, typeof Workflow> = {
  automation: Workflow,
  analytics:  BarChart3,
  content:    FileText,
  monitoring: Activity,
  database:   Database,
  static:     Globe,
  other:      Package,
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
  const envVars = Array.isArray(template.default_env_vars) ? template.default_env_vars : [];
  const placeholders = envVars.filter((v) => v.placeholder);
  const validName = slugifyName(name).length >= 2;

  return (
    <article
      className="anim-fade-in-up rounded-xl border border-border bg-card p-4 shadow-retro flex flex-col gap-3 transition-shadow hover:shadow-retro"
    >
      <div className="flex items-start gap-3">
        {(() => {
          const Icon = CATEGORY_ICON[template.category ?? 'other'] ?? Package;
          return (
            <div className="w-10 h-10 rounded-lg border border-border bg-accent/10 flex items-center justify-center text-accent shrink-0">
              <Icon size={18} strokeWidth={2} />
            </div>
          );
        })()}
        <div className="flex-1 min-w-0">
          <h2 className="text-sm font-semibold text-foreground truncate">{template.name}</h2>
          <span
            className={`inline-flex text-xs px-2 py-0.5 rounded-full border font-medium mt-1 ${
              CATEGORY_BADGE[template.category] ?? CATEGORY_BADGE.other
            }`}
          >
            {template.category}
          </span>
        </div>
      </div>

      <p className="text-xs text-foreground/90 leading-relaxed">{template.description}</p>

      <div className="text-xs text-muted-foreground space-y-0.5">
        <p>
          Repo: <a href={template.repo_url} target="_blank" rel="noopener noreferrer" className="font-mono text-foreground/90 hover:text-foreground underline-offset-2 hover:underline">{template.repo_url.replace('https://github.com/', '')}</a>
        </p>
        {template.memory_hint_mb && <p>Memory hint: {template.memory_hint_mb} MB</p>}
        {envVars.length > 0 && (
          <p>Pre-fills {envVars.length} env var{envVars.length === 1 ? '' : 's'}{placeholders.length > 0 && `, ${placeholders.length} need${placeholders.length === 1 ? 's' : ''} your input`}</p>
        )}
      </div>

      {template.notes && (
        <p className="text-xs text-accent bg-accent/10 border border-accent/25 rounded px-2 py-1">
          {template.notes}
        </p>
      )}

      {/* Inline create panel — replaces the old window.prompt/alert flow
          so the user sees exactly what they're creating and what they'll
          need to fill in, before committing. */}
      {open ? (
        <div className="rounded-lg border border-border bg-muted p-3 space-y-2.5">
          <label className="block">
            <span className="text-xs font-medium text-muted-foreground">Project name</span>
            <input
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && validName && !creating) onCreate(slugifyName(name)); }}
              className="mt-1 w-full text-xs font-mono rounded border border-border px-2 py-1.5 focus:border-border focus:outline-none"
            />
            {name && !validName && (
              <span className="text-xs text-destructive">Name needs at least 2 letters/digits.</span>
            )}
          </label>

          {placeholders.length > 0 && (
            <div>
              <p className="text-xs font-medium text-muted-foreground mb-1">You'll set these after creating:</p>
              <ul className="space-y-1">
                {placeholders.map((v) => (
                  <li key={v.key} className="text-[10.5px] text-muted-foreground flex items-start gap-1.5">
                    <code className="font-mono text-accent bg-accent/10 border border-accent/25 rounded px-1 shrink-0">{v.key}</code>
                    {v.description && <span className="text-muted-foreground">{v.description}</span>}
                  </li>
                ))}
              </ul>
            </div>
          )}

          <div className="flex items-center gap-2 pt-0.5">
            <button
              onClick={() => onCreate(slugifyName(name))}
              disabled={creating || !validName}
              className="flex-1 text-xs px-3 py-1.5 rounded-lg border border-border bg-primary hover:bg-primary/90 text-primary-foreground font-semibold shadow-retro disabled:opacity-50 disabled:cursor-wait"
            >
              {creating ? 'Creating…' : 'Create project →'}
            </button>
            <button
              onClick={() => setOpen(false)}
              disabled={creating}
              className="text-xs px-2.5 py-1.5 rounded-lg border border-border text-muted-foreground hover:border-accent/50 disabled:opacity-50"
            >
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <div className="flex items-center gap-2 pt-1 mt-auto">
          {/* Demoted to outline: in the gallery, every card had a filled amber
              button (6+ competing primaries). The amber primary now appears only
              when you expand a card to configure it ("Create project"). */}
          <button
            onClick={() => setOpen(true)}
            className="flex-1 inline-flex items-center justify-center gap-1.5 text-sm px-3 h-9 rounded-lg border border-border bg-card hover:bg-muted hover:border-accent/50 text-foreground font-medium transition-colors"
          >
            Use this template
          </button>
          {template.documentation_url && (
            <a
              href={template.documentation_url}
              target="_blank"
              rel="noopener noreferrer"
              className="text-xs text-muted-foreground hover:text-foreground"
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
      .then(r => {
        if (cancelled) return;
        // Tolerate both response shapes ({ templates: [...] } and a bare
        // array) and never hand a non-array to setState — a malformed
        // payload used to white-screen the page at `.filter`/`.map`.
        const payload = r.data;
        const list = Array.isArray(payload)
          ? payload
          : Array.isArray(payload?.templates)
            ? payload.templates
            : [];
        setTemplates(list);
      })
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
    <div className="flex-1 overflow-auto bg-background">
      <header className="px-5 sm:px-8 lg:px-10 py-5 border-b border-border flex items-center justify-between gap-4 sticky top-0 z-10 bg-background/80 backdrop-blur-sm">
        <div className="min-w-0">
          <h1 className="text-xl font-semibold text-foreground tracking-tight">Templates</h1>
          <p className="text-sm text-muted-foreground mt-1 hidden sm:block">
            Known-good recipes for common self-hosted apps — one click to a pre-wired project.
          </p>
        </div>
        <input
          type="search"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Filter…"
          className="text-xs px-3 py-1.5 rounded border border-border focus:border-border focus:outline-none w-48"
        />
      </header>

      <main className="px-4 sm:px-6 lg:px-8 py-6 max-w-6xl mx-auto w-full">
        {/* How a template connects — users saw cards but not the chain
            (template → project → deploy → Applications), so "Use" felt
            like a mystery button. Three steps, always visible, cheap. */}
        <div className="rounded-xl border border-border bg-card px-4 py-3 mb-6 flex flex-col sm:flex-row sm:items-center gap-3 sm:gap-0 text-xs text-muted-foreground">
          <div className="flex items-center gap-2 sm:flex-1">
            <span className="w-5 h-5 rounded-full bg-secondary text-secondary-foreground font-bold flex items-center justify-center shrink-0">1</span>
            <span><strong className="text-foreground">Pick a template.</strong> Each is a known-good recipe: repo, env vars, config.</span>
          </div>
          <span className="hidden sm:block text-muted-foreground px-3" aria-hidden>→</span>
          <div className="flex items-center gap-2 sm:flex-1">
            <span className="w-5 h-5 rounded-full bg-secondary text-secondary-foreground font-bold flex items-center justify-center shrink-0">2</span>
            <span><strong className="text-foreground">We create your project</strong> with everything pre-wired — you land on its page to review.</span>
          </div>
          <span className="hidden sm:block text-muted-foreground px-3" aria-hidden>→</span>
          <div className="flex items-center gap-2 sm:flex-1">
            <span className="w-5 h-5 rounded-full bg-secondary text-secondary-foreground font-bold flex items-center justify-center shrink-0">3</span>
            <span><strong className="text-foreground">Hit Deploy.</strong> It runs on your machine and shows up under <Link to="/applications" className="underline font-medium text-primary">Applications</Link>.</span>
          </div>
        </div>
        {error && (
          <div className={`rounded-lg p-3 mb-4 text-xs flex items-center justify-between gap-3 ${
            error.status === 401
              ? 'border border-blue-300 bg-blue-500/15 text-blue-800'
              : 'border border-destructive/40 bg-destructive/10 text-destructive'
          }`}>
            <span>{error.message}</span>
            {error.status === 401 && (
              <Link
                to="/login"
                className="shrink-0 px-2.5 py-1 rounded-md bg-foreground text-background text-xs font-medium hover:opacity-90"
              >
                Sign in →
              </Link>
            )}
            {error.status >= 500 && (
              <button
                type="button"
                onClick={() => window.location.reload()}
                className="shrink-0 px-2.5 py-1 rounded-md border border-destructive/40 text-destructive text-xs font-medium hover:bg-destructive/15"
              >
                Retry
              </button>
            )}
          </div>
        )}
        {creatingError && (
          <div className="rounded-lg border border-destructive/40 bg-destructive/10 p-3 mb-4 text-xs text-destructive">
            {creatingError}
          </div>
        )}
        {!templates && !error && (
          <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-3" aria-busy="true" aria-label="Loading templates">
            {Array.from({ length: 6 }).map((_, i) => (
              <article
                key={i}
                className="rounded-xl border border-border bg-card p-4 flex flex-col gap-3"
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
                  className="text-xs px-3 py-1.5 rounded-lg border border-border hover:bg-muted font-medium"
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
