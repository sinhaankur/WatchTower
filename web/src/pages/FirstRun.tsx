import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import apiClient from '@/lib/api';

/**
 * FirstRun — the one-screen "get your first site live" flow.
 *
 * A brand-new user pastes a GitHub repo and clicks Deploy. Everything else is
 * automatic: we register this Mac as the deploy target (idempotent), create the
 * project with sensible container defaults, and queue the first deployment —
 * then hand off to the project page so they watch it go live. No target /
 * app-type questions; power users get "Advanced options" → the full wizard.
 *
 * Design north star (matches the product vision): minutes to first live site,
 * for beginners, on a computer they already own.
 */

type ThisPcStatus = {
  hostname: string;
  os: string;
  registered: boolean;
  ready: boolean;
  runtime: { available: boolean; name?: string; installed?: boolean };
};

type GhRepo = { full_name: string; html_url: string; default_branch?: string; private?: boolean };

// Derive a clean, valid project name from a repo URL: last path segment,
// sans .git, lowercased, non-alnum → hyphens.
function projectNameFromRepo(url: string): string {
  const cleaned = url.trim().replace(/\.git$/i, '').replace(/\/+$/, '');
  const seg = cleaned.split('/').filter(Boolean).pop() || 'my-site';
  return seg.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'my-site';
}

function looksLikeRepo(url: string): boolean {
  const u = url.trim();
  // github.com/owner/repo (with or without scheme), or owner/repo shorthand.
  return /^(https?:\/\/)?(www\.)?github\.com\/[^/\s]+\/[^/\s]+/i.test(u) || /^[^/\s]+\/[^/\s]+$/.test(u);
}

function normalizeRepoUrl(url: string): string {
  const u = url.trim().replace(/\/+$/, '');
  if (/^https?:\/\//i.test(u)) return u;
  if (/^github\.com\//i.test(u)) return `https://${u}`;
  if (/^[^/\s]+\/[^/\s]+$/.test(u)) return `https://github.com/${u}`;
  return u;
}

export default function FirstRun() {
  const navigate = useNavigate();

  const [repoUrl, setRepoUrl] = useState('');
  const [status, setStatus] = useState<ThisPcStatus | null>(null);
  const [phase, setPhase] = useState<'idle' | 'preparing' | 'deploying'>('idle');
  const [error, setError] = useState<string | null>(null);

  // GitHub repo picker (only offered if the account is connected).
  const [ghConnected, setGhConnected] = useState(false);
  const [repos, setRepos] = useState<GhRepo[]>([]);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [repoQuery, setRepoQuery] = useState('');

  // On mount: probe this machine and, if it isn't a deploy target yet,
  // register it silently. This is the "no server-hunting" promise.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const s = (await apiClient.get<ThisPcStatus>('/this-pc/status')).data;
        if (cancelled) return;
        setStatus(s);
        if (!s.registered) {
          try {
            await apiClient.post('/this-pc/use-as-server');
            const fresh = (await apiClient.get<ThisPcStatus>('/this-pc/status')).data;
            if (!cancelled) setStatus(fresh);
          } catch {
            /* non-fatal — the deploy call surfaces a clear error if needed */
          }
        }
      } catch {
        /* status is best-effort; the flow still works, we just can't show the chip */
      }
      // Is GitHub connected? If so, enable the picker.
      try {
        const repoResp = await apiClient.get('/github/user/repos', { params: { per_page: 100 } });
        if (cancelled) return;
        const list = Array.isArray(repoResp.data) ? repoResp.data : (repoResp.data?.repositories ?? []);
        setRepos(list);
        setGhConnected(true);
      } catch {
        if (!cancelled) setGhConnected(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const runtimeReady = status?.ready ?? status?.runtime?.available ?? null;
  const canDeploy = looksLikeRepo(repoUrl) && phase === 'idle';

  const filteredRepos = useMemo(() => {
    const q = repoQuery.trim().toLowerCase();
    if (!q) return repos.slice(0, 30);
    return repos.filter((r) => r.full_name.toLowerCase().includes(q)).slice(0, 30);
  }, [repos, repoQuery]);

  const deploy = async () => {
    if (!looksLikeRepo(repoUrl)) {
      setError('Enter a GitHub repository, e.g. github.com/you/my-site');
      return;
    }
    setError(null);
    setPhase('preparing');
    const url = normalizeRepoUrl(repoUrl);
    const name = projectNameFromRepo(url);

    try {
      // Belt-and-braces: ensure this PC is a target even if the mount probe
      // raced or was skipped. Idempotent server-side.
      try { await apiClient.post('/this-pc/use-as-server'); } catch { /* already done / non-fatal */ }

      setPhase('deploying');
      // Create the project with general container defaults — the backend
      // auto-detects the framework from the repo. docker_platform is the most
      // general "run this on my machine" shape and matches the This-Mac target.
      const created = await apiClient.post('/setup/wizard/complete', {
        deployment_model: 'self_hosted',
        use_case: 'docker_platform',
        source_type: 'github',
        repo_url: url,
        repo_branch: 'main',
        build_command: '',
        project_name: name,
        dockerfile_path: './Dockerfile',
        exposed_port: 3000,
        recommended_port: 3000,
      });

      const project = created.data as { id?: string };
      if (project?.id) {
        // Queue the first deployment immediately so the repo clones + builds.
        try {
          await apiClient.post(`/projects/${project.id}/deployments`, {
            branch: 'main',
            commit_sha: 'first-run-deploy',
          });
        } catch {
          /* non-fatal: project exists; the detail page has a Deploy button */
        }
        navigate(`/projects/${project.id}`, { state: { first_run: true, project_name: name } });
        return;
      }
      // No id came back — fall back to the sites list rather than dead-end.
      navigate('/applications');
    } catch (e) {
      const detail = (e as { response?: { data?: { detail?: string } } })?.response?.data?.detail;
      setError(detail || 'Could not start the deployment. Check the repo URL and try again.');
      setPhase('idle');
    }
  };

  return (
    <div className="min-h-screen flex flex-col items-center justify-center bg-background px-4 py-10">
      <div className="w-full max-w-lg">
        {/* Brand + headline */}
        <div className="text-center mb-8">
          <img
            src="/wt-logo.svg"
            alt="WatchTower"
            width={52}
            height={52}
            className="mx-auto mb-4 rounded-xl shadow-retro"
          />
          <h1 className="text-2xl font-bold text-foreground tracking-tight">Get your first site live</h1>
          <p className="text-sm text-muted-foreground mt-2 max-w-sm mx-auto">
            Paste a GitHub repo. WatchTower runs it on this Mac — build, URL, and self-healing included.
          </p>
        </div>

        <div className="rounded-xl border border-border bg-card p-6 shadow-retro space-y-4">
          {/* Repo input */}
          <div>
            <label htmlFor="repo" className="block text-xs font-semibold text-foreground mb-1.5">
              GitHub repository
            </label>
            <input
              id="repo"
              type="text"
              autoFocus
              value={repoUrl}
              onChange={(e) => { setRepoUrl(e.target.value); setError(null); }}
              onKeyDown={(e) => { if (e.key === 'Enter' && canDeploy) void deploy(); }}
              placeholder="github.com/you/my-site"
              disabled={phase !== 'idle'}
              spellCheck={false}
              autoCapitalize="off"
              autoCorrect="off"
              className="w-full rounded-lg border border-border bg-background px-3 py-2.5 text-sm text-foreground placeholder:text-muted-foreground/50 focus:outline-none focus:border-primary/50 focus:ring-2 focus:ring-primary/15 disabled:opacity-60 transition-shadow"
            />
            {ghConnected && (
              <button
                type="button"
                onClick={() => setPickerOpen((v) => !v)}
                disabled={phase !== 'idle'}
                className="mt-2 text-xs font-medium text-primary hover:text-primary/80 transition-colors disabled:opacity-50"
              >
                {pickerOpen ? '↑ Hide my repositories' : '↓ Pick from your GitHub'}
              </button>
            )}
          </div>

          {/* GitHub picker */}
          {ghConnected && pickerOpen && (
            <div className="rounded-lg border border-border-soft bg-surface-soft p-2">
              <input
                type="text"
                value={repoQuery}
                onChange={(e) => setRepoQuery(e.target.value)}
                placeholder="Filter repositories…"
                className="w-full rounded-md border border-border bg-background px-2.5 py-1.5 text-xs mb-2 focus:outline-none focus:ring-1 focus:ring-primary/40"
              />
              <div className="max-h-48 overflow-y-auto space-y-px">
                {filteredRepos.length === 0 && (
                  <p className="text-xs text-muted-foreground px-2 py-3 text-center">No repositories found.</p>
                )}
                {filteredRepos.map((r) => (
                  <button
                    key={r.full_name}
                    type="button"
                    onClick={() => { setRepoUrl(r.html_url || r.full_name); setPickerOpen(false); }}
                    className="w-full flex items-center gap-2 px-2 py-1.5 rounded-md text-left text-xs hover:bg-muted transition-colors"
                  >
                    <span className="font-medium text-foreground truncate">{r.full_name}</span>
                    {r.private && <span className="text-[10px] text-muted-foreground border border-border rounded px-1">private</span>}
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Runs-on chip */}
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <span className={`h-1.5 w-1.5 rounded-full ${runtimeReady === false ? 'bg-amber-500' : 'bg-emerald-500'}`} />
            {runtimeReady === false ? (
              <span>Runs on <strong className="text-foreground">this Mac</strong> — we’ll set up the container runtime on first deploy.</span>
            ) : (
              <span>Runs on <strong className="text-foreground">this Mac</strong>{status?.hostname ? ` (${status.hostname})` : ''} — ready.</span>
            )}
          </div>

          {error && (
            <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
              {error}
            </div>
          )}

          {/* Primary CTA */}
          <button
            type="button"
            onClick={() => void deploy()}
            disabled={!canDeploy}
            className="w-full flex items-center justify-center gap-2 rounded-lg bg-primary hover:bg-primary/90 text-primary-foreground text-sm font-semibold py-2.5 shadow-retro transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {phase !== 'idle' && (
              <svg className="animate-spin h-4 w-4" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                <path className="opacity-90" fill="currentColor" d="M4 12a8 8 0 0 1 8-8v4a4 4 0 0 0-4 4H4z" />
              </svg>
            )}
            {phase === 'idle' && <>Deploy →</>}
            {phase === 'preparing' && <>Preparing this Mac…</>}
            {phase === 'deploying' && <>Creating your site…</>}
          </button>

          <p className="text-[11px] text-muted-foreground text-center">
            Takes about a minute. You’ll watch it build and go live on the next screen.
          </p>
        </div>

        {/* Escape hatches */}
        <div className="flex items-center justify-between mt-4 text-xs">
          <Link to="/setup" className="text-muted-foreground hover:text-foreground transition-colors">
            Advanced options →
          </Link>
          <Link
            to="/"
            onClick={() => { try { sessionStorage.setItem('watchtower:skipFirstRun', '1'); } catch { /* ignore */ } }}
            className="text-muted-foreground hover:text-foreground transition-colors"
          >
            Skip to dashboard
          </Link>
        </div>
      </div>
    </div>
  );
}
