# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What WatchTower Is

WatchTower has two distinct, intertwined modes that share one FastAPI process:

1. **Container auto-update service** (CLI: `watchtower start`) — a Podman-first daemon that polls running containers, pulls newer images, and restarts safely. Configured via `config/watchtower.yml`. Code lives in `watchtower/{cli,podman_manager,updater,scheduler,config}.py`.
2. **App Center / deployment control plane** (FastAPI app at `watchtower.api:app`, plus CLI `watchtower-deploy`) — a multi-user platform with GitHub OAuth, projects, builds, deployments to remote nodes over SSH, webhooks, and an integrations dashboard. Code lives in `watchtower/api/*.py`, `watchtower/database.py`, `watchtower/builder.py`, `watchtower/deploy_server.py`.

The **same FastAPI process serves the React SPA** from `web/dist` (mounted in `watchtower/api/__init__.py`) — there is no separate frontend server in production. The Vite dev server is only used during web development; in browser mode, `run.sh` opens port 8000 directly because the backend serves both `/api/*` and `/`.

## Commands

### One-command launcher (preferred for local dev)

```bash
./run.sh              # auto: desktop if $DISPLAY set, else browser
./run.sh desktop      # Electron app (Electron owns/spawns the backend)
./run.sh browser      # Browser at http://127.0.0.1:8000 (backend serves SPA)
./run.sh stop         # Kill API (8000), web dev (5222), and Electron
./run.sh logs         # tail /tmp/watchtower-api.log + /tmp/watchtower-web.log
./run.sh update       # git pull origin main + reinstall + rebuild frontend
```

`run.sh` sources `.env`, creates `.venv`, installs Python deps with `--prefer-binary` (critical for ARM/Pi), runs `pip install -e .` so `watchtower` is importable, and uses a `$VENV/.deps_installed` sentinel to skip reinstalls. **Backend is started in `browser`/`auto` modes only — in `desktop` mode, Electron starts the backend itself with its own API token.**

### Backend manually (when not using run.sh)

```bash
.venv/bin/python -m uvicorn watchtower.api:app --app-dir . --host 127.0.0.1 --port 8000
# OR
watchtower-deploy serve --host 0.0.0.0 --port 8000
```

### Frontend (web/)

```bash
npm --prefix web install
npm --prefix web run dev          # Vite dev server on 5222, proxies /api → :8000
npm --prefix web run build        # tsc --noEmit + vite build → web/dist
npm --prefix web run lint         # eslint, --max-warnings 0
```

There is no `web/test` script — frontend has no automated tests. `npm run build` runs `tsc --noEmit` first, so a typecheck failure breaks the build.

### Tests

```bash
pytest tests/                          # whole suite (only test_config.py exists today)
pytest tests/test_config.py::test_default_config -v   # single test
pytest --cov=watchtower tests/         # with coverage (needs pytest-cov)
```

Tests are sparse — most API/builder/desktop modules have no coverage. Treat new behaviour as needing a smoke test, not a comprehensive suite, unless the user asks otherwise.

### VS Code extension (`vscode-extension/`)

A separate TypeScript subproject that talks to the running API. Independent dependency tree.

```bash
npm --prefix vscode-extension install
npm --prefix vscode-extension run compile      # tsc -p ./ → out/
npm --prefix vscode-extension run watch        # tsc --watch
npm --prefix vscode-extension run lint         # eslint src --ext ts
npm --prefix vscode-extension run package      # vsce package → .vsix
```

Configures `watchtower.apiUrl` and `watchtower.apiToken` via VS Code settings; the token can be stored in the system keychain via the **WatchTower: Set API Token** command.

### Container auto-update CLI

```bash
watchtower start | status | update-now | list-containers | validate-config
watchtower -c /path/to/watchtower.yml start
```

### Docker / Compose

```bash
docker compose -f docker-compose.app.yml up -d --build   # single-node prod-like
docker compose -f deploy/docker-compose.ha.yml up -d     # HA setup
```

The `Dockerfile` uses a `node:20-alpine` build stage for `web/`, then `python:3.12-slim`; the SPA is baked into the image at `/app/web/dist`.

### Releases

```bash
./scripts/release.sh 1.2.2         # bumps watchtower/__init__.py, tags v1.2.2, pushes
python3 scripts/sync_versions.py   # fan version from watchtower/__init__.py to package.json files
./scripts/preflight.sh              # local quality gate — RUN THIS BEFORE TAGGING
./scripts/verify-release.sh v1.2.2 # post-CI verifier — RUN THIS AFTER CI SUCCEEDS
```

`watchtower/__init__.py:__version__` is the single source of truth — `pyproject.toml` reads it dynamically, and `sync_versions.py` propagates to `package.json`, `desktop/package.json`, and `vscode-extension/package.json`. CI in `.github/workflows/release.yml` validates that the git tag matches.

**Don't ship Stable without running both scripts.** `RELEASE_QUALITY.md` at the repo root defines the bar; `preflight.sh` and `verify-release.sh` automate the parts of it that can be checked mechanically. The two scripts caught the 1.12.0 cross-arch overwrite bug retroactively — running them on every release prevents that class of bug from ever reaching users again.

## Architecture

### Single-process layout

`watchtower.api:app` is the FastAPI app exposed at port 8000. It:

- Runs `init_db()` and `_ensure_dev_api_token()` at **module import time** (NOT in lifespan — Alembic 1.13's `command.upgrade()` deadlocks uvicorn 0.29's lifespan, the call returns but `lifespan.startup.complete` is never sent → backend hangs forever, splash sits, smoke test times out at 90s). `_ensure_secret_key()` stays in lifespan (auto-generates a Fernet key at `~/.watchtower/secret.key` with `0600` perms if `WATCHTOWER_SECRET_KEY` is unset).
- Default DB path falls through `DATABASE_URL` env → `$WATCHTOWER_DATA_DIR/watchtower.db` → `~/.watchtower/watchtower.db`, and only uses `./watchtower.db` if the file already exists in cwd (preserves dev-clone behaviour). The fallback is what makes the packaged AppImage work — its cwd is a read-only FUSE mount.
- Mounts routers from `watchtower/api/{projects,deployments,builds,webhooks,setup,enterprise,runtime,envvars,notifications}.py`. All routers prefix `/api/...` and depend on `util.get_current_user`.
- Mounts `web/dist/assets` as static, and serves the React SPA via a `spa_fallback` route that path-traversal-guards every request (resolves the candidate and requires it to live inside `web/dist`).
- Conditionally enables `/docs` only when `WATCHTOWER_ENABLE_DOCS=true`.

### Auth model (read this before touching anything in `api/`)

`watchtower/api/util.py:get_current_user` is the single auth dependency. Two valid token shapes:

1. **Signed user-session token** — base64(json + HMAC-SHA256). Issued by GitHub login, parsed by `_parse_user_session_token`. Carries `user_id`, `email`, `github_id`. Signed with `WATCHTOWER_AUTH_SECRET` (or `WATCHTOWER_API_TOKEN` as fallback).
2. **Static `WATCHTOWER_API_TOKEN`** — for CI/curl/Electron. Constant-time compared. Synthesises a deterministic UUID5 user_id from the token.

**Two GitHub auth flows feed path #1**, both implemented in `api/enterprise.py`:

- **Web OAuth** — needs `GITHUB_OAUTH_CLIENT_ID` *and* `GITHUB_OAUTH_CLIENT_SECRET`. Standard redirect-callback flow. Used when the user runs the API behind a known callback URL.
- **Device Flow** — needs only the *public* `WATCHTOWER_GITHUB_DEVICE_CLIENT_ID`. No client secret, no callback URL. This is the path baked into shipped/desktop builds (the client ID is safe to embed). Same model as the `gh` CLI.

**Dev mode is `WATCHTOWER_ALLOW_INSECURE_DEV_AUTH=true`.** It does NOT mean "any token works" — that bypass was removed in commit 3f645d0 (security). What dev mode *does* now: at module import time `_ensure_dev_api_token()` (in `api/__init__.py`) auto-sets `WATCHTOWER_API_TOKEN=dev-watchtower-token` if it's missing, with a clear `logger.warning`. The matching token is also the SPA's `DEV_FALLBACK_TOKEN` in `web/src/lib/api.ts`, so both sides agree. The 503 from older builds (`"WATCHTOWER_API_TOKEN must be set even in dev mode"`) is gone — instead the auth flow just works on first launch. `_auth_signing_secret()` falls back to `WATCHTOWER_API_TOKEN` so signed sessions remain stable across restarts. Don't reintroduce the old "any-bearer-accepted" path.

`run.sh` sets `WATCHTOWER_ALLOW_INSECURE_DEV_AUTH=true` when launching the backend in browser mode. The `.env` ships `WATCHTOWER_API_TOKEN=dev-watchtower-token` (matching the auto-set value above) so manually-sourced runs also work.

### SSRF / path-traversal guards (don't bypass)

- `util.assert_safe_external_url()` blocks non-http(s) schemes and any host that resolves to loopback/private/link-local/reserved addresses (incl. `169.254.169.254`). Used by `enterprise.py` before any server-side request to a user-supplied GHES URL. Bypass for local GHES dev: `WATCHTOWER_ALLOW_INTERNAL_HTTP=true`.
- `spa_fallback` resolves and re-checks the candidate path against `web/dist` — preserve this when modifying static serving.
- `encrypt_secret`/`decrypt_secret` use `WATCHTOWER_SECRET_KEY` (Fernet). GitHub PATs and SSH keys are stored encrypted; if you add a secret column, route it through these helpers, not raw strings.

### Database

SQLite by default (`./watchtower.db`), Postgres-capable via `DATABASE_URL`. ORM models live in `watchtower/database.py`. Two key behaviours:

- `init_db()` is **Alembic-driven**. On startup it inspects the target DB and either runs `alembic upgrade head` (fresh or already-managed DBs) or stamps an existing pre-Alembic schema at `head` (for installations that pre-date adoption — the baseline migration matches the final state of the old `_ensure_*_columns()` helpers). To add a column or change a schema: edit the model, then `alembic revision --autogenerate -m "<desc>"`, review the generated file in `alembic/versions/`, commit. SQLite needs `render_as_batch=True` (already configured in `alembic/env.py`) and explicit constraint names for any FK changes.
- All UUID columns use `Uuid(as_uuid=True)`. Routers should coerce caller-provided IDs through `util.to_uuid()` rather than manual `UUID(str(...))` — that pattern was the source of past bugs (see commit 5c6dbcf).

### Build pipeline (`watchtower/builder.py`)

The deployment runner: clones a project's git repo into `$WATCHTOWER_BUILD_DIR` (defaults to `/tmp/watchtower-builds`), runs the build, packages an artifact, rsyncs to each `OrgNode` over SSH (via `fabric`), runs the node's reload command, and updates `Deployment.status`. Triggered by webhooks (`api/webhooks.py`), manual API calls (`api/deployments.py`), or `watchtower-deploy deploy-now`.

### Audit log (`watchtower/api/audit.py` + `AuditEvent` model)

Append-only record of who-did-what across mutating endpoints. Closes audit-review item #10.

- `audit_log.record_for_user(db, current_user, action="project.create", entity_id=..., org_id=..., request=request, extra={...})` — call inside any mutating handler. Uses `db.flush()` (not commit) so the audit row lives or dies with the user-facing write.
- `GET /api/audit?entity_type=...&entity_id=...&action=...&days=30&limit=100` — read endpoint scoped to caller's organization.
- Each row records: actor (user_id + email), action (dotted: `project.create`, `deployment.trigger`, `envvar.update`), entity_type + entity_id, org_id, request_id (from log_config — for cross-correlation with logs), client IP, action-specific JSON metadata in `extra`.
- **`extra` NEVER stores secret values.** Env-var audits record the key + environment but never the value. Tested explicitly so future changes can't regress.

Currently instrumented: `project.{create,update,delete}`, `deployment.{trigger,rollback}`, `envvar.{create,update,delete}`. Add new actions by calling `audit_log.record_for_user()` inside the handler before its `db.commit()`.

### Logging (`watchtower/log_config.py`)

`setup_logging()` is idempotent and the only place logging gets configured — `api/__init__.py`, `deploy_server.py`, and `worker.py` all call it instead of `logging.basicConfig` (the audit flagged a silent double-init that caused log lines to drop). Two formats:

- `WATCHTOWER_LOG_FORMAT=text` (default) — human-readable, includes `[req=<id>]` per line
- `WATCHTOWER_LOG_FORMAT=json` — one JSON record per line for log aggregators

The FastAPI `request_id_middleware` generates a UUID4 per request (or reuses the client's `X-Request-ID` header if present so upstream trace IDs propagate), binds it to a contextvar that the formatter reads, and echoes it back as `X-Request-ID` on every response. Look up logs by request ID end-to-end without grep heuristics.

### Build queue (`watchtower/queue.py` + `watchtower/worker.py`)

Two execution modes, transparently selected at submit time by `enqueue_build()`:

- **`REDIS_URL` set + reachable** → enqueue onto an RQ queue (`watchtower-builds`); a separate `python -m watchtower.worker` process drains it. Builds survive API restarts.
- **No Redis** → fall back to FastAPI `BackgroundTasks` (the legacy in-process path). Lets `./run.sh` and the desktop launcher work without Redis.

Probe failure is cached for the process lifetime so a missing/flapping broker doesn't add a 2-second connect timeout to every webhook hit. The compose stack runs a dedicated `worker` service alongside the API; production deployments without compose should run `python -m watchtower.worker` separately.

### LLM agent (`watchtower/api/agent.py`)

Provider-agnostic by design — talks to **any OpenAI-compatible chat-completions endpoint** (Ollama, LM Studio, vLLM, llama.cpp, OpenAI, OpenRouter, LiteLLM, etc.). The operator picks the LLM via env vars; WatchTower itself ships with no model bundled.

- `WATCHTOWER_LLM_BASE_URL` — required (e.g. `http://localhost:11434/v1` for Ollama)
- `WATCHTOWER_LLM_API_KEY` — local servers usually accept any non-empty string
- `WATCHTOWER_LLM_MODEL` — default `gpt-4o-mini`; override per-deploy
- `WATCHTOWER_AGENT_READONLY=true` — blocks destructive tools (filtered from the tool list AND re-checked at execution time as defence-in-depth)

`POST /api/agent/chat` returns Server-Sent Events. Tool registry wraps existing API operations (`list_projects`, `list_deployments`, `view_build_logs`, `trigger_deployment`, etc.) and runs every tool under the authenticated user's identity — the agent can only do what the user can do, no privilege escalation. `GET /api/agent/config` lets the SPA detect "operator hasn't configured an LLM yet" and show setup UI. If `WATCHTOWER_LLM_BASE_URL` is unset, `/chat` returns 503 with an actionable message.

### Related-app bundles (`ProjectRelation`)

A project may declare other projects in the same org that should deploy alongside it. `POST /api/projects/{id}/run-with-related` queues a `Deployment` for every direct relation (ordered by `ProjectRelation.order_index` ascending — dependencies first) and then for the trigger project itself. The relation graph is *not* followed transitively — only direct edges, so cycles cannot loop. Cross-org links are blocked at write time. Managed in the UI under the "Related" tab on `ProjectDetail`.

### Operator deploy trigger (`scripts/deploy.sh`)

Canonical "kick a deploy from a dev box" entry point. Two shapes:

```bash
# App Center mode — POST /apps/<name>/deploy
WATCHTOWER_BASE_URL=http://server:8000 WATCHTOWER_TOKEN=secret \
  ./scripts/deploy.sh --app website-main main

# Legacy single-target mode — POST $WATCHTOWER_URL (defaults to /deploy)
WATCHTOWER_URL=http://server:8000/deploy WATCHTOWER_TOKEN=secret \
  ./scripts/deploy.sh main
```

Note: this script authenticates with `X-Watchtower-Token`, *not* `Authorization: Bearer` — those are separate token concepts (`WATCHTOWER_TRIGGER_TOKEN` for the deploy-server endpoint vs. `WATCHTOWER_API_TOKEN` for the FastAPI auth dependency). Don't conflate them.

### Two configuration surfaces for App Center

App Center deployment targets exist in *two parallel places* — keep this distinction in mind when changing either:

- **JSON files** — `config/{apps,nodes}.json` (or `/etc/watchtower/{apps,nodes}.json` in production). Read by `watchtower/deploy_server.py` and the legacy CLI/script flow. Pointed at by `WATCHTOWER_APPS_FILE` / `WATCHTOWER_NODES_FILE`.
- **SQLite tables** — `Project`, `OrgNode`, `Deployment` in `watchtower.database`. Read by the FastAPI routers (`api/projects.py`, `api/deployments.py`, `api/enterprise.py`).

The two surfaces don't auto-sync. Most newer features use the DB; the JSON files survive for the App Center installer / CLI deploy path.

### Frontend (`web/`)

React 19 + Vite + React Query + Zustand + Tailwind. Path alias `@` → `web/src`. Single `apiClient` (`web/src/lib/api.ts`):

- Reads token from `localStorage.authToken` (set after OAuth callback) → falls back to `VITE_API_TOKEN` → falls back to `dev-token` in dev builds.
- 401 responses clear the token and redirect to `/login?next=...` — but **only if there was a session token**, so anonymous calls on `/login` don't infinite-loop.
- `baseURL = '/api'` so the backend's `/api/health` alias exists alongside `/health`.

`RequireAuth` in `App.tsx` gates every route except `/login` and the OAuth callbacks. New routes go through it. A top-level `<ErrorBoundary>` wraps the entire route tree — uncaught render errors get a recoverable fallback instead of a white screen.

**Server-state pattern**: new page code should use the React Query hooks in `web/src/hooks/queries.ts` rather than hand-rolled `useState`/`useEffect`/`apiClient.get` triples. Existing pages still use the old pattern; convert them page-by-page when they're touched. The hooks file owns the query-key shape — invalidating after a mutation requires using the same key reference, so always import `queryKeys` from there.

### Desktop (`desktop/`)

Electron wrapper. `desktop/main.js` spawns the Python backend itself in packaged builds, and uses `electron-updater` against GitHub Releases (`sinhaankur/WatchTower`) for auto-update. In dev/unpackaged it falls back to the GitHub API to surface "update available" without auto-installing. `npm` is resolved via `path.dirname(process.execPath)` first because Electron does not inherit shell PATH on Linux/macOS.

### Configuration discovery

The container-update service searches for `watchtower.yml` in this order: `/etc/watchtower/`, `/opt/watchtower/config/`, `./config/`, `./`. The deployment service uses env vars instead: `WATCHTOWER_REPO_DIR`, `WATCHTOWER_NODES_FILE`, `WATCHTOWER_APPS_FILE`, `WATCHTOWER_TRIGGER_TOKEN`, `WATCHTOWER_DATA_DIR`, `WATCHTOWER_BUILD_DIR`.

### Local runtime state: `.dev/`

`.dev/` (git-ignored) is the local dev state directory. `api/runtime.py` writes `watchtower-service.{pid,log}` and `terminal-audit.log.enc` (Fernet-encrypted command history) here. `run.sh` separately writes `/tmp/watchtower-{api,web}.log`. Don't commit anything from `.dev/`.

### License tier (Free / Pro) — `watchtower/api/edition.py`

WatchTower ships open-core. The deploy/run-locally/integrations core is free forever. Team-collab, observability, HA, and SSO features are gated behind a Pro tier. The current implementation reads `WATCHTOWER_TIER` env (`free` | `pro`, default `free`) and exposes the result via `GET /api/edition`. When billing integration lands (Stripe / license keys), this becomes a DB lookup against the validated license — same gate function, different source — and existing routes don't change.

**Adding a Pro feature** (3 steps, no exceptions):

1. **Register the feature key** in `PRO_FEATURES` in `watchtower/api/edition.py`. The dict entry is the public contract — frontend reads `name` + `description` for the upsell card.
2. **Gate the route** with `Depends(require_pro("feature-key"))`. Returns `402 Payment Required` with `{tier, feature, feature_name, feature_description, upgrade_url, message}` on Free. The frontend uses the structured detail to render a feature-specific upsell, not a generic paywall.
3. **Wrap the page UI** with `<ProLock feature="feature-key">` (in `web/src/components/ProLock.tsx`). Use `useProFeature("feature-key")` to short-circuit the component before any data fetch — avoids a useless 402 in the network tab and renders the lock immediately.

The TypeScript hook (`useEdition()`, `useProFeature()` in `web/src/hooks/queries.ts`) caches the tier for 5 minutes — tier doesn't flip mid-session in any normal flow, and refetching on every mount would mean every page round-trips `/edition` before deciding what to render. Defaults to `false` (locked) on loading/error so we never accidentally show a Pro feature to a Free user during a network blip.

**Tests for Pro-gated routes** must `monkeypatch.setenv("WATCHTOWER_TIER", "pro")` to exercise the unlocked path, and a separate test should hit the route on Free to confirm the 402 contract still holds. See `tests/test_audit.py::test_audit_read_returns_402_on_free_tier` for the pattern.

## Release discipline (READ BEFORE TAGGING)

**Never push a tag without running `./scripts/preflight.sh` first.** **Never call a release Stable without `./scripts/verify-release.sh vX.Y.Z` passing afterward.** The full standard is in `RELEASE_QUALITY.md` at the repo root.

Tonight's session shipped 16 releases (1.6.2 → 1.12.1) because issues were caught after users had them — broken DMGs, missing alembic migrations, cross-arch Python bundles. Every one of those would have been caught by the preflight script. The discipline exists because the alternative is the user paying for our mistakes in confusion and reinstalls. The two scripts:

- `scripts/preflight.sh` — local, before `git tag`. Runs tests, lint, frontend build, electron-builder pack, and verifies the bundled Python actually imports `watchtower + pydantic_core + cryptography + alembic`. Catches structural issues that pass type-checks but break at install-time.
- `scripts/verify-release.sh vX.Y.Z` — local, after CI succeeds. Downloads each Mac DMG and Linux AppImage from the GitHub Release, runs `file` against each bundle's `_pydantic_core.so`, and confirms the architecture matches the artifact name (so an arm64 DMG never ships with x86_64 binaries again).

If either script fails, **don't auto-update users**. Either re-run the failing CI matrix entry, ship as Beta only (when the channel split lands), or cut a fresh patch with the fix. Don't say "it'll probably work" — every "probably" tonight became a real user incident.

Add new checks to whichever script catches them when a regression slips through. The checklist grows from real failures, not imagined ones.

## Things that bite

- **Electron mode skips the run.sh-started backend.** When `MODE=desktop`, `run.sh` *kills* anything on port 8000 and lets Electron start its own. Don't add backend-start logic to desktop mode without coordinating with `desktop/main.js`.
- **`pip install -e .` is required.** The `$VENV/.deps_installed` sentinel won't catch the case where the venv exists but `watchtower` isn't installed editable; `run.sh` re-runs `pip show watchtower` unconditionally to handle this.
- **`WATCHTOWER_API_TOKEN=dev-watchtower-token` is required even in dev mode.** Dev mode no longer accepts arbitrary bearers. If auth seems broken in local dev, check that `.env` is being sourced and the token matches.
- **Frontend builds run `tsc --noEmit` first.** A type error fails the build silently if you only watch the Vite output — check stderr.
- **CORS `allow_origins`** is read from `CORS_ORIGINS` env (defaults include `localhost:3000/8000` and `127.0.0.1:5173/5222`). Adding a new dev port means updating that env or the default list.
- **`X-Watchtower-Token` ≠ `Authorization: Bearer`.** Deploy-trigger endpoints accept the former (`WATCHTOWER_TRIGGER_TOKEN`); FastAPI auth uses the latter (`WATCHTOWER_API_TOKEN`). Mixing them up produces confusing 401s.
- **Locked out by install-owner mode?** Run `watchtower-deploy reset-installation-owner` from the WatchTower host shell. This clears the `InstallationClaim` row so the next sign-in becomes the new owner. The recovery is shell-gated (no public API endpoint) on purpose — anyone with shell access can already do worse than reset ownership.
- **`alembic check` SAWarning on `org_nodes` is benign.** Older SQLite installs accumulated duplicate FK constraints on `created_by_user_id` / `updated_by_user_id` (5 entries in PRAGMA where the model declares 3) from a past batch migration that left the original anonymous FKs alongside the new named ones. Functionally inert — SQLite enforces them identically — but autogenerate's compare logic can't reconcile named-vs-anonymous, so it logs a SAWarning every run. Fresh installs (incl. all Postgres deployments) get the correct 3 FKs from the migrations. Don't try to "fix" by rebuilding the table; the cost outweighs the benefit for a small low-write table.
