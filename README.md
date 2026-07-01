# WatchTower

<p align="center">
  <a href="https://github.com/sinhaankur/WatchTower/blob/main/LICENSE"><img src="https://img.shields.io/badge/license-Apache%202.0%20%2F%20ELv2-blue.svg" alt="Apache 2.0 + Elastic License 2.0" /></a>
  <img src="https://img.shields.io/badge/python-3.8%2B-blue.svg" alt="Python 3.8+" />
  <img src="https://img.shields.io/badge/node-18%2B-brightgreen.svg" alt="Node 18+" />
  <a href="https://github.com/sinhaankur/WatchTower/pkgs/container/watchtower"><img src="https://img.shields.io/badge/container-GHCR-blueviolet.svg" alt="GHCR" /></a>
  <a href="https://sinhaankur.github.io/WatchTower/"><img src="https://img.shields.io/badge/docs-GitHub%20Pages-orange.svg" alt="Docs" /></a>
  <a href="https://github.com/sinhaankur/WatchTower/issues"><img src="https://img.shields.io/github/issues/sinhaankur/WatchTower.svg" alt="Issues" /></a>
</p>

<p align="center">
  <strong>The self-hosting platform that fixes its own failures.</strong><br/>
  Turn the computer you already own into a server that deploys your apps from GitHub, runs your databases, and — when a deploy breaks — diagnoses it and fixes it on its own. Rootless Podman, private over Tailscale, no VPS bill.
</p>

---

### Why WatchTower is different

Coolify, Dokploy, Umbrel, and CasaOS all let you self-host apps. **None of them fix a broken deploy for you.** WatchTower does.

- 🩹 **Self-healing deploys** — when a deployment fails (port conflict, registry flake, OOM…), WatchTower classifies the cause, applies a fix, and retries — automatically. What it can't safely auto-fix, it queues for you with an AI root-cause analysis. Autonomy is a global switch (default off) with a thrash guardrail, so it never fixes recklessly.
- 🖥️ **Your PC, not a rented VPS** — designed to run on the machine you already have. No monthly server bill.
- 🔒 **Rootless & private by default** — Podman-first (no root Docker daemon), reachable over your own Tailscale tailnet — nothing exposed to the public internet.
- 🗄️ **Batteries included** — one-click managed databases (Postgres/MySQL/Mongo/Redis) with auto-wired connection strings and scheduled backups, plus GitHub-push deploys and an app catalog.
- 🔓 **Open-core** — Apache 2.0 + ELv2. Self-host it forever; no lock-in.

> Different from [`containrrr/watchtower`](https://github.com/containrrr/watchtower) (a Docker image auto-updater). This WatchTower is a full self-hosted deploy + database + self-heal control plane for Podman.

---


## Install the App (easiest)

**macOS** — install it like any Mac app:

1. Download the latest `WatchTower-*-mac-arm64.dmg` (Apple Silicon) or `-x64.dmg` (Intel) from [**Releases**](https://github.com/sinhaankur/WatchTower/releases/latest)
2. Open the DMG and **drag WatchTower into Applications**
3. Launch WatchTower from Applications — done

> **First launch:** builds are not yet signed with an Apple Developer ID, so macOS may warn you. Right-click the app → **Open** → **Open** (one time only). If the app still won't start, use [Browser mode](#browser-mode) — same UI, no Electron wrapper.

**Linux** — download the `WatchTower-*-linux-x86_64.AppImage` from [Releases](https://github.com/sinhaankur/WatchTower/releases/latest), then:

```bash
chmod +x WatchTower-*.AppImage && ./WatchTower-*.AppImage
```

**Windows** — run `install\install_watchtower_windows.cmd` from a clone (installer EXE coming soon).

The desktop app is self-contained: it bundles Python and the web UI, stores data in `~/.watchtower/`, and auto-updates from GitHub Releases.

## Get Running in 30 Seconds (from source)

```bash
git clone https://github.com/sinhaankur/WatchTower.git
cd WatchTower
./run.sh
```

That's it. `run.sh` will:
- Create a Python virtualenv and install dependencies (first run only)
- Install Node packages (first run only)
- Build the frontend (first run only)
- Start the backend API on `127.0.0.1:8000`
- Launch the **Electron desktop app** if a display is available, otherwise open the browser at `http://127.0.0.1:8000`

**Other commands:**

| Command | What it does |
|---|---|
| `./run.sh desktop` | Force Electron desktop app |
| `./run.sh browser` | Force browser mode |
| `./run.sh stop` | Kill all WatchTower processes |
| `./run.sh logs` | Tail backend + frontend logs |
| `./run.sh update` | Pull latest code and rebuild dependencies |

> **Requirements:** Python 3.8+, Node.js 18+, npm. Podman optional (only needed for container auto-update mode).

### Easier install paths

If you are installing App Center and do not want to memorize platform-specific steps:

- macOS: `./install/install_watchtower.sh --mode appcenter`
- Linux: `./install/install_watchtower.sh --mode appcenter`
- Windows: `install\install_watchtower_windows.cmd`

For an in-place update of a git-clone install, use:

```bash
./run.sh update
```

### Browser mode

If the desktop `.app` won't launch on macOS — usually because the build is ad-hoc-signed (no Apple Developer ID) and recent macOS versions silently kill ad-hoc Electron helpers — run WatchTower in browser mode instead. Same UI, same features, no Electron wrapper:

```bash
# Option 1 — dev clone
git clone https://github.com/sinhaankur/WatchTower.git
cd WatchTower
./run.sh browser

# Option 2 — pipx (no clone needed)
pipx install watchtower-podman
watchtower-deploy serve --host 127.0.0.1 --port 8000
```

Then open <http://127.0.0.1:8000> in any browser.

The desktop `.app`'s launch-failure dialog detects the Gatekeeper kill specifically and shows a "Use Browser Mode" button that links here. When a Stable release ships with a real Developer ID signature, that warning goes away — end-users downloading a signed DMG from GitHub Releases won't see it.

### Run With Docker

Use the single-node app compose file for a production-like local run:

```bash
git clone https://github.com/sinhaankur/WatchTower.git
cd WatchTower

# Optional: set your own strong token first
export WATCHTOWER_API_TOKEN="change-this-token"

docker compose -f docker-compose.app.yml up -d --build
```

Open `http://127.0.0.1:8000` and authenticate with the token you configured.

Useful Docker commands:

```bash
docker compose -f docker-compose.app.yml ps
docker compose -f docker-compose.app.yml logs -f watchtower
docker compose -f docker-compose.app.yml down
```

---

WatchTower is an operator-facing tool for two adjacent jobs:

1. **Keep existing Podman workloads current** with health-aware image updates.
2. **Deploy applications to your own nodes** with a compact control plane, SSH rollout, and operator-visible status.

The project is intentionally lightweight. It is not trying to replace a full PaaS. It gives teams a clear release path, host operations, and a dashboard-oriented workflow without hiding what happens underneath.

## How They Work Together

```mermaid
flowchart TB
    GH["GitHub<br/><small>OAuth · repos · Pages</small>"]

    subgraph PC["🖥 Your PC"]
        WT["<b>WatchTower</b><br/><small>control plane — deploys + heals</small>"]
        APPS["Apps<br/><small>Podman containers</small>"]
        DBS["Databases<br/><small>postgres · mysql · mongo · redis</small>"]
        BAK["Backups<br/><small>pg_dump · mysqldump · mongo</small>"]
        WT --> APPS
        WT --> DBS
        WT --> BAK
    end

    GH -- "sign-in + code" --> WT
    PC -- "Tailscale (private)" --> DEV["Your other devices<br/><small>phone · laptop · other PCs</small>"]
    PC -- "public web" --> PUB["Public visitors<br/><small>GitHub Pages or custom domain</small>"]

    style WT fill:#fff,stroke:#b91c1c,stroke-width:2px
    style PC fill:#fef2f2,stroke:#fca5a5
    style APPS fill:#ecfdf5,stroke:#6ee7b7
    style DBS fill:#ecfdf5,stroke:#6ee7b7
    style BAK fill:#ecfdf5,stroke:#6ee7b7
```

The wider integration stack slots in around that core:

- **Podman** runs your containerized workloads; **Nginx** routes HTTP/HTTPS traffic
- **Tailscale** creates a secure, encrypted mesh for node SSH and private access
- **Cloudflare** exposes apps to the internet with DDoS protection
- **WatchTower Watchdog** restarts containers after any reboot or crash — no manual intervention

Manage everything from the **Integrations** page: live connection status for the whole stack, watchdog toggle, and install commands.

---

## What It Does

- **Container auto-update mode:** poll running containers, pull newer images, restart safely, and verify health.
- **App Center mode:** register workloads in `config/apps.json`, package from a dev machine, sync to nodes, activate remotely, and confirm rollout state.
- **Operator tooling:** expose guided actions, runtime inspection, and secure host operations from one control surface.
- **AI & autonomous self-heal (optional):** every failed deployment is diagnosed automatically; with the autonomy switch ON, safe fixes (port conflicts, registry flakes) are applied and retried on their own, and everything else waits in a human-approval queue. Connect any OpenAI-compatible LLM for root-cause analysis of unrecognized failures — **a tiny 0.5–2B model under llama.cpp is enough**, so this works on mini-PCs and Raspberry Pis without LM Studio or Ollama. See the [Tiny LLM guide](docs/TINY_LLM_GUIDE.md).

## Choose Your Path

- **Use Podman Auto-Update Service** if you already have a release process and only need safe host maintenance for containers.
- **Use App Center** if you want WatchTower to behave like a compact deployment control plane for websites, APIs, previews, and multi-node rollouts.
- **Use Host Connect / secure terminal flows** if the team needs guided host actions without opening an unrestricted shell path.

## How WatchTower compares

|                                   | **WatchTower** | Coolify | Dokploy | Umbrel / CasaOS |
| --------------------------------- | :------------: | :-----: | :-----: | :-------------: |
| Deploy from GitHub                |       ✅       |    ✅    |    ✅    |   partial (app store) |
| One-click managed databases       |       ✅       |    ✅    |    ✅    |       ✅        |
| **Self-heals a failed deploy**    |     **✅**     |    ❌    |    ❌    |       ❌        |
| Runs on your own PC (not a VPS)   |       ✅       | VPS-first | VPS-first |     ✅        |
| Rootless (no root Docker daemon)  |   ✅ (Podman)  | ❌ (root Docker) | ❌ | ❌ (Docker) |
| Private by default (Tailscale)    |    ✅ built-in |  add-on |  add-on |     add-on      |
| Desktop app                       |       ✅       |    ❌    |    ❌    |       ❌        |

The differentiator is the third row. Everyone lets you self-host apps; **only WatchTower diagnoses and fixes a broken deploy on its own** — apply-and-retry for the failures it recognizes (port conflicts, registry flakes), and an AI root-cause analysis + human-approval queue for the ones it can't. It's built to run unattended on the machine you already own, rootless, without exposing anything to the internet.

*(Comparison reflects public feature sets as of mid-2026. WatchTower is younger than Coolify — it wins on the self-heal + rootless-PC angle, not on breadth or years of hardening.)*

---

## What's New in 1.5.20

### Autonomous-ops loop hardening

- **End-to-end loop test pinned.** A single pytest now walks detect → diagnose → fix → verify in one call and asserts every state transition (regex classification → /diagnose response → /auto-fix queues a fresh deploy → `Project.recommended_port` actually persisted → audit-log row with the right metadata → new pending deploy doesn't inherit the failed deploy's diagnosis). Future autonomy work that breaks the loop fails this test loudly.
- **Auto-fix idempotency + thrash guardrails.** A second auto-fix for the same project within 60 seconds returns 409 (catches double-clicks / network retries). After 3 auto-fixes in 10 minutes the 4th returns 429 — a fix that doesn't stick won't quietly thrash; the human takes over.
- **`REGISTRY_TRANSIENT` auto-apply now wired.** v1.5.19 added the regex but the auto-fix endpoint only handled `PORT_IN_USE`; npm/pip/cargo/go registry flakes silently failed at 501. Fixed: `REGISTRY_TRANSIENT` now triggers a re-deploy as-is (no port change) — the second autonomous-ops loop closed end-to-end.
- **LLM agent handoff for `UNKNOWN` failures.** `/diagnose` now returns `agent_prompt` + `agent_route` for unrecognized failures with logs. The SPA's diagnose panel exposes an "Ask the agent" button that copies the pre-filled prompt to clipboard and navigates to the agent — the regex library's miss-rate becomes a one-click investigation, not a dead end.

## What's New in 1.5.19

- **Seamless VS Code dashboard.** New `WatchTower: Open Dashboard (in editor)` command opens the entire WatchTower SPA inside a VS Code WebviewPanel — diagnose, auto-fix, env vars, audit log, settings, all signed in via the user's stored API token. No browser switch, no second login.
- **6 new failure-analyzer patterns** (12 total kinds): `GIT_AUTH_FAILED`, `NETWORK_FAILURE`, `BUILD_TIMEOUT`, `TLS_FAILURE`, `REGISTRY_TRANSIENT`, `RUNTIME_OOM`. Real-shaped excerpts from uvicorn, npm, pip, cargo, go, podman, openssl. Diagnose hit rate roughly doubled.
- **`REGISTRY_TRANSIENT` is the second auto-applicable kind** alongside `PORT_IN_USE` — npm/pip/cargo/go flakes auto-retry. Pattern ordering pinned by tests: RUNTIME_OOM before BUILD_OOM, TLS_FAILURE before NETWORK_FAILURE, REGISTRY_TRANSIENT before NETWORK_FAILURE.
- **SPA query-param token bootstrap** (`?wt_token=...`). The VS Code webview hands the SPA an auth token via the iframe URL; `web/src/main.tsx` bootstrap pops the param off, persists to localStorage, and `history.replaceState`s the URL clean so the token doesn't leak into history/referrer/screenshots. Same pattern Slack/GitHub use for magic-link bootstraps.

## What's New in 1.5.18

- **Backup export for `~/.watchtower/`** (closes gap #10 from the gap-analysis snapshot). One-click download from Settings → System produces a tar.gz with `secret.key` (Fernet master key) + `watchtower.db` (the SQLite database with all encrypted secrets). Loud `⚠ Contains credentials` warning panel before the button — the tarball IS the credential set, store it as securely as a password manager. Manual restore documented (`tar -xzf` over `~/.watchtower/`). Auth-gated to `can_manage_team=true`.

## What's New in 1.5.17

- **Auto-apply for port-in-use** — closes the **detect → diagnose → fix → verify** loop end-to-end for the most common deployment failure. When a deploy fails with `EADDRINUSE`, the user clicks Apply Fix and WatchTower picks a free port from the project range (excluding the failed one), persists it as `Project.recommended_port`, and queues a fresh deployment with the same branch/commit. The first **fully closed autonomous remediation loop** in the product. `deployment.auto_fix` audit-log records the failed/new ports for traceability.

## What's New in 1.5.16

- **Failure analyzer (diagnose half).** When a deployment fails, the user gets a Diagnose button on every failed row in the deployments tab. Backend pattern-matches the build log against 6 known failure modes — `PORT_IN_USE`, `MISSING_ENV_VAR`, `PACKAGE_NOT_FOUND`, `BUILD_OOM`, `PERMISSION_DENIED`, `DISK_FULL` — and returns structured cause + suggested fix. Pattern ordering pinned (disk-full beats permission-denied — root cause wins). LLM agent fallback queued for the next release.

## What's New in 1.5.15

- **Seamless startup.** Removed Electron's "JavaScript error in the main process" dialog (the `uncaughtException` handler now silently logs to `~/.watchtower/logs/desktop-electron.log` and the app keeps running). Splash now shows real backend-startup progress instead of fake animation; auto-fallback to ports 8001-8009 when 8000 is taken (Docker Desktop, jupyter, leftover WatchTower processes); "Cancel and quit" button on the splash after 30 seconds; user-facing `127.0.0.1` URLs replaced with friendly copy.

## What's New in 1.5.14

### Diagnostics surface that detects + fixes its own problems

- **Settings → System tab.** Probes Python, Podman/Docker, and the bundled Nixpacks binary at runtime; shows status badges (Found / Missing) and **per-platform copy-paste install commands** for anything missing — `brew install python@3.11`, `winget install RedHat.Podman`, `sudo apt install -y podman`, etc. **Recheck** restarts the app so PATH refreshes after a terminal install. The first step toward an autonomous-ops control plane: detect → diagnose → fix → verify, in one screen.
- **Send Error Report (mailto with diagnostics auto-attached).** One click in Settings → System or in the header opens the user's mail client pre-filled with platform, app version, dependency status, and the last 200 lines of the desktop-backend log — addressed to the maintainer. The user reviews the email body before clicking send; the app never sends anything itself.
- **Silent auto-update.** Removed the *"Update Available"* and *"Restart Now / Later"* dialogs from the packaged path. Updates download in the background and apply on next quit (`autoInstallOnAppQuit=true`); a single non-blocking OS notification fires when the download finishes. No more mid-task interruption.

### Distribution

- **VS Code Marketplace published as `sinhaankur.watchtower-podman`** ("WatchTower Ops"). Install with:
  ```bash
  code --install-extension sinhaankur.watchtower-podman
  ```
  Slug matches the PyPI package (`pip install watchtower-podman`) so users have one mnemonic across both channels.

## What's New in 1.5.13

- **macOS launch crash fixed.** `spawn /Applications/Xcode.app` errors caused by the `/usr/bin/python3` Command Line Tools stub triggering the Xcode CLT installer mid-launch. Detection now skips the stub and surfaces an actionable "install Python" dialog instead of crashing.
- **Splash logo restored.** Inlined `wt-logo.svg` directly into `splash.html` — the previous external `<img src="../assets/wt-logo.svg">` 404'd in packaged builds because `assets/` wasn't listed in `desktop/package.json`'s `files` array.
- **Top-level `uncaughtException` + `unhandledRejection` safety net** in the Electron main process. Spawn-side errors (missing PATH, permission denied, the macOS stub) no longer surface Electron's raw "A JavaScript error occurred" dialog — users see a friendly errorBox with a hint that exits cleanly.
- **Splash version label is now real.** Was hardcoded `v1.2.2` and stayed wrong through every release between 1.2.2 and 1.5.12; now injected from `app.getVersion()` via `webContents.executeJavaScript` on `dom-ready`.

## What's New in 1.5.12

The 1.5.x series — and especially the 1.5.10 → 1.5.12 cluster — moved WatchTower decisively in the *desktop-first, integrate-don't-rebuild* direction. Highlights:

### Setup that actually works

- **Auto-recommended ports.** Setup wizard picks a free port from 3000–3999 (race-free `bind`-and-release, skips ports already assigned to your other projects) and surfaces it as *"We'll deploy on port X"* with a single-click **Edit** override. No more silent fallback to a port that's already in use.
- **Native folder picker for local-source projects.** Click **Browse…** in the Setup Wizard's *Local folder* tab — get the OS file dialog instead of typing absolute paths. (Desktop only; browser mode falls back to a text input.)
- **GitHub avatars + names show up after sign-in.** Previously the sidebar identity badge fell back to the initial-letter placeholder forever; now the user's GitHub avatar persists across sessions and refreshes on every login.
- **Sign out is sticky.** A new `wt:explicitlySignedOut` sentinel prevents the dev / Electron auto-token path from silently re-authenticating you the moment you click Sign out. Sentinel clears on any deliberate sign-in (GitHub OAuth, guest, manual token, device flow).

### Build pipeline foundations

- **Nixpacks bundled into the desktop installer.** ~36 MB of platform-specific binaries (Linux x64/arm64, macOS x64/arm64) ship inside the Electron app via `electron-builder` `extraResources` so users can deploy without first installing Rust + Cargo + Nix. Resolution order is `WATCHTOWER_NIXPACKS_BIN` → bundled → system PATH. (The local-Podman runner that *consumes* this lands in 1.5.13.)
- **`GET /api/runtime/nixpacks-status`** exposes `{available, source, path, version, version_drift, platform_supported}` so the SPA can surface an actionable banner instead of silently failing a build.
- **Build queue stops dropping deploys at PENDING.** A long-standing bug where `enqueue_build` passed `str(deployment.id)` to a SQLAlchemy `Uuid` column (which calls `.hex` on the parameter) silently killed every queued build at the first DB query. Fixed at the top of `_run_build` with proper UUID coercion.

### UI that doesn't lie to the user

- **Projects no longer vanish from the dashboard.** Created projects were filed under the canonical user id (resolved via email) but read paths filtered by the token-synthetic UUID5, so projects disappeared the instant the token rotated. New `util.canonical_user_id()` resolver canonicalizes 20 read paths across `projects.py`, `deployments.py`, `builds.py`, `notifications.py`, `envvars.py`, `runtime.py`, and `agent.py`.
- **Real "Update Now" button.** Banners and the sidebar version line now actually trigger the Electron auto-updater (or the dev-clone `git pull` + rebuild + relaunch) instead of routing to a Settings page that only had a *Check* button.
- **−27% cold-start bundle.** 14 page components moved out of the main JS bundle behind `React.lazy + Suspense`. Cold-start went from 706 KB → 517 KB raw (204 KB → 164 KB gzipped); each route loads its own ~3–25 KB chunk on first navigation.

### Distribution

- **Per-arch macOS installers.** Switched from a single fat universal `.dmg` to separate **x64** and **arm64** installers — half the per-install download, no `@electron/universal` fragility around bundled per-arch tools.
- **VS Code extension installs on VS Code 1.80+.** Previously gated to 1.90+ (about a year of releases locked out). Bundled with esbuild so the `.vsix` is now **10 KB across 6 files** (was ~52 KB across 13 files); single-file load = faster activation.
- **Sidebar deduplicated, color tokens unified.** Removed the redundant icon-only second sidebar that rendered alongside the main one in Electron mode. 27 hand-rolled `hsl(214 …)` color literals across 11 files migrated to two design tokens (`--border-soft`, `--surface-soft`) so palette changes are now a single edit.

### Behind the scenes

- **Backend test count: 99 → 121** (test files: 8 → 14). New coverage for canonical-user-id resolution, builder UUID coercion, port recommendation, and Nixpacks resolution.
- **Branch protection on `main`.** Build (Linux/macOS/Windows matrix) + Trivy filesystem & container scans must pass before merge.
- **Stale `chore/release-*` branches and unused workflows pruned.** Repository is back to a single canonical branch (`main`) with a clean release pipeline.

> See `git log v1.5.10..v1.5.12 --oneline` for the full commit list, or browse [the Releases page](https://github.com/sinhaankur/WatchTower/releases) for installer downloads.

---

## 🚀 Ready for Beta Testing & Production

WatchTower is **fully functional** and suitable for:
- ✅ **Beta testing** — Deploy to preview environments, test with real infrastructure
- ✅ **Production use** — Multi-node HA setup, auto-restart watchdog, encrypted backups
- ✅ **Cost reduction** — Cut deployment costs by 60–80% compared to Vercel or similar PaaS

### Available for Download

**Current Version: 1.5.12**

| Channel | How to Get | Use Case |
|---------|-----------|----------|
| **Docker** | `docker pull ghcr.io/sinhaankur/watchtower:latest` | Production & staging |
| **Python** | `pipx install watchtower-podman` (Ubuntu 24+ / Debian 12+ / Fedora 38+) or `pip install watchtower-podman` in a venv on older distros | Development & automation |
| **Source** | [GitHub Releases](https://github.com/sinhaankur/WatchTower/releases) | Development, customization |
| **Git** | `git clone https://github.com/sinhaankur/WatchTower.git` | Contributor setup |

### Key Documentation

- **[SETUP_RELEASES.md](./SETUP_RELEASES.md)** ← **START HERE** — Release status, download options, branch protection setup
- **[docs/VERCEL_ALTERNATIVE.md](./docs/VERCEL_ALTERNATIVE.md)** — Why WatchTower replaces Vercel; feature parity comparison; migration guide; cost savings
- **[RELEASE.md](./RELEASE.md)** — How to create releases, manage versions, and download specific releases
- **[BRANCH_PROTECTION.md](./BRANCH_PROTECTION.md)** — How to protect the main branch and enforce code review standards

### Get Started Now

```bash
# Single node (30 seconds)
git clone https://github.com/sinhaankur/WatchTower.git && cd WatchTower && ./run.sh

# Docker (production-like)
docker compose -f docker-compose.app.yml up -d

# High Availability setup
docker compose -f deploy/docker-compose.ha.yml up -d
```

---

## Visual Blueprints

These diagrams are the fastest way to understand WatchTower before reading setup guides. Click any image to open the full interactive viewer.

### Modes Overview

> Two operating modes — keep existing containers current, or run a full app delivery pipeline.

```mermaid
flowchart LR
    subgraph M1["MODE 1 — Podman Auto-Update"]
        A[Podman Host] --> B[Poll + Restart] --> C([Healthy Container])
    end
    subgraph M2["MODE 2 — App Center"]
        D[App Registry] --> E[SSH Rollout] --> F([Live App])
    end
    CP{{WatchTower Control Plane}} --> M1 & M2
```

### Deployment Process

> The App Center release path: choose an app, build an artifact, sync to nodes, activate, confirm health.

```mermaid
flowchart LR
    A[Choose App] --> B[Build Package\ntar.gz / zip] --> C[SSH Transfer\nto Nodes] --> D[Activate\nContainer] --> E([Health Check\nPassed])
```

### Integration Stack

> Podman, Nginx, Tailscale, Cloudflare, Coolify, and WatchTower working as one autonomous system.

```mermaid
flowchart LR
    POD["📦 Podman<br/>Containers"]
    NGX["🔀 Nginx<br/>Proxy"]
    TS["🔐 Tailscale<br/>Mesh SSH"]
    CF["☁️ Cloudflare<br/>Public Edge"]
    CL["🚀 Coolify<br/>PaaS UI"]
    WD["👁️ WatchTower<br/>Watchdog"]
    
    POD -->|HTTP/HTTPS| NGX
    NGX -->|SSH tunnel| TS
    TS -->|expose| CF
    CF -->|manage apps| CL
    CL -.->|orchestrate| POD
    WD -.->|auto-restart on reboot| POD
    style WD fill:#e8f5e9,stroke:#4caf50,stroke-width:2px
    style POD fill:#e3f2fd,stroke:#2196f3,stroke-width:2px
```

### Mesh Topology

> Preview traffic, live traffic, and mesh routing decisions at a glance.

```mermaid
flowchart TD
    OP[Operator / CI] --> CP[WatchTower API\nControl Plane]
    CP --> PRV[Preview Slot\nNode]
    CP --> LIVE[Live Slot\nNode]
    EDGE[Caddy / CF\nTraffic Edge] -->|active slot| LIVE
    EDGE -.->|preview traffic| PRV
```

### Hybrid Stack

> Your control plane stays local; data and services live where you put them.

```mermaid
flowchart LR
    LOCAL[Local Workstation\nDashboard · CLI · Packager] --> API[WatchTower API]
    API --> SVC[Managed Services\nPostgres · Redis · S3]
    API --> NODES[App Nodes\nLinux Hosts]
    NODES --> DATA[Data Plane]
```

### Application & Web App Surface

> How a dashboard-registered app record becomes a URL your users can open.

```mermaid
flowchart LR
    R[Register\nDashboard Record] --> B[Build Artifact\nwatchtower-package] --> D[Deploy\nto Nodes] --> P[Promote\nto Live] --> U([Public URL])
```

### Secure Terminal Command Flow

> How guided host operations stay useful without exposing a raw shell.

```mermaid
flowchart LR
    OP[Operator\nPicks Command] --> PG{Policy Gate\nAllowlist Check}
    PG -->|allowed| EX[Execute\non Host]
    PG -->|blocked| BL([Rejected])
    EX --> AU[Encrypted Audit Log]
    AU --> RES([Result to Operator])
```

---

## Core Features

### Container Auto-Update Features

- Automatic container update monitoring (Podman-first)
- Smart scheduling (interval-based today, cron-style roadmap)
- Include/exclude filtering with wildcard patterns
- Configuration preservation across updates
- Post-update health verification
- Graceful stop/start update process
- Optional old image cleanup after success
- Dry-run / monitor-only mode
- Rotating logs with configurable verbosity
- CLI for manual operations and status checks
- Systemd integration for service management

### App Center Features

- App registration through `apps.json`
- Multi-node SSH deployment workflows
- Dashboard-oriented UI for projects and deploy activity
- API-based deployment triggers per app
- Portable package builder (`tar.gz` / `zip`) for Linux, Windows, macOS, and generic targets

### Platform and Distribution Features

- **Desktop app**: Electron build with native system tray, **OS-level notifications** (deploy completion / build failure), **native folder picker** for local-source projects, sticky sign-out, and in-app **Update Now** wired to `electron-updater`. Per-arch installers for Linux (x86_64, arm64, armv7l), macOS (x64, arm64), and Windows (x64, arm64).
- **VS Code extension** (`sinhaankur.watchtower-podman`, "WatchTower Ops" on the marketplace): WatchTower sidebar inside the editor — projects, deploy actions, deployment logs, and a status bar item. Install: `code --install-extension sinhaankur.watchtower-podman`. Runs on VS Code **1.80+**, ~10 KB `.vsix`, esbuild-bundled.
- **Bundled build tooling**: Nixpacks v1.41.0 binaries (Linux x64/arm64, macOS x64/arm64) shipped inside the desktop installer via `extraResources` so users don't need Rust + Cargo + Nix to deploy.
- Linux App Center installer (`install_app_center.sh`)
- Windows App Center installer and runner scripts
- macOS App Center installer and runner scripts
- GHCR image publishing, PyPI publishing, and release automation
- GitHub Pages docs deployment

---

## Requirements

- **Operating System:** Ubuntu/Linux (primary); Windows/macOS supported for App Center workflows
- **Python:** 3.8+
- **Podman:** 3.0+
- **Permissions:** root or Podman socket access for container service mode

---

## Installation

### Publish Option 3 (Containers + PyPI)

If you selected both distribution channels, this repository now supports:

1. **GitHub Container Registry (GHCR)**
  - Workflow: `.github/workflows/publish-container.yml`
  - Publishes image: `ghcr.io/<owner>/watchtower`
  - Trigger: push to `main`, version tags (`v*`), or manual dispatch

2. **PyPI package publishing**
  - Workflow: `.github/workflows/publish-pypi.yml`
  - Publishes project: `watchtower-podman`
  - Trigger: version tags (`v*`) or manual dispatch

3. **GitHub Release creation**
  - Workflow: `.github/workflows/release.yml`
  - Trigger: version tags (`v*`)
  - Validates that tag version matches `watchtower.__version__`

One-time setup needed:

- In GitHub repo settings, allow workflow permissions to write packages.
- In PyPI, configure Trusted Publishing for this repository.
- Use release tags (for example `v1.1.1`) to produce versioned artifacts.

Version-controlled release process:

1. Bump `watchtower/__init__.py` version (single source of truth).
2. Commit and merge to `main`.
3. Create and push a semantic tag like `v1.1.1`.
4. GitHub Actions will automatically:
  - Create GitHub Release notes
  - Publish container image to GHCR
  - Publish package to PyPI

Optional helper command:

```bash
./scripts/release.sh 1.2.2
```

### GitHub Pages Documentation Site

- Source files are in `docs/`
- Deployment workflow: `.github/workflows/deploy-pages.yml`
- URL: `https://sinhaankur.github.io/WatchTower/`

If Pages has never been enabled on this repository:

1. Open repository settings -> Pages
2. Under Build and deployment, select Source: `GitHub Actions`
3. Run the `Deploy Docs Site` workflow once (or push docs changes)

### One-Command App Center Install (Linux)

```bash
sudo ./install/install_app_center.sh
```

This installer:

- Installs runtime dependencies (`python3`, `venv`, `git`, `rsync`, SSH client)
- Installs WatchTower into `/opt/watchtower/.venv`
- Sets up `/etc/watchtower/nodes.json` and `/etc/watchtower/apps.json`
- Creates and starts `watchtower-appcenter` systemd service

Post-install checks:

```bash
sudo systemctl status watchtower-appcenter
curl http://<server-ip>:8000/health
```

### Windows Installation (App Center)

```powershell
powershell -ExecutionPolicy Bypass -File .\install\install_windows.ps1
powershell -ExecutionPolicy Bypass -File .\install\run_app_center_windows.ps1
```

Default paths:

- Install dir: `%USERPROFILE%\\WatchTowerAppCenter`
- Config dir: `%USERPROFILE%\\WatchTowerConfig`

Health check:

```bash
curl http://127.0.0.1:8000/health
```

### macOS Installation (App Center)

```bash
./install/install_macos.sh
./install/run_app_center_macos.sh
```

Default paths:

- Install dir: `~/watchtower-appcenter`
- Config dir: `~/.watchtower`

Health check:

```bash
curl http://127.0.0.1:8000/health
```

### Ubuntu/Linux Installation (Container Auto-Update Service)

1. Install Podman:

```bash
sudo apt update
sudo apt install podman
```

2. Clone repository:

```bash
git clone https://github.com/sinhaankur/WatchTower.git
cd WatchTower
```

3. Install dependencies and package:

```bash
pip3 install -r requirements.txt
sudo python3 setup.py install
```

4. Create directories:

```bash
sudo mkdir -p /etc/watchtower
sudo mkdir -p /var/log/watchtower
```

5. Copy and edit config:

```bash
sudo cp config/watchtower.yml /etc/watchtower/
sudo nano /etc/watchtower/watchtower.yml
```

6. Enable service:

```bash
sudo cp systemd/watchtower.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable watchtower
sudo systemctl start watchtower
```

### Manual Installation (Development)

```bash
pip3 install -r requirements.txt
python3 -m watchtower --help
```

---

## Configuration

WatchTower searches for `watchtower.yml` in:

- `/etc/watchtower/watchtower.yml`
- `/opt/watchtower/config/watchtower.yml`
- `./config/watchtower.yml`
- `./watchtower.yml`

Example:

```yaml
watchtower:
  interval: 300
  cleanup: true
  monitor_only: false

containers:
  include: []
  exclude:
    - "database-*"
    - "postgres"

notifications:
  enabled: true
  type: "log"

logging:
  level: "INFO"
  file: "/var/log/watchtower/watchtower.log"
  max_size: "10MB"
  backup_count: 5
```

### Configuration Options

- `watchtower.interval`: update check interval (seconds)
- `watchtower.cleanup`: remove old images after update
- `watchtower.monitor_only`: check only, no apply
- `containers.include` / `containers.exclude`: wildcard filtering
- `notifications.enabled` / `notifications.type`: `log`, `email`, `webhook`
- `logging.level`, `logging.file`, `logging.max_size`, `logging.backup_count`

---

## Usage

### Container Service CLI

```bash
watchtower start
watchtower -c /path/to/config.yml start
watchtower status
watchtower update-now
watchtower list-containers
watchtower validate-config
```

### Deployment Orchestrator / App Center Mode

Start API server:

```bash
watchtower-deploy serve --host 0.0.0.0 --port 8000
```

Dashboard UI:

```text
http://<server-ip>:8000/dashboard
```

Primary API endpoints:

- `GET /ui/data`
- `GET /apps`
- `POST /apps/{app_name}/deploy`

Required environment variables:

```bash
export WATCHTOWER_REPO_DIR=/opt/website
export WATCHTOWER_NODES_FILE=/opt/watchtower/nodes.json
export WATCHTOWER_APPS_FILE=/opt/watchtower/apps.json
export WATCHTOWER_TRIGGER_TOKEN=change-me
```

On Windows and macOS, platform installer/run scripts write and load these automatically from `appcenter.env`.

Deploy by app name:

```bash
WATCHTOWER_BASE_URL=http://server:8000 WATCHTOWER_TOKEN=change-me ./scripts/deploy.sh --app website-main main
```

List registered apps:

```bash
curl -H "X-Watchtower-Token: change-me" http://server:8000/apps
```

Trigger deployment from dev machine:

```bash
WATCHTOWER_URL=http://server:8000/deploy WATCHTOWER_TOKEN=change-me ./scripts/deploy.sh main
```

One-off server deploy commands:

```bash
watchtower-deploy deploy-now --branch main
watchtower-deploy deploy-app --app website-main --branch main
```

Package builder examples:

```bash
watchtower-package --name website-main --source ./dist --target linux --format tar.gz
watchtower-package --name desktop-client --source ./build --target windows --format zip
```

Generated output includes:

- archive bundle (`.tar.gz` / `.zip`)
- manifest JSON with target metadata

---

## Running as a Service

```bash
sudo systemctl start watchtower
sudo systemctl stop watchtower
sudo systemctl restart watchtower
sudo systemctl status watchtower
sudo journalctl -u watchtower -f
sudo tail -f /var/log/watchtower/watchtower.log
sudo systemctl enable watchtower
```

---

## How Container Update Flow Works

1. Discover running Podman containers
2. Apply include/exclude filters
3. Check for newer images
4. Pull updated image
5. Gracefully stop old container
6. Recreate with preserved config (env, ports, volumes, restart policy, labels, args)
7. Verify container health
8. Optionally clean old images
9. Emit logs/notifications

---

## Practical Configuration Examples

### Monitor all containers

```yaml
containers:
  include: []
  exclude: []
```

### Monitor specific containers

```yaml
containers:
  include:
    - "nginx"
    - "redis"
    - "app-*"
  exclude: []
```

### Exclude databases

```yaml
containers:
  include: []
  exclude:
    - "postgres"
    - "mysql"
    - "mongodb"
    - "database-*"
```

### Dry-run mode

```yaml
watchtower:
  monitor_only: true
```

### Frequent checks

```yaml
watchtower:
  interval: 60
```

---

## Troubleshooting

### WatchTower won’t start

```bash
podman --version
watchtower validate-config
ls -la /run/podman/podman.sock
```

### Containers not updating

```bash
watchtower list-containers
sudo tail -f /var/log/watchtower/watchtower.log
```

Also verify include/exclude rules and image/tag behavior.

### Permission denied

Run as root or configure appropriate Podman socket permissions.

### No updates detected

```bash
podman pull <image-name>
```

Confirm registry accessibility and image tag semantics.

---

## Security

### Security Hardening

Recommended production setup:

```bash
export WATCHTOWER_API_TOKEN="change-this-to-a-long-random-token"
export WATCHTOWER_SECRET_KEY="$(python3 - <<'PY'
from cryptography.fernet import Fernet
print(Fernet.generate_key().decode())
PY
)"
```

Then run your service/deployment stack.

Notes:

- API auth uses timing-safe token comparison.
- Enterprise GitHub tokens are encrypted at rest with `WATCHTOWER_SECRET_KEY`.
- Insecure dev auth is disabled by default.

Dev-only bypass (never in production):

```bash
export WATCHTOWER_ALLOW_INSECURE_DEV_AUTH=true
```

### Secure Terminal Command Runner (Host Connect)

Host Connect includes a secure command runner for operational commands.

- Strict allowlist only (no arbitrary shell)
- Command-level sudo controls
- Encrypted execution audit log

Enable it by setting:

```bash
export WATCHTOWER_TERMINAL_AUDIT_KEY="$(python3 - <<'PY'
from cryptography.fernet import Fernet
print(Fernet.generate_key().decode())
PY
)"
```

If missing, terminal execution is disabled by design.

### Website Security Baseline (Recommended)

- Protect deploy API with strong `WATCHTOWER_TRIGGER_TOKEN`
- Keep API private to LAN/VPN where possible
- Apply firewall allowlists for admin/dev IPs
- Use dedicated non-root deploy user on nodes
- Keep `sudoers` narrow (avoid broad `NOPASSWD:ALL`)
- Enforce SSH key-based auth; disable password auth
- Enforce HTTPS/TLS and modern security headers
- Centralize logs, rotate logs, keep backups, and test rollback plans

Minimal safe deployment checks:

```bash
sudo systemctl status watchtower-appcenter
curl http://<server-ip>:8000/health
```

For internet-facing deployments, place App Center behind VPN/auth gateway.

### Security CI (Automated)

- Workflow: `.github/workflows/security-scan.yml`
- Triggered on PRs and pushes to `main`
- Scans filesystem and built container image
- Fails on HIGH/CRITICAL vulnerabilities (except unfixed CVEs)

---

## Release and Publishing

### Publish Option 3 (Containers + PyPI)

This repository supports:

- **GHCR publishing**
  - Workflow: `.github/workflows/publish-container.yml`
  - Image: `ghcr.io/<owner>/watchtower`
  - Trigger: `main`, tags `v*`, or manual dispatch

- **PyPI publishing**
  - Workflow: `.github/workflows/publish-pypi.yml`
  - Package: `watchtower-podman`
  - Trigger: tags `v*` or manual dispatch

- **GitHub Release creation**
  - Workflow: `.github/workflows/release.yml`
  - Trigger: tags `v*`
  - Validates tag matches `watchtower.__version__`

One-time setup:

- Enable workflow package write permissions in repository settings
- Configure PyPI Trusted Publishing for this repository
- Use semantic release tags (for example `v1.1.1`)

Version-controlled release process:

1. Bump `watchtower/__init__.py` version.
2. Commit and merge to `main`.
3. Create and push a semantic tag, for example `v1.1.1`.
4. Actions automatically:
   - create release notes
   - publish GHCR image
   - publish PyPI package

Optional helper:

```bash
./scripts/release.sh 1.1.1
```

---

## GitHub Pages Documentation Site

- Source: `docs/`
- Workflow: `.github/workflows/deploy-pages.yml`
- URL: <https://sinhaankur.github.io/WatchTower/>

If Pages has never been enabled:

1. Open repository settings -> Pages
2. Set Build and deployment source to **GitHub Actions**
3. Run **Deploy Docs Site** once (or push docs changes)

---

## Development

### Project Structure

```text
watchtower/
├── watchtower/
│   ├── __init__.py
│   ├── __main__.py
│   ├── main.py
│   ├── cli.py
│   ├── config.py
│   ├── logger.py
│   ├── podman_manager.py
│   ├── updater.py
│   └── scheduler.py
├── config/
├── systemd/
├── tests/
├── docs/
├── scripts/
├── README.md
└── setup.py
```

### Running Tests

```bash
pip3 install pytest pytest-cov
pytest tests/
pytest --cov=watchtower tests/
```

### Contributing

1. Fork repository
2. Create feature branch
3. Make changes
4. Add tests
5. Ensure tests pass
6. Submit pull request

For full contributor guidance, see `CONTRIBUTING.md`.

---

## Extending WatchTower (Contributors)

Common extension areas:

- New deployment integrations and rollout strategies
- Notification/observability (email, webhooks, metrics)
- Pre-deploy safety checks and automated rollback
- Packaging target expansion and artifact signing

When adding features, include:

- success/failure tests
- README/config updates
- security impact and safe defaults

---

## Roadmap

- broader Docker parity and runtime features
- Windows and macOS container-service depth
- richer notification integrations
- enhanced monitoring/metrics integrations
- stronger rollback and scheduling controls

---

## License

WatchTower is **dual-licensed** — pick the option that matches how you'll use it:

- **Free** (default): Apache 2.0 outside `pro/` + Elastic License 2.0 inside `pro/`. Use it for self-hosting, internal commercial use, forks, audits, and contributions. Free forever.
- **Commercial License** ([template](LICENSE-COMMERCIAL.md)): paid option for resellers / SaaS hosts / OEM embedders / regulated environments that need a written agreement, defined SLA, or removable attribution. Email **opensource@sinhaankur.dev** with subject "Commercial License Inquiry" to start. Pricing tiers at <https://sinhaankur.github.io/WatchTower/pricing/>.

See [LICENSING.md](LICENSING.md) for the full breakdown of who needs which license, what each grants, and trademark notes.

## Terms, Privacy & Acceptable Use

Using a running WatchTower installation is governed by the
[Terms of Use](legal/TERMS_OF_USE.md), [Acceptable Use Policy](legal/ACCEPTABLE_USE.md),
and [Privacy Policy](legal/PRIVACY.md). Every user accepts them in-app at first
login (recorded with version + timestamp), and re-accepts when they materially
change. WatchTower is self-hosted: your data stays on your machine, there is no
vendor telemetry, and you remain responsible for what you deploy and for any
automated/AI features you enable. See [legal/README.md](legal/README.md) for how
the acceptance flow works.

## Support

- Issues: <https://github.com/sinhaankur/WatchTower/issues>
- Docs: <https://github.com/sinhaankur/WatchTower>

## Acknowledgments

- Inspired by Docker Watchtower patterns
- Built for Podman-first workflows
- Thanks to all contributors

---

> Note: WatchTower performs automated update/deployment operations. Always validate in non-production environments first and keep reliable backups before production rollouts.
