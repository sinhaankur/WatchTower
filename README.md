# WatchTower

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

## Visual Blueprints

These diagrams are the fastest way to understand the product before reading setup guides.

### Modes Overview

Start here if you need the shortest explanation of the two operating modes.

<a href="https://sinhaankur.github.io/WatchTower/" target="_blank" rel="noreferrer">
  <img src="https://sinhaankur.github.io/WatchTower/assets/modes-overview.svg" alt="WatchTower modes overview showing Podman auto-update service and App Center control plane mode" />
</a>

### Deployment Process

Use this to understand the App Center release path from app choice to healthy service.

<a href="https://sinhaankur.github.io/WatchTower/viewer.html?doc=readme" target="_blank" rel="noreferrer">
  <img src="https://sinhaankur.github.io/WatchTower/assets/deploy-process.svg" alt="WatchTower deployment process showing app selection, packaging, SSH transfer, remote activation, and health verification" />
</a>

### Mesh Topology

Use this when you need to understand preview traffic, live traffic, and mesh routing decisions.

<a href="https://sinhaankur.github.io/WatchTower/viewer.html?doc=mesh" target="_blank" rel="noreferrer">
  <img src="https://sinhaankur.github.io/WatchTower/assets/mesh-topology.svg" alt="WatchTower mesh topology showing control plane, preview nodes, live nodes, and traffic layer" />
</a>

### Hybrid Stack

Use this when your control plane stays local but data or services live remotely.

<a href="https://sinhaankur.github.io/WatchTower/viewer.html?doc=hybrid" target="_blank" rel="noreferrer">
  <img src="https://sinhaankur.github.io/WatchTower/assets/hybrid-stack.svg" alt="WatchTower hybrid stack overview showing local operator workspace, WatchTower API, managed services, app nodes, and data plane" />
</a>

### Application And Web App Surface

Use this to see how dashboard-managed app records turn into a public URL that end users actually open.

<a href="https://sinhaankur.github.io/WatchTower/" target="_blank" rel="noreferrer">
  <img src="https://sinhaankur.github.io/WatchTower/assets/application-surface.svg" alt="WatchTower application and web app surface showing dashboard, artifact build, and public web app delivery" />
</a>

### Secure Terminal Command Flow

Use this to understand how guided host operations stay useful without exposing a raw shell.

<a href="https://sinhaankur.github.io/WatchTower/viewer.html?doc=readme" target="_blank" rel="noreferrer">
  <img src="https://sinhaankur.github.io/WatchTower/assets/secure-terminal-flow.svg" alt="WatchTower secure terminal command flow showing Host Connect request, policy gate, execution path, encrypted audit, and operator result" />
</a>

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
