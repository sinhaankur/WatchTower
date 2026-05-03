# Changelog

Curated, human-friendly history of WatchTower releases. Auto-generated GitHub Release notes (per-PR summaries) are at https://github.com/sinhaankur/WatchTower/releases — this file groups changes by theme + skips the routine ones.

## Versioning

- **Patch versions** (1.5.X) ship features, bug fixes, and improvements that don't break existing installs. Auto-update applies them silently on next quit.
- **Single source of truth**: `watchtower/__init__.py:__version__`. `scripts/sync_versions.py` propagates to all `package.json` files + `docs/index.html` on each release.

---

## 1.8.0 — Cloudflare Phase 2 + environment badge + setup-mode bridges

Three meaningful pieces that together close most of the "feels incomplete" gaps from 1.7.x.

### Cloudflare Phase 2 — DNS automation
The token saved in 1.7.0 starts being useful. Each `CustomDomain` can now be wired to a stored Cloudflare credential; WatchTower creates/updates/deletes the A record automatically.

- New `watchtower/cloudflare_dns.py` service with strict zone-suffix matching (a token scoped to `example.com` resolves correctly for `app.example.com`; never silently falls back to a parent zone the token can't actually access).
- New columns on `custom_domains`: `cloudflare_credential_id`, `cloudflare_zone_id`, `cloudflare_record_id`, `cloudflare_target_ip`, `cloudflare_synced_at`. Migration `4183fe5d8e83`.
- New endpoints under `/api/integrations/cloudflare/projects/{id}/domains/{id}/`: `sync` (idempotent — call twice with the same IP, get one record) and `unsync` (treats record-already-gone as success).
- New **Domains** tab in `ProjectDetail` — add domains, see CF sync status, sync/unsync per-domain. Picks the credential from the dropdown when more than one is connected.
- Phase 2 keeps `proxied=False` (DNS-only / "grey cloud") so existing Let's Encrypt cert flows continue to work. Phase 3 (Load Balancer) will flip to `proxied=True` when fronting the LB.

### Environment badge
Tonight's repeat confusion between the installed `.app` and the dev-clone backend was exactly what this catches.

- New `GET /api/runtime/environment` (public — no auth needed; surfaces no secrets) returns `{ env, mode, version, insecure_dev_auth, hostname, platform, python, db, web_dist_source }`. Mode is auto-detected from the executable path (desktop / pipx / dev-clone / wheel / container / unknown).
- Sidebar footer shows a small color-coded badge **only when** the install isn't a "boring desktop + production" combo. Red for `insecure_dev_auth=true`, amber for non-prod env, slate for non-desktop modes.
- Operator-set `WATCHTOWER_ENV=dev|staging|production` (defaults to `production`).

### Setup-mode bridges (finishes WIP)
The `desktop/preload.js` exposed `openTerminal` / `copyText` / `openExternal` to the renderer with no matching `ipcMain.handle` in `main.js` — every renderer call rejected silently. Added the three handlers (Terminal.app on macOS, x-terminal-emulator/xterm on Linux, cmd.exe on Windows; clipboard.writeText; shell.openExternal with http(s)-only validation).

Tests: 226 pass.

## 1.7.2 — Owner-mode lockout recovery (CLI)

If your sign-in maps to a different internal user_id than the existing installation owner (e.g. token rotation, switching from API token to GitHub OAuth, or a buggy claim from an earlier broken release) you'd get stuck on:

> *This WatchTower installation is owned by X. Ask an owner/admin to invite your account before accessing resources.*

…with no in-app recovery. The previous "fix" required hand-editing the SQLite DB.

- New CLI: `watchtower-deploy reset-installation-owner` clears every `InstallationClaim` row. The next sign-in re-claims ownership cleanly. Idempotent.
- Login page's ownership advisory now points at the CLI instead of "edit the SQLite DB".
- Recovery is shell-gated on purpose — anyone with shell access on the WatchTower host can already do worse than reset ownership, so no public API surface needed.
- Documented in CLAUDE.md → Things that bite.

## 1.7.1 — Templates page: actionable error messaging

Replaced the generic "Could not load templates" with status-aware messaging:

- **401** → blue info banner reading *"Sign in to view the template catalog"* with a one-click **Sign in →** button straight to `/login`. Previously read like a backend outage when it was actually just an expired session.
- **5xx** → red banner with a **Retry** button.
- **Other** → still shows whatever the server returned.

The endpoint itself was never broken for guests (verified end-to-end against the live backend); the bad UX was the SPA conflating "no auth" with "server down."

## 1.7.0 — Cloudflare integration (Phase 1: foundation)

The first slice of Cloudflare support: **store and verify API tokens** so future phases can use them. Phase 1 ships no user-visible deployment automation on its own — it lays the rails. Roadmap:

- **Phase 1 (this release)** — token storage, verification against Cloudflare API, CRUD UI in Integrations.
- **Phase 2** — auto-manage DNS A/AAAA records when a project gains a custom domain.
- **Phase 3** — provision a Cloudflare Load Balancer with primary + standby pool members so traffic fails over automatically when a node goes down.
- **Phase 4** — Cloudflare Tunnel connectors per node so HA works for nodes behind NAT (home self-hosting).

What's in this release:

- New `CloudflareCredential` model + migration `3603b4e517f3`. Tokens stored encrypted via `WATCHTOWER_SECRET_KEY` (Fernet); plaintext only round-trips through `decrypt_secret` at use time.
- New `watchtower/api/cloudflare.py` router with four endpoints under `/api/integrations/cloudflare`: list, create (with verification), per-credential re-verify, delete. All audited.
- Verification calls Cloudflare's `/user/tokens/verify` then `/accounts` to capture the friendly account name. Saving an unverifiable token returns 400 — no silent broken-credential rows.
- New "Cloudflare" section in **Integrations** page: connect a token, see verified accounts, re-verify, remove.
- Token plaintext is **never** returned by the API. Read responses carry only account_id, account_name, and last_verified_at.

To use: get a Cloudflare API token at [dash.cloudflare.com → API Tokens](https://dash.cloudflare.com/profile/api-tokens). For Phase 2+ the recommended scopes will be Account Settings:Read + Zone:Read + DNS:Edit; Phase 1 only needs the verify endpoint, which any token can call.

Tests: 226 pass.

## 1.6.5 — Login UX: GitHub sign-in is the obvious primary path

The earlier login page made every auth method a full-width button stacked one after another, with the "Quick Dev Login" rendered as a giant red CTA at the top and "Continue as Guest" full-width below GitHub sign-in. New users skipped past GitHub, landed in Guest mode, then hit "Guest mode can't deploy to remote nodes" walls. Instead of fixing the walls, fixed the funnel.

- **GitHub sign-in is the only big button** at the top of the card now.
- **Guest mode + Quick Dev Login + API token** are demoted to small links under an "Other ways to sign in" expander. Open by default? No — collapsed, so the GitHub CTA is unmistakable.
- **Dev mode + ownership warnings** moved into a collapsed "Server status" details at the bottom. Still visible, no longer competing with the primary action.
- **Wording fix on the ownership lockout** — explicit recovery hint pointing at `installation_claims` for self-host operators who locked themselves out.

No backend / API changes. Pure SPA. Build a 6KB smaller `index.js` chunk than 1.6.4 because the dropped explanation blocks shed some markup.

## 1.6.4 — Fix login (device-flow start crash)

The `requests` lazy-import optimisation in 1.6.2 was broken: Python's PEP 562 module-level `__getattr__` only fires on *external* attribute access (`enterprise.requests`), NOT on bare-name lookups *inside* the module. So `requests.post(...)` and `except requests.RequestException` both hit `NameError` — every `POST /api/auth/github/device/start` returned 500 "Internal server error", making sign-in impossible. No test covered the success or RequestException paths, so it shipped.

- **Reverted the lazy `__getattr__`**; restored top-level `import requests` in `watchtower/api/enterprise.py`. Cold-start regresses ~140 ms vs 1.6.2 but the app actually works, which trumps the savings.
- **Added `tests/test_github_device_flow.py`** with two regression tests: success path (200 + user_code) and upstream-failure path (raises `RequestException` → 502, not 500).
- Net cold-start vs pre-1.6.2: still ~30% faster (init_db fast-path + WATCHTOWER_SKIP_DB_INIT remain).

Tests: 226 pass.

## 1.6.3 — Fix `pipx install` (and the desktop `.app`)

`pyproject.toml` only declared 8 of the 16 runtime dependencies the app actually imports — `requirements.txt` carried the full list, but pip ignores that file when installing from a wheel. Result: every user who tried `pipx install watchtower-podman` (or used the desktop `.app`, which spawns the pipx-installed backend) hit a `ModuleNotFoundError: No module named 'slowapi'` on first request.

- **Added the 9 missing direct dependencies** to `pyproject.toml`: `slowapi`, `sqlalchemy`, `alembic`, `psycopg2-binary`, `python-dotenv`, `pydantic-settings`, `httpx`, `redis`, `rq`, `openai`, plus `cryptography` (used directly by `_ensure_secret_key`'s Fernet path; previously only there transitively via fabric/paramiko).
- **Added `; sys_platform == 'linux'` marker to `podman`** so macOS / Windows installs don't trip on the Linux-only Podman SDK wheels — matches what `requirements.txt` already does.
- **Verified end-to-end** by creating a fresh venv and running `pip install -e .` from the repo + `from watchtower.api import app` — clean import, all routers loaded.
- Comment in `pyproject.toml` warns future contributors to keep this list in sync with `requirements.txt`.

If you previously installed via `pipx install watchtower-podman` and got the slowapi crash:
```
pipx install --force watchtower-podman
```
…or just upgrade to 1.6.3 once it lands on PyPI.

Tests: 224 pass.

## 1.6.2 — Performance pass: bundle, cold start, hot-path indexes

A focused optimisation release. No behaviour changes for end users; everything below is faster or smaller.

- **Frontend bundle: main chunk 508 KB → 301 KB.** Replaced `framer-motion` (loaded just for one 180 ms page-fade) with a CSS keyframe in `App.css` — saves ~140 KB unminified / ~45 KB gzipped. Added a `prefers-reduced-motion` opt-out.
- **Vendor chunk split.** `vite.config.ts` pins `react`/`react-dom`/`react-router-dom` (~17 KB gzip) and `@tanstack/react-query` (~13 KB gzip) into separate chunks so app-code deploys don't bust their cache for return visitors.
- **`rollup-plugin-visualizer` wired up.** `ANALYZE=1 npm run build` opens a treemap at `web/dist/stats.html` for future bundle audits.
- **Backend cold start: 970 ms → 590 ms (−39%).**
  - `init_db()` fast-path: parses `alembic/versions/*.py` for the head revision and skips the full Alembic load when `alembic_version` already matches. Falls through to the slow path on any mismatch (multiple heads, parse failure, etc.) so new migrations always run.
  - New `WATCHTOWER_SKIP_DB_INIT=true` env var for production deployments that run `alembic upgrade` out-of-band.
  - `requests` import in `watchtower/api/enterprise.py` now lazy via module-level `__getattr__` — saves ~140 ms cold (only paid when an OAuth/GHES handler actually fires).
- **DB hot-path indexes.** Added single-column indexes on `Deployment.project_id`, `Build.deployment_id`, `EnvironmentVariable.project_id`, `CustomDomain.project_id`, `DeploymentNode.deployment_id`, `NotificationWebhook.project_id`, `ProjectRelation.related_project_id`. Plus composite indexes `(deployments.project_id, created_at)` and `(builds.deployment_id, started_at)` for the "latest deployment / build for X" hot queries. Migration: `bcf7346cbb81`.
- **N+1 queries flattened.** `list_related_projects` and `run_project_with_related` in `api/projects.py` now do a single LEFT JOIN instead of `1 + N` round-trips per relation.
- **Schema drift fix.** `GitHubDeviceConnectSession` model now declares `nullable=False` on the 5 columns the DB has always had as NOT NULL, and drops `index=True` from `device_code` since the unique constraint already provides the lookup index. Migration `c029f15faa8d` removes the redundant non-unique `ix_github_device_connect_sessions_device_code` index. `alembic check` is now clean for this table.
- **CLAUDE.md update.** Documented the benign `org_nodes` SAWarning (5 PRAGMA FK entries vs 3 declared — duplicates accumulated from a past batch migration; functionally inert).

Tests: 224 pass.

## 1.6.0 — GitHub Device Flow + desktop tool detection

End users can finally sign in with GitHub directly from the desktop app, and the runtime status panel correctly detects Tailscale / Docker / Podman on macOS without the user having to fix shell PATH.

- **GitHub Device Flow shipped with a baked-in public Client ID.** Same model as the `gh` CLI — no client secret, no callback URL, no per-install OAuth app registration. The desktop "Sign in with GitHub" button is live out-of-the-box.
- **`Login.tsx` no longer ships a silently-disabled button.** When `/api/auth/status` reports `github_configured: false`, the SPA now opens the setup guide instead of rendering an inert grey button with `cursor-not-allowed`.
- **Desktop PATH augmentation.** `desktop/main.js` prepends Homebrew, Tailscale.app, Docker.app, and Podman Desktop paths before spawning the backend. Electron does not inherit shell PATH on macOS / Linux, which previously caused `which tailscale` to fail and report "not connected" even on machines with Tailscale running.
- **Backend tool resolution.** `api/runtime.py` falls back to a curated list of absolute paths (`/usr/local/bin`, `/opt/homebrew/bin`, `/Applications/Tailscale.app/Contents/MacOS`, …) when the binary isn't on PATH.
- **`.env` auto-load in desktop builds.** `loadDotEnvIntoProcess()` reads the repo `.env` so dev runs pick up `WATCHTOWER_GITHUB_DEVICE_CLIENT_ID` without re-exporting.
- **`datetime.utcnow()` deprecation cleanup.** Python 3.12 emits warnings for naive `utcnow` / `utcfromtimestamp`; replaced 25 call sites with timezone-aware equivalents that strip tzinfo to keep the existing naive `DateTime` schema. Warning count in test runs: 701 → 79.
- **Trimmed Windows CI annotation noise.** Failure path no longer emits a red `::error` annotation per uvicorn INFO log line. Logs stay in the run output and the artifact upload; the PR view gets one summary annotation.

Tests: 224 pass.

## 1.5.20 — Autonomous-ops loop hardening

The autonomous-ops differentiation lane gets a battery of safety + completeness improvements.

- **End-to-end loop test.** Pinned pytest walks the full detect → diagnose → fix → verify path; future regressions surface immediately.
- **Auto-fix idempotency.** Second auto-fix for the same project within 60s → 409 Conflict.
- **Thrash guardrail.** 4th auto-fix in 10 minutes → 429 Too Many Requests, with a "the suggested fix isn't sticking" message.
- **`REGISTRY_TRANSIENT` auto-apply wired.** Was added to the regex library in 1.5.19 but the auto-fix endpoint silently 501'd. Fixed; npm/pip/cargo/go registry flakes now auto-retry.
- **LLM agent handoff for `UNKNOWN` failures.** `/diagnose` includes `agent_prompt` + `agent_route`; SPA exposes an "Ask the agent (prompt copied)" button.

Tests: 162 → ~170.

## 1.5.19 — Seamless VS Code + 6 new failure patterns

The trust pivot — meet developers where they live.

- **Full WatchTower SPA inside VS Code.** `WatchTower: Open Dashboard (in editor)` opens a webview, signed in via the user's stored API token. No browser switch.
- **SPA token bootstrap** (`?wt_token=...` → localStorage → URL stripped via `history.replaceState`). Same pattern Slack/GitHub use for magic-links.
- **Failure-analyzer expansion** (6 → 12 kinds): `GIT_AUTH_FAILED`, `NETWORK_FAILURE`, `BUILD_TIMEOUT`, `TLS_FAILURE`, `REGISTRY_TRANSIENT`, `RUNTIME_OOM`. Pattern ordering pinned by tests.
- **`REGISTRY_TRANSIENT`** marked auto-applicable (action wired in 1.5.20).

## 1.5.18 — Backup export for `~/.watchtower/`

Closes the credential-loss disaster scenario.

- **One-click backup tarball** (Settings → System → Backup & Restore) containing `secret.key` + `watchtower.db`.
- **Loud "⚠ Contains credentials" warning** before download — the tarball IS the credential set.
- **SQLite-only in v1**; Postgres installs get a 503 with a `pg_dump` pointer.
- **Manual restore** documented (`tar -xzf` over `~/.watchtower/`); live restore deferred to v2.
- **Auth-gated** to `can_manage_team=true`.

## 1.5.17 — Auto-apply (loop closed for port-in-use)

The first **fully-closed autonomous remediation loop** in the product.

- **`POST /api/projects/deployments/{id}/auto-fix`**. For `PORT_IN_USE` failures: picks a free port (excluding the failed one), persists to `Project.recommended_port`, queues a fresh deployment with the same branch/commit.
- **Audit log** records `deployment.auto_fix` with `failed_port` + `new_port` for traceability.
- **DiagnosisPanel** restores the "Auto-fixable" badge + "Apply fix" button when `auto_applicable=true`.

## 1.5.16 — Failure analyzer (diagnose)

The detect+diagnose half of the autonomous-ops loop.

- **6 failure patterns** with structured cause + suggested fix: `PORT_IN_USE`, `MISSING_ENV_VAR`, `PACKAGE_NOT_FOUND`, `BUILD_OOM`, `PERMISSION_DENIED`, `DISK_FULL`.
- **Pattern ordering pinned** by tests (disk-full beats permission-denied — root cause wins).
- **Diagnose button** on every failed deployment row.
- **LLM agent fallback** for `UNKNOWN` queued (lands in 1.5.20).

## 1.5.15 — Seamless startup

The user reported "JavaScript error dialogs always there" + "stuck on splash without loading."

- **Silent `uncaughtException`** — log to `~/.watchtower/logs/desktop-electron.log`, no dialog, app keeps running.
- **Real splash progress** — replaces fake scripted animation; reflects backend startup state.
- **Port 8000 auto-fallback** to 8001-8009 when taken (Docker Desktop, jupyter).
- **"Cancel and quit"** button on the splash after 30 seconds.
- **User-facing `127.0.0.1` URLs replaced** with friendly text.

## 1.5.14 — System tab + error report + silent updates

- **Settings → System tab** with dependency status, copy-paste install commands, Recheck (relaunch).
- **Send Error Report** opens user's mail client with diagnostics auto-attached, addressed to the maintainer.
- **Silent auto-update** — no Restart Now/Later modal mid-task; OS notification + apply on next quit.

## 1.5.13 — macOS launch fix

- **`spawn /Applications/Xcode.app` crash fixed** — detect the `/usr/bin/python3` Command Line Tools stub and surface an actionable dialog instead of triggering the Xcode CLT installer mid-launch.
- **Splash logo restored** (was 404'ing in packaged builds because `assets/` wasn't in `desktop/package.json:files`).
- **Top-level safety net** for spawn-side errors that escape try/catch.

---

## Older releases

See https://github.com/sinhaankur/WatchTower/releases for v1.5.0–v1.5.12 release notes.
