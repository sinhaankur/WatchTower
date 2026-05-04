# Changelog

Curated, human-friendly history of WatchTower releases. Auto-generated GitHub Release notes (per-PR summaries) are at https://github.com/sinhaankur/WatchTower/releases — this file groups changes by theme + skips the routine ones.

## Versioning

- **Patch versions** (1.5.X) ship features, bug fixes, and improvements that don't break existing installs. Auto-update applies them silently on next quit.
- **Single source of truth**: `watchtower/__init__.py:__version__`. `scripts/sync_versions.py` propagates to all `package.json` files + `docs/index.html` on each release.

---

## 1.12.5 — Persistent login: stop logging users out on every Electron restart

**Bug**: Desktop users had to re-authenticate against GitHub every time they relaunched the app — sometimes within hours of last sign-in.

### Root cause
`desktop/main.js` generates a fresh random `WATCHTOWER_API_TOKEN` per Electron launch (security hygiene — a token leaked from a prior run can't be reused on the next launch). Pre-1.12.5, `_auth_signing_secret()` in `watchtower/api/util.py` used that token as the **session-token signing key** when `WATCHTOWER_AUTH_SECRET` was unset. So the signing key rotated with the API token, and every signed user session in `localStorage` became invalid the moment you quit + relaunched the app. The browser-mode launch path (which uses the stable `dev-watchtower-token`) was unaffected — only Electron users hit it.

### Fix
- **New `_ensure_auth_signing_key()`** in `watchtower/api/__init__.py` (mirrors the existing `_ensure_secret_key()` pattern): on first run, generates a 256-bit hex secret and atomically writes it to `~/.watchtower/auth-signing.key` with `0o600` perms. On subsequent runs, reads it. Sets `WATCHTOWER_AUTH_SECRET` for the process so `_auth_signing_secret()` finds it.
- **`_auth_signing_secret()` simplified**: only checks `WATCHTOWER_AUTH_SECRET`. The legacy `WATCHTOWER_API_TOKEN` fallback is removed — that's the bug. Last-resort ephemeral generation stays for test harnesses that skip lifespan.
- **Default session TTL bumped 12h → 30 days** (`WATCHTOWER_SESSION_TTL_HOURS=720`). With persistent signing, sessions survive restarts; with 30-day TTL they survive long idle periods. The two together = "stay signed in" by default. Operators can shorten via env for tighter security.

Electron keeps rotating `WATCHTOWER_API_TOKEN` per launch (good — that's defense against token reuse). Sign-in sessions are now decoupled from API token churn.

### Migration / impact
Existing signed-in users get logged out **once** when 1.12.5 lands (their old API_TOKEN-signed tokens fail HMAC against the new persistent key). Sign in once after the update — sessions persist from that point forward.

The `~/.watchtower/auth-signing.key` file is per-install. If you delete it, you log everyone out on the next backend start. Back up alongside `secret.key` if you're snapshotting your data dir.

## 1.12.4 — Bundled Python restored on Windows x64 (built on Linux, packaged on Windows)

Restores the seamless "download .exe, run, done" install experience for Windows x64 that 1.12.3 had to defer. Mac and Linux already had this since 1.11.

### Why a different pattern for Windows
v1.11–1.12.3 tried to build the in-app Python bundle on the windows-latest runner during the desktop matrix step. Two failure modes hit us:
- **v1.11.0 → v1.12.1**: native install via `python.exe -m pip install --upgrade pip` deadlocked indefinitely because Windows file locking blocks pip from replacing its own pip.exe while running.
- **v1.12.2**: rerouted to cross-install via host `python3 -m pip install --target --platform win_amd64 --only-binary=:all:`. This RUNS on Windows, but takes 45+ min for ~3000 wheel-extracted files (Defender scanning each on NTFS). The CI run timed out or got cancelled at the 45-min wall every time.

The same `pip install --target` finishes in ~3 min on a Linux runner. So 1.12.4 splits the work: build the bundle on Linux, ship it as a CI artifact, download it into the windows-latest desktop job before electron-builder packages the .exe.

### Workflow changes (`.github/workflows/release.yml`)
- **New job `build-windows-bundle`** runs on `ubuntu-latest`, calls `scripts/build-python-bundle.sh TARGET=windows-x64`, uploads `desktop/python-bundle/python/` as the artifact `windows-x64-python-bundle` with `if-no-files-found: error` (so a silent empty upload fails loudly instead of shipping an empty bundle).
- **`build-desktop` matrix gains `bundle_source`** with three values:
  - `inline` — Mac arm64/x64 + Linux x64/arm64. Build on the matrix runner. Same as before.
  - `artifact` — windows-x64. Downloads from `build-windows-bundle`, then a sanity-check step verifies `python.exe` + `_pydantic_core.pyd` are present before electron-builder runs.
  - `skip` — linux-armv7l, windows-arm64. No PBS target exists for these. Placeholder dir, system/pipx fallback at runtime.
- `build-desktop` now `needs: [create-release, build-windows-bundle]`. The Linux bundle build runs in parallel with `create-release` so it usually doesn't extend the critical path; worst case adds ~3 min.

### What this means for users
Windows x64 users now get the same one-step install experience as Mac/Linux: download `WatchTower-1.12.4-win-x64.exe`, run, dashboard appears. No `pipx install watchtower-podman` required. (Windows arm64 still falls back to system/pipx — no python-build-standalone target exists for that arch.)

## 1.12.3 — Defer bundled Python on Windows so the win-x64.exe actually ships

v1.12.2 attempted to fix the missing `win-x64.exe` by rerouting the bundle script through the cross-install path (host `python3 -m pip install --target --platform win_amd64 --only-binary=:all:`). The cross-install **runs** on Windows but is impractically slow — 45+ min on the GitHub Actions windows-latest runner before being cancelled, same effective shape as v1.12.1's native-install hang. Probable cause: Defender scanning each wheel-extracted file on NTFS (a single `pip install --target` for our requirements.txt fans out to ~3000 small files; Linux runners finish the same install in ~3 min).

### What 1.12.3 changes
- `.github/workflows/release.yml`: `bundle_target` for the windows-x64 matrix entry is now `""` (matching windows-arm64 + linux-armv7l, which already had no PBS target). The Windows x64 installer is now produced **without** an in-bundle Python.
- The `scripts/build-python-bundle.sh` cross-install fix from 1.12.2 stays in place — when we move the windows bundle off the Windows runner (e.g. cross-install on a Linux runner, upload as artifact, download in the windows-x64 job), the code path is ready.

### What this means for Windows users
Same as the **1.10.x** experience and **windows-arm64 today**: install the EXE, then if it can't find a Python with `watchtower-podman`, the launcher prompts to `pipx install watchtower-podman` (the existing fallback in `main.js`'s `resolvePython()`). Mac and Linux x64/arm64 continue to ship bundled Python and need no terminal.

### Why ship as a temp regression instead of holding the win-x64.exe
v1.12.1 has no win-x64.exe at all — Windows x64 users have no installer to download. Shipping a working .exe with a 1-line "you also need pipx" instruction is strictly better than no .exe. The bundled-Python-on-Windows work is tracked as follow-up.

## 1.12.2 — Windows x64 installer was missing from v1.12.1 (build hang fix)

**The v1.12.1 release shipped without a `WatchTower-1.12.1-win-x64.exe` installer.** Windows x64 users had no installer to download — only the arm64 EXE made it to the release page.

### Root cause
`scripts/build-python-bundle.sh` ran `python.exe -m pip install --upgrade pip` against the bundled python-build-standalone Python on the Windows runner. Windows file locking prevents pip from replacing its own `pip.exe` while it's running, so the install hung forever — the windows-x64 CI job sat at "Build bundled Python (windows-x64)" for 80+ minutes before being cancelled. The job never reached the "Build & publish installers" step, so the EXE was never uploaded.

This was a latent bug in 1.11.0+: any release that bundled Python on Windows would hit the same hang. v1.10.x didn't bundle Python on Windows so the issue didn't surface.

### Fix
The bundle script now special-cases `windows-x64` and routes it through the **cross-install path** (which uses the host's `python3` from `actions/setup-python` plus `pip install --target --platform win_amd64 --only-binary=:all:` to download win_amd64 wheels into the bundled Python's site-packages). No `python.exe` ever runs during bundle assembly, so Windows file locking can't deadlock it. Same code path that already produces the Mac arm64 / Mac x64 / Linux arm64 bundles successfully.

### Verify-release tightening
`scripts/verify-release.sh` now asserts each expected per-platform installer (`WatchTower-X.Y.Z-mac-arm64.dmg`, `-mac-x64.dmg`, `-linux-*.AppImage`, `-win-x64.exe`, `-win-arm64.exe`) is present at the release tag. The previous asset-count check (25-30) didn't always catch a single-platform miss; a named-asset assertion does. Tonight's missing `win-x64.exe` would have been caught immediately.

### Frontend lint threshold acknowledged
This is the first preflight-gated release (v1.12.1 was tagged before `scripts/preflight.sh` existed). The frontend has 11 pre-existing eslint warnings — 5 `react-refresh/only-export-components` (constants exported alongside components, requires file-splitting to fix) and 6 `react-hooks/exhaustive-deps` (intentional patterns where adding the deps would cause re-render loops). `web/package.json`'s lint script now uses `--max-warnings 11` to acknowledge this baseline; preflight passes cleanly. New warnings beyond 11 still fail the build. Cleanup of these 11 is tracked as follow-up tech debt — not blocking the windows-x64 ship.

## 1.12.1 — Critical stability fix: per-arch DMG/AppImage/EXE were overwriting each other

**This was the bug behind v1.12.0's `ModuleNotFoundError: pydantic_core._pydantic_core` on Mac**, and the same hazard existed on every platform (it's also why Linux x64's smoke test failed in 1.11.0).

### Root cause
`desktop/package.json` declared `mac.target.arch: ["x64", "arm64"]` (and analogous per-platform arrays for Linux and Windows). Despite the CI matrix passing `--mac --arm64` or `--mac --x64` to electron-builder per matrix entry, the package.json arch list **adds to** the build set instead of overriding it. So:
- The Mac arm64 matrix entry built the arm64 DMG (with arm64 Python bundle ✓) **and** the x64 DMG (with arm64 Python bundle ✗).
- The Mac x64 matrix entry built the x64 DMG (with x64 Python bundle ✓) **and** the arm64 DMG (with x64 Python bundle ✗).
- Both matrix entries upload to the same GitHub Release, with `overwrite published file` semantics. Whichever job finished second overwrote the other's correct DMG with its wrong-arch one.
- Result: every published DMG had a 50/50 chance of containing the wrong-arch Python bundle. When the .app's launcher ran `python -m uvicorn ...`, the bundled Python loaded the x86_64 `_pydantic_core.so` on Apple Silicon (or vice versa), which can't be loaded → `ModuleNotFoundError`.

The same overwrite hazard affected Linux (3-way: x64, arm64, armv7l) and Windows (2-way: x64, arm64).

### Fix
- `mac.target`, `linux.target`, `win.target` simplified to bare target name lists (`["dmg", "zip"]`, `["AppImage", "deb"]`, `["nsis", "zip"]`). Without an `arch` field, electron-builder uses **only** the `--x64` / `--arm64` / `--armv7l` flag passed via the CI matrix's `eb_args`. Each matrix entry now produces exactly one arch's worth of artifacts.
- **Self-healing fallback in `desktop/main.js`:** `resolvePython()` now runs `probePythonCandidate()` against the bundled Python before returning it. If the bundle is broken (any C-extension dep can't import), it falls through to the dev-clone `.venv` → `WATCHTOWER_PYTHON` env override → pipx Python → system Python chain. Means a partial/broken bundle no longer permanently breaks the app — the .app keeps working with whatever other Python the user has, and the diagnostic log records `python.bundled-broken` so we can see if the regression ever recurs.

### Migration / impact
v1.12.0 Mac users hit the broken bundle. v1.11.0 Linux x64 users would have hit it too (smoke test caught it). v1.12.1 ships intact bundles for every (platform × arch) combo and won't lose its way even if a future release somehow ships a broken one.

## 1.12.0 — License tier infrastructure + Pro feature gating + critical 1.11 fixes

Two distinct workstreams in one release:

### License tier (open-core foundation)
The plumbing for monetization is in place. Future Pro features can ship and be locked behind a flag from day one — when billing integration lands later (Stripe / Paddle / license keys), the gate stays the same and only the source-of-truth changes from "env var" to "validated license record". No backwards-incompat refactor.

- **`watchtower/api/edition.py`** — `current_tier()` reads `WATCHTOWER_TIER` (`free` | `pro`, defaults `free`). `require_pro("feature-key")` is a FastAPI dependency that returns **402 Payment Required** with structured `{tier, feature, feature_name, feature_description, upgrade_url, message}` on Free tier. The structured detail lets the frontend render feature-specific upsells, not a generic paywall. Five feature keys registered: `audit-log`, `team-rbac`, `multi-region-failover`, `sso`, `priority-support`.
- **`GET /api/edition`** — exposes the tier + feature flag map to the frontend so it can pre-empt 402s by hiding Pro UI elements.
- **Frontend gating** — new `useEdition()` + `useProFeature()` hooks (5-min cache, `false` default on loading/error so we never accidentally show a Pro feature to a Free user during a network blip). New `<ProLock feature="...">` component renders a feature-specific upgrade card with name + description + upgrade CTA + settings link.
- **First Pro feature: Audit Log viewer.** The page existed since 1.6 but is now gated behind `audit-log`. Free installs see the lock card; Pro installs see the table. Backend regression test (`test_audit_read_returns_402_on_free_tier`) guards the 402 contract so future refactors can't silently drop the gate.

### First non-Pro gap fix: Rollback button
The deployment table now shows a **↶ Rollback** button next to LIVE deployments. Clicks confirm, queue a new deployment that re-deploys the prior commit, and mark the current LIVE row as ROLLED_BACK — backend already supported this since 1.0; the UI just didn't expose it. Per-row in-flight flag prevents double-click races.

### Critical 1.11.0 fixes (these prevented Linux installs from working at all)
The bundled-Python release in 1.11.0 had two real bugs that would have stranded Linux users:
- **`alembic/env.py` was missing from the bundled site-packages** — `_alembic_config()` looked at `repo_root/alembic` which resolved to the bundled Python's site-packages root, where the third-party alembic package lives, not our migrations. Fresh DB installs would crash with `ImportError: Can't find Python file`. **Fix:** `_alembic_config()` now searches in priority order: `WATCHTOWER_ALEMBIC_DIR` env override → `<watchtower-package>/alembic/` (where the build script now copies our migrations) → `<repo>/alembic/` (dev clone). Picks the first candidate whose `env.py` exists. The build script now copies the repo's `alembic/` directory into the bundled `site-packages/watchtower/alembic/` so package-relative resolution works in shipped builds.
- **Linux arm64 cross-install crashed** with `cannot execute binary file: Exec format error` because the script tried to run `python -m pip --version` on the arm64-architecture bundled Python while running on an x64 host. **Fix:** detect host arch first, only invoke the bundled Python when arch matches.

The 1.11.0 macOS DMGs do work (smoke test only runs on Linux). Mac users on 1.11.0 would have hit the alembic bug too on a fresh install, but the data-dir-already-stamped fast path in `init_db()` saved them — anyone with a `~/.watchtower/watchtower.db` from a prior version skipped Alembic entirely. 1.12.0 fixes both classes of users.

## 1.11.0 — Bundled Python: install once, never touch a terminal

The desktop app no longer depends on `pipx install watchtower-podman`. WatchTower 1.11+ ships its own self-contained Python interpreter (~120 MB) inside the `.app` bundle, with all dependencies pre-installed. The end-user install story is now: download DMG → drag to Applications → double-click. No `pipx`, no PEP 668, no `ModuleNotFoundError`, no second `pipx install` command in a separate terminal step.

### What changed
- **`scripts/build-python-bundle.sh`** — downloads the [astral-sh/python-build-standalone](https://github.com/astral-sh/python-build-standalone) tarball for the target arch, installs `requirements.txt` + the watchtower package itself into it, strips `__pycache__` and `pip`/`setuptools`. Supports both native install (when host arch matches) and cross-install via `pip install --target --platform --only-binary` (e.g. building the Mac x64 bundle on the Apple Silicon CI runner). Pinned to `python-build-standalone` tag `20260414`, Python 3.12.13.
- **`desktop/package.json`** — `extraResources` now includes `python-bundle/python` → `Resources/python` so the bundled interpreter ships inside `WatchTower.app/Contents/Resources/python/`.
- **`desktop/main.js` `resolvePython()`** — checks the bundled Python at `process.resourcesPath/python/bin/python3` (or `python.exe` on Windows) **first**. The pipx fallback is still there for upgraders who somehow lose the bundled dir, but it's no longer the recommended path. Dev-clone `.venv` and system Python rounds out the chain.
- **`.github/workflows/release.yml`** — split the Mac matrix entry into two arch-specific entries (the previous single-entry build couldn't disambiguate which Python bundle goes in which DMG). Added a `Build bundled Python` step per matrix entry that runs the script with `TARGET=<bundle_target>`. Arches without a `python-build-standalone` target (armv7l Linux, arm64 Windows) get an empty placeholder dir so `extraResources` doesn't error and fall back to the legacy pipx path at runtime.

### New failure dialog
Replaced developer-jargon copy ("ImportError", "ModuleNotFoundError", "PEP 668") with plain English: **"WatchTower didn't start"** + plain-English detail + a **Reinstall WatchTower** button as the primary action. A **View Log** button surfaces the technical log for users who want to investigate. The old "Copy prerequisite install command" button is gone — there is no prerequisite anymore.

### Bundle size
The Mac DMG grows from ~110 MB → ~230 MB. Acceptable trade-off: one click vs. two installs + a terminal. Future optimization: switch to the `_stripped` python-build-standalone variant which drops debug symbols (~20 MB savings), and prune unused stdlib modules.

### Migration
Existing 1.10.x installs auto-update via the in-app dialog. The first 1.11 launch uses its bundled Python; the user's old `~/.local/pipx/venvs/watchtower-podman` venv becomes orphaned and can be removed with `pipx uninstall watchtower-podman`.

## 1.10.2 — Auto-update actually installs on unsigned macOS

Auto-update has been quietly broken on Mac since v1: `electron-updater` calls Squirrel.Mac under the hood, which **silently refuses to atomically replace bundles that lack a Developer ID signature**. Users would click "Restart and Install", the app would quit, reopen as the OLD version — and from the user's perspective updates simply didn't work. The 1.10.0 dialog made the prompt visible but didn't fix the install step itself; the manual "Download Manually" fallback worked but required drag-drop.

This release replaces the broken Squirrel-based path with a self-written DMG self-replace helper that works for unsigned bundles.

### Self-replace helper (Mac)
- `applyMacUpdate(version, parentWindow)` downloads the version-specific `.dmg` directly from the GitHub Releases URL (handles 302 redirects to S3, content-length progress, 60s socket timeout, partial-download cleanup).
- `spawnMacUpdaterScript(dmgPath)` writes a bash script to `~/Library/Caches/WatchTower/apply-update.sh` that:
  1. Waits for the parent app PID to exit (max 30s polling).
  2. Mounts the DMG with `hdiutil -nobrowse -noautoopen`.
  3. Replaces `/Applications/WatchTower.app` — direct `rm/cp` if user-writable (drag-drop installs), `osascript ... with administrator privileges` if root-owned (`sudo cp` installs).
  4. Strips Gatekeeper quarantine (`xattr -cr`) so the new build launches cleanly without "can't be opened" warnings.
  5. Detaches the DMG, removes the cached file, relaunches the new bundle.
- Script logs to `~/Library/Logs/WatchTower-update.log` so a failed update is debuggable without re-launching the .app.
- Spawned with `detached: true` + `unref()` so it survives `app.quit()`.
- The `update-downloaded` dialog's "Restart and Install" button now calls this on Mac instead of `autoUpdater.quitAndInstall()`. Other platforms (Windows NSIS, Linux) keep using `quitAndInstall` — they're either signed or use installers that handle the swap correctly.

### Failure-dialog escape hatch
Even when WatchTower can't start (broken backend, missing dependencies), the user can now recover **without ever opening a terminal**. The "WatchTower failed to start" dialog gains a **Reinstall Latest Version** button (Mac only) that:
- Hits `api.github.com/repos/sinhaankur/WatchTower/releases/latest` for the current tag.
- Confirms with the user (this WILL replace `/Applications/WatchTower.app`).
- Runs the same self-replace helper.

This closes the chicken-and-egg gap: the prior auto-update path required the app to start successfully *before* it could check for updates. If startup was broken (the actual case the user kept hitting), there was no in-app way out — only manual `curl + hdiutil + cp` from the terminal. Now the failure dialog itself can repair the install.

## 1.10.1 — Mac/Windows install commands + Docker Desktop launcher

User on macOS hit a wall the moment they followed the Integrations page install steps: the UI returned **Linux apt commands unconditionally** — `sudo apt install`, `sudo dpkg -i`, `sudo usermod -aG`, `sudo systemctl enable` — none of which exist on Mac. Every "Show install steps" expand was a dead end. Same problem the 1.10.0 service-control fix solved at the runtime level, but the install-commands endpoint still hardcoded `os: linux` and returned the apt set regardless of host platform.

### Install commands are now platform-aware
- New `_mac_install_commands()` returns Homebrew commands (`brew install podman`, `brew install --cask docker`, `brew install cloudflared`, `brew services start nginx`, etc.) plus inline notes where the GUI installer is the easier path (Docker Desktop) or where the integration doesn't apply locally (Coolify is a Linux-server tool — note links the user to the docs instead of pretending the install works).
- New `_windows_install_commands()` returns winget IDs (`winget install --id RedHat.Podman`, `Docker.DockerDesktop`, `tailscale.tailscale`, `Cloudflare.cloudflared`).
- `_install_commands_for_host()` dispatches via the existing `_host_platform()` helper.
- `GET /api/runtime/integrations/install-commands` now returns the correct set + an `os: mac | linux | windows` field. The frontend picks them up automatically — same key-by-service shape as before.

### Docker on Mac actually works now
- `_SERVICE_MAP['docker']` switched from type `systemd` to `docker_engine`.
- New `_control_docker_engine()` runs `open -a Docker` on Mac (launches Docker Desktop, no sudo required), `sudo systemctl <action> docker.service` on Linux. Stop/restart on Mac returns a friendly "use the menu bar app" message instead of a sudo error — Docker Desktop has no clean stop CLI and we don't paper over it with `osascript`.
- `_do_service_control()` short-circuits pure-systemd services (`nginx`, `cloudflared`) on non-Linux with a 501 + structured `"manage via brew services"` hint, instead of running `sudo -n systemctl ...` and dumping a password-required error.
- Frontend Docker card drops `enable / disable` from advertised actions (no boot-persistence concept on Docker Desktop).

### Podman start is now idempotent
- `_control_podman()` recognises "already running" / "already stopped" stderr from `podman machine start|stop` and returns 200 success. Repeatedly clicking Start when the engine is already up no longer surfaces a 500 — the UI shows "Podman is already running." and moves on.

## 1.10.0 — Cross-platform service controls + visible auto-update

The desktop app was originally written assuming Linux + systemd. On macOS three things were broken at once: the Podman watchdog and WatchTower auto-update daemon cards both showed misleading "unavailable / not installed" badges, the Podman **Start** button on the Integrations page returned `sudo: a password is required` (because there's no systemd on the Mac host), and macOS auto-update silently failed because the `.app` is unsigned and `electron-updater` can't atomically replace an unsigned bundle. All four are fixed.

### Cross-platform service surface
- New `_host_platform()` helper in `watchtower/api/runtime.py` returns `mac | linux | windows`.
- `_podman_watchdog_status()` and `_watchtower_service_status()` short-circuit on non-Linux with `supported: false` plus a human-readable `message`. The corresponding enable/disable endpoints return 501 with the same message instead of running `systemctl` and failing with shell garbage.
- `_SERVICE_MAP['podman']` is now type `podman` (not `systemd`). The new `_control_podman()` runs `podman machine start|stop|restart` on Mac/Windows and falls back to `sudo systemctl <action> podman.socket` on Linux.
- `_do_service_control()` now returns a structured 500 with `{message, command, needs_terminal, platform}` so the UI can offer Copy / Open in Terminal buttons instead of dumping raw `stderr`.

### Frontend platform awareness
- `WatchdogStatus` type extended with `supported`, `platform`, `message`. New `PlatformNotApplicable` card renders a clean "Not applicable on macOS / Windows" state for both `WatchdogCard` and `WatchTowerServiceCard` instead of the broken toggle.
- `ServiceControls.doAction` recognises the structured `ControlErrorDetail`. When `needs_terminal === true` it renders the attempted command in a one-line `$ …` strip with **Copy** and **Open Terminal** buttons (the latter uses the existing `wt:openTerminal` IPC bridge from 1.9.0; copy primes the clipboard so paste-and-run is one keystroke).
- Podman card no longer advertises `enable / disable` actions — those don't apply to `podman machine` and the Linux equivalent (systemd boot persistence) is the watchdog card's job.

### Auto-update is no longer silent
- The previous "download in background, apply on quit" path made the most common failure mode (unsigned macOS builds losing the atomic-replace race) **completely invisible** — users would quit, reopen, see the same version, and conclude updates were broken. Replaced with an explicit `dialog.showMessageBox` on `update-downloaded`:
  - **Restart and Install** (default) → calls `autoUpdater.quitAndInstall(false, true)`.
  - **Download Manually** (Mac only) → opens the GitHub release page so the user can grab the `.dmg` directly.
  - **Later** → dismiss; we'll prompt again next launch.
- `autoUpdater.on('error')` now surfaces a recoverable dialog with an **Open Release Page** button. Previously a mid-download error went only to `console.warn` — invisible to the user.

### What this unblocks
The Podman **Start** button on Integrations actually starts the engine on Mac (via `podman machine start`) instead of failing with a sudo error. The "Autonomous Operation" section stops cluttering the page with Linux-only daemons that can't work on a laptop. Update prompts arrive with a button to press, not a notification to dismiss and forget. Long-term fix for the unsigned-Mac auto-update is signing + notarization via Apple Developer ID; until then, **Download Manually** is the reliable escape hatch.

## 1.9.1 — CI: retry npm install on transient 502s

The macOS build of v1.9.0 lost a 502 from Electron's binary-download mirror during `npm install` and shipped without any `.dmg` artifacts, breaking auto-update for every existing macOS install. Wrapped both `npm install` steps (web + desktop) in 3-attempt retry loops with exponential-ish backoff (20s, 40s, 60s). Self-heals the next time the registry blips.

## 1.9.0 — Run Locally (Podman) + owner-mode no-claim-for-guests fix

The end-to-end "develop on my Mac, deploy when it's worth paying for a server" loop now actually closes — projects can be **run as a Podman container on localhost** with a single click.

### Run Locally
- New `watchtower/local_runner.py` service: picks a free port, stops any prior container WatchTower started for this project, then either:
  - **Containerfile / Dockerfile present** → `podman build` + `podman run`, exposing the project's `recommended_port`.
  - **Static-site build output** (`dist/`, `build/`, `_site/`, `out/`, `public/`, or root with an `index.html`) → `podman run nginx:alpine` with the output dir mounted read-only.
- Three new endpoints:
  - `POST /api/projects/{id}/run-locally` — start (idempotent).
  - `GET  /api/projects/{id}/run-locally` — fetch current run state.
  - `DELETE /api/projects/{id}/run-locally` — stop.
- New **Run Locally** card on each project's Overview tab — Start / Restart / Stop, with the localhost URL clickable.
- State persists in `$WATCHTOWER_BUILD_DIR/_local_runs/<project_id>.json` so the dashboard renders "running on http://localhost:<port>" across API restarts; a liveness check (`podman container exists`) clears stale rows.

### Owner-mode no longer self-locks via Guest
The 1.6.x lockout loop turned out to be self-perpetuating: the *Guest* user (no `github_id`) would auto-claim install ownership, then any subsequent real GitHub sign-in failed the owner check. Fixed in `_claim_installation_if_needed` — claims now require a real `github_id`. Guests get their own implicit org and can use local features; the next GitHub-authenticated sign-in becomes the legitimate install owner without conflict.

If you previously got locked out, the recovery is unchanged: `watchtower-deploy reset-installation-owner`.

Tests: 226 pass.

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
