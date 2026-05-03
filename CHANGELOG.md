# Changelog

Curated, human-friendly history of WatchTower releases. Auto-generated GitHub Release notes (per-PR summaries) are at https://github.com/sinhaankur/WatchTower/releases — this file groups changes by theme + skips the routine ones.

## Versioning

- **Patch versions** (1.5.X) ship features, bug fixes, and improvements that don't break existing installs. Auto-update applies them silently on next quit.
- **Single source of truth**: `watchtower/__init__.py:__version__`. `scripts/sync_versions.py` propagates to all `package.json` files + `docs/index.html` on each release.

---

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
