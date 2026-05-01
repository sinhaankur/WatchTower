# Changelog

Curated, human-friendly history of WatchTower releases. Auto-generated GitHub Release notes (per-PR summaries) are at https://github.com/sinhaankur/WatchTower/releases — this file groups changes by theme + skips the routine ones.

## Versioning

- **Patch versions** (1.5.X) ship features, bug fixes, and improvements that don't break existing installs. Auto-update applies them silently on next quit.
- **Single source of truth**: `watchtower/__init__.py:__version__`. `scripts/sync_versions.py` propagates to all `package.json` files + `docs/index.html` on each release.

---

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
