# WatchTower

<p align="center">
  <a href="https://github.com/sinhaankur/WatchTower/blob/main/LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="MIT License" /></a>
  <img src="https://img.shields.io/badge/python-3.8%2B-blue.svg" alt="Python 3.8+" />
  <img src="https://img.shields.io/badge/node-18%2B-brightgreen.svg" alt="Node 18+" />
  <a href="https://github.com/sinhaankur/WatchTower/pkgs/container/watchtower"><img src="https://img.shields.io/badge/container-GHCR-blueviolet.svg" alt="GHCR" /></a>
  <a href="https://sinhaankur.github.io/WatchTower/"><img src="https://img.shields.io/badge/docs-GitHub%20Pages-orange.svg" alt="Docs" /></a>
  <a href="https://github.com/sinhaankur/WatchTower/issues"><img src="https://img.shields.io/github/issues/sinhaankur/WatchTower.svg" alt="Issues" /></a>
</p>

<p align="center">
  <strong>Keep Podman containers current. Ship apps across your own nodes.</strong><br/>
  Operator-facing tooling for container auto-updates, multi-node deployments, and guided host operations — without handing control to a hosted platform.
</p>

## How They Work Together

**The complete integration stack:**

```
Podman runs containers → Nginx proxies traffic → Tailscale secures node SSH
  ↓
Cloudflare exposes to internet → Coolify provides PaaS UI → WatchTower watchdog
  ↓
Keeps it all alive after reboots
```

- **Podman** runs your containerized workloads
- **Nginx** routes HTTP/HTTPS traffic efficiently
- **Tailscale** creates a secure, encrypted mesh network for node SSH access
- **Cloudflare** exposes your applications to the internet with DDoS protection
- **Coolify** provides a clean PaaS interface for app deployment and management
- **WatchTower Watchdog** automatically restarts containers after any reboot or crash — **no manual intervention needed**

Manage everything from the **Integrations** page: see live connection status for all 6 tools, toggle the watchdog, and view install commands.

---

## Get Running in 30 Seconds

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
- Launch the **Electron desktop app** if a display is available, otherwise open the browser at `http://127.0.0.1:5222`

**Other commands:**

| Command | What it does |
|---|---|
| `./run.sh desktop` | Force Electron desktop app |
| `./run.sh browser` | Force browser mode |
| `./run.sh stop` | Kill all WatchTower processes |
| `./run.sh logs` | Tail backend + frontend logs |

> **Requirements:** Python 3.8+, Node.js 18+, npm. Podman optional (only needed for container auto-update mode).

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

## What It Does

- **Container auto-update mode:** poll running containers, pull newer images, restart safely, and verify health.
- **App Center mode:** register workloads in `config/apps.json`, package from a dev machine, sync to nodes, activate remotely, and confirm rollout state.
- **Operator tooling:** expose guided actions, runtime inspection, and secure host operations from one control surface.

## Choose Your Path

- **Use Podman Auto-Update Service** if you already have a release process and only need safe host maintenance for containers.
- **Use App Center** if you want WatchTower to behave like a compact deployment control plane for websites, APIs, previews, and multi-node rollouts.
- **Use Host Connect / secure terminal flows** if the team needs guided host actions without opening an unrestricted shell path.

## Why It Is Different

- **Explicit deploy flow:** operators can see app selection, artifact creation, sync, activation, and health verification as separate steps.
- **Own-your-infrastructure model:** deploy to your own Linux nodes over SSH instead of handing control to a hosted platform.
- **Consistent UX:** the desktop app, web UI, GitHub Pages docs, and architecture diagrams all explain the same product model.

---

## 🚀 Ready for Beta Testing & Production

WatchTower is **fully functional** and suitable for:
- ✅ **Beta testing** — Deploy to preview environments, test with real infrastructure
- ✅ **Production use** — Multi-node HA setup, auto-restart watchdog, encrypted backups
- ✅ **Cost reduction** — Cut deployment costs by 60–80% compared to Vercel or similar PaaS

### Available for Download

**Current Version: 1.2.2**

| Channel | How to Get | Use Case |
|---------|-----------|----------|
| **Docker** | `docker pull ghcr.io/sinhaankur/watchtower:latest` | Production & staging |
| **Python** | `pip install watchtower-podman` | Development & automation |
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

MIT License. See `LICENSE`.

## Support

- Issues: <https://github.com/sinhaankur/WatchTower/issues>
- Docs: <https://github.com/sinhaankur/WatchTower>

## Acknowledgments

- Inspired by Docker Watchtower patterns
- Built for Podman-first workflows
- Thanks to all contributors

---

> Note: WatchTower performs automated update/deployment operations. Always validate in non-production environments first and keep reliable backups before production rollouts.
