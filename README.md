# WatchTower - App Center and Podman Management

![Wt Logo](assets/wt-logo.svg)

Branding note:
- The application mark is `Wt` (retro-style yellow tile with dark border) and should be reused across UI, docs, and container artifacts.

Project site (GitHub Pages):
- https://sinhaankur.github.io/WatchTower/
- Docs hub includes feature provenance and references to upstream projects used by this repo (for example tailscale/tailscale and containrrr/watchtower).

WatchTower can run as:
- A Podman auto-update service for containers
- A lightweight App Center for Linux servers that deploys websites/APIs to multiple nodes over SSH

The App Center mode is designed to feel simple like hosted deployment platforms:
- Register apps in a single apps.json file
- Deploy by app name from your dev machine
- Push code, run optional build, sync artifacts to nodes, and reload services

## Features

- **Automatic Container Updates**: Monitors running Podman containers and automatically updates them when new images are available
- **Smart Scheduling**: Configurable update intervals with cron-like scheduling
- **Container Filtering**: Include or exclude specific containers from monitoring using wildcard patterns
- **Configuration Preservation**: Maintains container configurations, volumes, and environment variables during updates
- **Health Monitoring**: Verifies container health after updates
- **Graceful Updates**: Stops old containers gracefully before starting new ones
- **Image Cleanup**: Optional automatic cleanup of old images after successful updates
- **Dry-Run Mode**: Monitor-only mode to check for updates without applying them
- **Comprehensive Logging**: Detailed logging with rotation support
- **CLI Interface**: Command-line tools for manual operations and status checks
- **Systemd Integration**: Run as a system service with automatic startup
- **App Center API**: Trigger deploys through app-specific endpoints
- **Portable Packaging**: Build tar.gz/zip bundles for Linux, Windows, macOS, or any target

## Requirements

- **Operating System**: Ubuntu/Linux (primary), designed for future Windows/macOS support
- **Python**: 3.8 or higher
- **Podman**: 3.0 or higher
- **Permissions**: Root or appropriate Podman socket access

## Installation

### Cross-Platform Install Files (Linux, macOS, Windows)

Use the following files to install and run WatchTower by OS:

1. Linux service mode:
  - Install file: `install.sh`
  - Run as service: `sudo systemctl start watchtower`

2. macOS App Center mode:
  - Install file: `install_macos.sh`
  - Run file: `run_app_center_macos.sh`

3. Windows App Center mode:
  - Install file: `install_windows.ps1`
  - Run file: `run_app_center_windows.ps1`

4. Cross-platform desktop window mode (Linux/macOS/Windows):
  - Launcher files: `desktop/package.json`, `desktop/main.js`
  - Install: `npm run install:desktop`
  - Run: `npm run desktop`
  - Build installable app packages (for app menu + dock/taskbar pinning): `npm run desktop:dist`

5. Linux launcher shortcut (local/dev install):
  - Script: `scripts/install-desktop-shortcut-linux.sh`
  - Run: `./scripts/install-desktop-shortcut-linux.sh`
  - Result: WatchTower appears in application launchers and can be pinned.

5. PowerShell installers (Linux/macOS/Windows):
  - Linux file: `scripts/install-powershell-linux.sh`
  - macOS file: `scripts/install-powershell-macos.sh`
  - Windows file: `scripts/install-powershell-windows.ps1`

Run commands:

```bash
# Linux
sudo ./scripts/install-powershell-linux.sh
pwsh --version

# macOS
./scripts/install-powershell-macos.sh
pwsh --version
```

```powershell
# Windows (PowerShell)
powershell -ExecutionPolicy Bypass -File .\scripts\install-powershell-windows.ps1
pwsh --version
```

Security defaults:
- macOS/Windows installers now generate a random `WATCHTOWER_TRIGGER_TOKEN` automatically.
- Runtime bind host defaults to `127.0.0.1` for local-only access.
- Desktop launcher uses token-based API auth by default (no insecure bypass required).
- If you need remote access, explicitly set `WATCHTOWER_BIND_HOST=0.0.0.0` and secure firewall rules.

### Quick Start (Platform UI + API, Local Development)

Run the full WatchTower platform locally with one command:

```bash
./scripts/dev-up.sh
```

This starts:
- UI at `http://127.0.0.1:5173`
- API at `http://127.0.0.1:8000`

Stop everything:

```bash
./scripts/dev-down.sh
```

### One-Command Integration Bootstrap

Run a single script to:
- validate GitHub OAuth env vars,
- install or verify Podman, Docker, and Tailscale,
- start WatchTower background updater,
- run final health checks with pass/fail summary.

```bash
./scripts/bootstrap-watchtower-integrations.sh
```

Safe verification mode (no installs, no background start):

```bash
./scripts/bootstrap-watchtower-integrations.sh --no-install --skip-background
```

### Runtime Operations (Podman + WatchTower)

The Dashboard now includes a **Runtime Operations** card that shows:
- Podman availability and running container count
- WatchTower service state
- WatchTower background updater state + recent logs

From the UI, you can run:
- **Refresh Runtime**
- **Start Background WatchTower**
- **Stop Background WatchTower**
- **Run Update Check Now**

These actions are backed by API endpoints under `/api/runtime/*`.

### Run WatchTower In Background (CLI)

If you want the updater loop to continue without keeping the UI open:

```bash
python -m watchtower start
```

For one manual update pass:

```bash
python -m watchtower update-now
```

For status:

```bash
python -m watchtower status
```

Notes:
- The script auto-creates `.venv` and installs backend dependencies from `requirements-new.txt`.
- It auto-installs frontend dependencies in `web/` if `node_modules` is missing.
- If Docker Compose starts successfully, it uses PostgreSQL and Redis.
- If Docker Compose is unavailable or fails, it automatically falls back to local SQLite mode.

### Quick Start (Full Docker Application)

Run WatchTower as a single Dockerized application stack (UI + API + PostgreSQL + Redis):

```bash
./scripts/app-up.sh
```

What this script now does before launching:
- Detects whether Docker/Podman runtime is available.
- If missing on Ubuntu/Debian, it can auto-install Podman.
- If installed but not running, it attempts to start container services.
- If it still cannot connect, it prints exact commands to run.

Then open:
- UI: `http://127.0.0.1:5173`
- API: `http://127.0.0.1:8000`

Stop the application stack:

```bash
./scripts/app-down.sh
```

If you prefer direct compose commands:

```bash
docker compose up --build -d
docker compose down
```

You can also run the runtime check directly:

```bash
./scripts/ensure-container-runtime.sh --auto-install --auto-start
```

### Security Hardening

WatchTower now supports explicit API token authentication for backend routes.

Recommended production setup:

```bash
export WATCHTOWER_API_TOKEN="change-this-to-a-long-random-token"
export WATCHTOWER_SECRET_KEY="$(python3 - <<'PY'
from cryptography.fernet import Fernet
print(Fernet.generate_key().decode())
PY
)"
docker compose up --build -d
```

Notes:
- The backend validates `Authorization: Bearer <token>` using timing-safe comparison.
- Enterprise GitHub access tokens are encrypted at rest using `WATCHTOWER_SECRET_KEY`.
- The frontend can forward the same token using `VITE_API_TOKEN` in compose.
- Insecure development bypass is disabled by default.
- To allow local insecure mode intentionally (development only), set:

```bash
export WATCHTOWER_ALLOW_INSECURE_DEV_AUTH=true
```

This should never be enabled in production.

### Secure Terminal Command Runner (Host Connect)

WatchTower includes a **Secure Terminal Command Runner** in Host Connect for
operations commands. It is intentionally locked down:

- Only allow-listed commands are executable (no arbitrary shell).
- `sudo` is controlled per-command (optional/required/forbidden).
- Every execution is encrypted in an audit log.

To enable command execution, set an audit encryption key:

```bash
export WATCHTOWER_TERMINAL_AUDIT_KEY="$(python3 - <<'PY'
from cryptography.fernet import Fernet
print(Fernet.generate_key().decode())
PY
)"
```

Then restart the API service. If this key is missing, terminal execution is
disabled by design.

### Desktop Pinning and Application Listing

To make WatchTower appear as a normal desktop app (dock/taskbar/start-menu/applications):

1. Install desktop dependencies:

```bash
npm run install:desktop
```

2. Build platform installers/artifacts:

```bash
npm run desktop:dist
```

Generated artifacts are in `desktop/dist/`:
- Linux: AppImage, deb
- macOS: dmg, zip
- Windows: nsis installer, zip

Install the artifact for your OS, then pin WatchTower from the system app launcher/taskbar.

For Linux local development without packaging:

```bash
./scripts/install-desktop-shortcut-linux.sh
```

### Global Versioning for Updates

WatchTower now keeps desktop/runtime package versions aligned with the Python package version (`watchtower/__init__.py`).

Run version sync before releases:

```bash
npm run sync:versions
```

This updates:
- `package.json`
- `desktop/package.json`

This ensures globally published update artifacts and release metadata stay on the same version.

### GitHub Login (Recommended Web UX)

To make the web app seamless, users can sign in with GitHub and receive a WatchTower session token automatically.

Set these variables on the API server:

```bash
export GITHUB_OAUTH_CLIENT_ID="your-github-oauth-app-client-id"
export GITHUB_OAUTH_CLIENT_SECRET="your-github-oauth-app-client-secret"
```

Compatibility aliases are also supported:

```bash
export GITHUB_CLIENT_ID="your-github-oauth-app-client-id"
export GITHUB_CLIENT_SECRET="your-github-oauth-app-client-secret"
```

Configure your GitHub OAuth app callback URL to:

```text
http://localhost:5173/oauth/github/login/callback
```

Notes:
- With GitHub login enabled, users do not need to manually set `VITE_API_TOKEN` in the browser.
- Existing API token mode (`WATCHTOWER_API_TOKEN` + `VITE_API_TOKEN`) still works for non-interactive or local admin flows.
- Login now supports direct browser redirect via `/api/auth/github/login` (used by the login button) for immediate OAuth validation.

### DIY "Vercel-like" Deployment (Podman + Watchtower)

This repository now includes a push-to-deploy style setup:

1. CI pipeline to publish image to GHCR on `main`:
  - Workflow: `.github/workflows/deploy.yml`
2. Podman-compatible runtime stack:
  - Compose file: `docker-compose.vercel-like.yml`
3. Bootstrap script for Podman socket + GHCR login + startup:
  - Script: `scripts/init-podman-watchtower.sh`

Quick start:

```bash
cp .env.watchtower.example .env.watchtower
# edit .env.watchtower with GH username/token and app image
./scripts/init-podman-watchtower.sh
```

This starts:
- `my-app` from `APP_IMAGE`
- `watchtower` polling every `30s` by default

Notes:
- Podman socket required for Watchtower: `systemctl --user enable --now podman.socket`
- Use GHCR token with `read:packages` for private images.
- Discord/Slack notifications can be configured via `WATCHTOWER_NOTIFICATION_URL`.

### High Availability (Primary-Standby Across Sites)

For a two-node HA edge cluster (home + office, or multi-site):

- Compose stack: `docker-compose.ha.yml`
- Node env templates: `.env.ha.primary.example`, `.env.ha.standby.example`
- Bootstrap script: `scripts/ha-node-up.sh`
- DB backup script: `scripts/ha-db-backup.sh`
- Full runbook: `docs/HA_PODMAN_WATCHTOWER.md`

Quick start:

```bash
cp .env.ha.primary.example .env.ha   # on primary
# or cp .env.ha.standby.example .env.ha on standby
./scripts/ha-node-up.sh .env.ha
```

### Hybrid Cloud Database Mode (Atlas Or Managed DB)

If you want Podman nodes on your own hardware but a managed shared database in the cloud:

- Compose stack: `docker-compose.hybrid.yml`
- Node env templates: `.env.hybrid.primary.example`, `.env.hybrid.standby.example`
- Bootstrap script: `scripts/hybrid-node-up.sh`
- Runbook: `docs/HYBRID_CLOUD_DATABASES.md`

Quick start:

```bash
cp .env.hybrid.primary.example .env.hybrid   # on node A
# or cp .env.hybrid.standby.example .env.hybrid on node B
echo 'mongodb+srv://user:pass@cluster.mongodb.net/app?retryWrites=true&w=majority' | podman secret create mongo_uri -
./scripts/hybrid-node-up.sh .env.hybrid
```

Notes:

- This hybrid mode is for workload containers that already support Atlas or another managed DB.
- The current WatchTower API/control plane still uses SQLite or PostgreSQL via `DATABASE_URL`.
- Prefer Podman secrets over plain env vars for connection strings.
- The deploy workflow at `.github/workflows/deploy.yml` is the `WatchTower Deployer` pipeline and pushes both `latest` and SHA tags to `ghcr.io/<owner>/<repo>` on every push to `main`.
- The node-side default Watchtower poll interval for hybrid mode is 30 seconds.
- Upstream reference: image update and restart behavior comes from `containrrr/watchtower`.
  See: https://github.com/containrrr/watchtower

### WatchTower Mesh (Vercel-On-Podman)

For a Vercel-style self-hosted path with blue-green cutover and Caddy routing:

- Compose stack: `docker-compose.mesh.yml`
- Node env templates: `.env.mesh.primary.example`, `.env.mesh.standby.example`
- Join script: `scripts/join-watchtower-mesh.sh`
- Blue-green rollout: `scripts/mesh-bluegreen-deploy.sh`
- Preview deployments: `scripts/mesh-preview-deploy.sh`
- Runbook: `docs/WATCHTOWER_MESH_VERCEL.md`

Quick start:

```bash
cp .env.mesh.primary.example .env.mesh
echo 'mongodb+srv://user:pass@cluster.mongodb.net/dbname?retryWrites=true&w=majority' | podman secret create mongo_uri -
./scripts/join-watchtower-mesh.sh .env.mesh
```

Notes:

- Caddy handles automatic TLS and stable domain routing.
- The mesh defaults to a 15-second Watchtower poll interval for fast sync.
- Zero-downtime promotion is handled by the blue-green deploy script, because Watchtower alone is not a health-gated blue-green rollout engine.
- Non-main branches can publish preview images through `.github/workflows/preview-image.yml`.
- Upstream reference: for all container auto-update flags and behavior, refer to `containrrr/watchtower` docs.
  See: https://github.com/containrrr/watchtower

### Release Safety (Tests First)

Releases are now gated by tests:

- CI release workflow `.github/workflows/release.yml` runs `pytest` before creating a release.
- Local release helper `scripts/release.sh` runs tests before tag creation/push.

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
- Use release tags (for example `v1.2.2`) to produce versioned artifacts.

Version-controlled release process:

- `watchtower-podman` on PyPI for `pip` installs
- OCI container image on GHCR for Docker/Podman/Kubernetes ecosystems
- GitHub Release artifacts for manual distribution on Linux/macOS/Windows

Example:

```bash
./scripts/release.sh 1.2.2
```

1. Bump `watchtower/__init__.py` version (single source of truth).
2. Commit and merge to `main`.
3. Create and push a semantic tag like `v1.1.1`.
4. GitHub Actions will automatically:
  - Create GitHub Release notes
  - Publish container image to GHCR
  - Publish package to PyPI

Optional helper command:

```bash
./scripts/release.sh 1.1.1
```

### GitHub Pages Documentation Site

- Source files are in `docs/`
- Deployment workflow: `.github/workflows/deploy-pages.yml`
- URL: `https://sinhaankur.github.io/WatchTower/`

If Pages has never been enabled on this repository:

1. Open repository settings -> Pages
2. Under Build and deployment, select Source: `GitHub Actions`
3. Run the `Deploy Docs Site` workflow once (or push docs changes)

### Unified Direct Installer Entry Points

For a one-file installer flow similar to Podman/Tailscale:

- Linux and macOS: `./install_watchtower.sh`
- Windows: `install_watchtower_windows.cmd`

Examples:

```bash
# Linux/macOS (recommended)
./install_watchtower.sh

# Linux legacy mode (older install.sh flow)
./install_watchtower.sh --mode legacy
```

```powershell
.\install_watchtower_windows.cmd
```

### Native Desktop Installer Artifacts (.dmg, .AppImage/.deb, .exe)

This repo now includes a cross-platform build workflow:

- Workflow file: `.github/workflows/build-desktop-installers.yml`
- Trigger: manual (`workflow_dispatch`) or tag push (`v*`)

What it builds:

- macOS: `.dmg`, `.zip`
- Linux: `.AppImage`, `.deb`
- Windows: `.exe` (NSIS), `.zip`

Run from GitHub Actions:

1. Open Actions -> `Build Desktop Installers`
2. Click `Run workflow`
3. Download artifacts from the completed run

Desktop icon assets are generated from `assets/wt-logo.svg`:

```bash
cd desktop
npm run icons
```

### One-Command App Center Install (Linux)

```bash
sudo ./install_app_center.sh
```

This installer:
- Installs runtime dependencies (python3, venv, git, rsync, ssh client)
- Installs WatchTower into /opt/watchtower/.venv
- Sets up /etc/watchtower/nodes.json and /etc/watchtower/apps.json
- Creates and starts systemd service: watchtower-appcenter

After install:
```bash
sudo systemctl status watchtower-appcenter
curl http://<server-ip>:8000/health
```

### Windows Installation (App Center)

```powershell
powershell -ExecutionPolicy Bypass -File .\install_windows.ps1
powershell -ExecutionPolicy Bypass -File .\run_app_center_windows.ps1
```

Default user paths on Windows:
- Install dir: `%USERPROFILE%\\WatchTowerAppCenter`
- Config dir: `%USERPROFILE%\\WatchTowerConfig`

Health check:
```powershell
curl http://127.0.0.1:8000/health
```

### macOS Installation (App Center)

```bash
./install_macos.sh
./run_app_center_macos.sh
```

Default user paths on macOS:
- Install dir: `~/watchtower-appcenter`
- Config dir: `~/.watchtower`

Health check:
```bash
curl http://127.0.0.1:8000/health
```

### Ubuntu/Linux Installation

1. **Install Podman** (if not already installed):
```bash
sudo apt update
sudo apt install podman
```

2. **Clone the repository**:
```bash
git clone https://github.com/sinhaankur/WatchTower.git
cd WatchTower
```

3. **Install WatchTower**:
```bash
# Install dependencies
pip3 install -r requirements.txt

# Install WatchTower
sudo python3 setup.py install
```

4. **Create configuration directory**:
```bash
sudo mkdir -p /etc/watchtower
sudo mkdir -p /var/log/watchtower
```

5. **Copy and configure**:
```bash
sudo cp config/watchtower.yml /etc/watchtower/
sudo nano /etc/watchtower/watchtower.yml  # Edit configuration
```

6. **Set up systemd service**:
```bash
sudo cp systemd/watchtower.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable watchtower
sudo systemctl start watchtower
```

### Manual Installation (Development)

For development or testing without system-wide installation:

```bash
# Install dependencies
pip3 install -r requirements.txt

# Run directly from source
python3 -m watchtower --help
```

## Configuration

WatchTower uses a YAML configuration file. The default locations searched are:
1. `/etc/watchtower/watchtower.yml`
2. `/opt/watchtower/config/watchtower.yml`
3. `./config/watchtower.yml`
4. `./watchtower.yml`

### Configuration Example

```yaml
watchtower:
  # Check interval in seconds (300 = 5 minutes)
  interval: 300
  
  # Remove old images after successful update
  cleanup: true
  
  # Monitor only mode - check for updates but don't apply them
  monitor_only: false

containers:
  # Include specific containers (empty means all)
  include: []
    # - "my-app"
    # - "web-*"  # Wildcard patterns supported
  
  # Exclude specific containers
  exclude:
    - "database-*"
    - "postgres"

notifications:
  enabled: true
  type: "log"  # log, email, webhook

logging:
  level: "INFO"  # DEBUG, INFO, WARNING, ERROR, CRITICAL
  file: "/var/log/watchtower/watchtower.log"
  max_size: "10MB"
  backup_count: 5
```

### Configuration Options

#### Watchtower Section
- `interval`: Update check interval in seconds (default: 300)
- `cleanup`: Remove old images after update (default: true)
- `monitor_only`: Dry-run mode, only check for updates (default: false)

#### Containers Section
- `include`: List of container names to monitor (empty = all containers)
- `exclude`: List of container names to exclude from monitoring
- Both support wildcard patterns using `*`

#### Notifications Section
- `enabled`: Enable notifications (default: true)
- `type`: Notification type - `log`, `email`, or `webhook`

#### Logging Section
- `level`: Log level - `DEBUG`, `INFO`, `WARNING`, `ERROR`, `CRITICAL`
- `file`: Path to log file
- `max_size`: Maximum log file size before rotation (e.g., "10MB")
- `backup_count`: Number of backup log files to keep

## Usage

### CLI Commands

WatchTower provides several command-line commands:

#### Start Service
Start the WatchTower service (runs continuously):
```bash
watchtower start
```

Or with custom config:
```bash
watchtower -c /path/to/config.yml start
```

#### Check Status
View current status and monitored containers:
```bash
watchtower status
```

#### Immediate Update
Trigger an immediate update check:
```bash
watchtower update-now
```

#### List Containers
List all containers being monitored:
```bash
watchtower list-containers
```

#### Validate Configuration
Check if your configuration file is valid:
```bash
watchtower validate-config
```

### Deployment Orchestrator Mode

WatchTower also provides a deployment API/server mode for website rollouts to
multiple Linux nodes over SSH.

It now includes a dashboard-style control center UI (inspired by modern
deployment consoles) for projects, usage, and recent deployment activity.

#### Start Deployment Listener
```bash
watchtower-deploy serve --host 0.0.0.0 --port 8000
```

#### Open Dashboard UI
```bash
http://<server-ip>:8000/dashboard
```

The dashboard fetches live data from:
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

On Windows and macOS, these values are written automatically to `appcenter.env`
by the platform installer scripts and loaded by the platform run scripts.

#### Deploy by App Name (Recommended)
```bash
WATCHTOWER_BASE_URL=http://server:8000 WATCHTOWER_TOKEN=change-me ./deploy.sh --app website-main main
```

#### List Registered Apps
```bash
curl -H "X-Watchtower-Token: change-me" http://server:8000/apps
```

#### Trigger Deployment from Dev PC
```bash
WATCHTOWER_URL=http://server:8000/deploy WATCHTOWER_TOKEN=change-me ./deploy.sh main
```

#### Run One-Off Deployment on Server
```bash
watchtower-deploy deploy-now --branch main
```

#### Run One-Off App Deployment on Server
```bash
watchtower-deploy deploy-app --app website-main --branch main
```

### Create Device-Compatible App Packages

Build portable deployment bundles for multiple targets:

```bash
watchtower-package --name website-main --source ./dist --target linux --format tar.gz
watchtower-package --name desktop-client --source ./build --target windows --format zip
```

Generated output includes:
- Archive bundle (.tar.gz or .zip)
- Manifest JSON with target metadata

### Running as a Service

#### Start/Stop Service
```bash
sudo systemctl start watchtower
sudo systemctl stop watchtower
sudo systemctl restart watchtower
```

#### Check Service Status
```bash
sudo systemctl status watchtower
```

#### View Logs
```bash
# Systemd logs
sudo journalctl -u watchtower -f

# Application logs
sudo tail -f /var/log/watchtower/watchtower.log
```

#### Enable Auto-Start
```bash
sudo systemctl enable watchtower
```

## How It Works

### Container Update Flow

1. **Discovery**: WatchTower scans all running Podman containers
2. **Filtering**: Applies include/exclude rules from configuration
3. **Update Check**: For each container, checks if a newer image exists in the registry
4. **Image Pull**: If an update is available, pulls the new image
5. **Graceful Stop**: Stops the old container with a timeout
6. **Container Recreation**: Creates a new container with the same configuration:
   - Same name
   - Same environment variables
   - Same port mappings
   - Same volume mounts
   - Same restart policy
   - Same labels
7. **Health Verification**: Verifies the new container is running
8. **Cleanup**: Optionally removes old, unused images
9. **Notification**: Logs the update result

### Container Configuration Preservation

WatchTower preserves the following during updates:
- Container name
- Environment variables
- Port bindings
- Volume mounts
- Restart policies
- Labels
- Command arguments

## Examples

### Monitor All Containers
```yaml
containers:
  include: []
  exclude: []
```

### Monitor Specific Containers
```yaml
containers:
  include:
    - "nginx"
    - "redis"
    - "app-*"
  exclude: []
```

### Exclude Databases
```yaml
containers:
  include: []
  exclude:
    - "postgres"
    - "mysql"
    - "mongodb"
    - "database-*"
```

### Dry-Run Mode
```yaml
watchtower:
  monitor_only: true
```

### Frequent Checks (Every Minute)
```yaml
watchtower:
  interval: 60
```

## Troubleshooting

### WatchTower Won't Start

1. Check if Podman is installed:
```bash
podman --version
```

2. Verify configuration:
```bash
watchtower validate-config
```

3. Check permissions:
```bash
# WatchTower needs access to Podman socket
ls -la /run/podman/podman.sock
```

### Containers Not Being Updated

1. Check if containers are being monitored:
```bash
watchtower list-containers
```

2. Review include/exclude rules in configuration

3. Check logs for errors:
```bash
sudo tail -f /var/log/watchtower/watchtower.log
```

### Permission Denied Errors

WatchTower typically needs to run as root or a user with Podman socket access:

```bash
# Run as root
sudo watchtower start

# Or configure rootless Podman (advanced)
```

### No Updates Detected

1. Manually check for image updates:
```bash
podman pull <image-name>
```

2. Verify the image tag in your container (avoid `latest` ambiguity)

3. Check if registry is accessible

## Security Considerations

- **Minimal Permissions**: Run with the minimum required permissions
- **Configuration Validation**: All configuration inputs are validated
- **No Hardcoded Credentials**: No credentials stored in code
- **Secure Updates**: Uses Podman's built-in security features
- **Graceful Handling**: Errors don't expose sensitive information

### Website Security Baseline (Recommended)

Use this checklist when running WatchTower as a website deployment App Center.

1. **Protect the Deploy API**
  - Set a strong `WATCHTOWER_TRIGGER_TOKEN` in `/etc/watchtower/appcenter.env`
  - Keep the API private to your LAN or VPN whenever possible
  - Restrict access with firewall rules (allow only trusted admin/dev IPs)

2. **Use Least Privilege on Nodes**
  - Use a dedicated non-root user (for example `deploy`)
  - In `sudoers`, allow only specific restart commands with `NOPASSWD`
  - Avoid broad rules like `ALL=(ALL) NOPASSWD:ALL`

3. **Harden SSH Access**
  - Use key-based authentication only
  - Disable password authentication on target nodes
  - Rotate SSH keys periodically and remove unused keys

4. **Secure Reverse Proxy / Web Stack**
  - Enforce HTTPS and modern TLS ciphers
  - Add security headers: `HSTS`, `X-Content-Type-Options`, `X-Frame-Options`, `Referrer-Policy`, and a suitable `Content-Security-Policy`
  - Run regular dependency and OS patch updates

5. **Audit and Recovery**
  - Store deployment logs centrally and rotate logs
  - Keep database and website backups before deployment
  - Test rollback procedure for each app

### Minimal Safe Deployment Example

```bash
# Restrict App Center service variables
sudo nano /etc/watchtower/appcenter.env

# Verify service and health endpoint from trusted host
sudo systemctl status watchtower-appcenter
curl http://<server-ip>:8000/health
```

For internet-facing deployments, place the App Center API behind an authenticated
gateway or VPN and do not expose it directly to the public internet.

### Security CI (Automated)

This repository includes automated Trivy scanning in
`.github/workflows/security-scan.yml`.

- Runs on pull requests and pushes to `main`
- Scans both filesystem dependencies and the built container image
- Fails the workflow on `CRITICAL` or `HIGH` vulnerabilities (excluding unfixed CVEs)

Use this as a merge gate for safer releases.

## Development

### Project Structure
```
watchtower/
├── watchtower/
│   ├── __init__.py
│   ├── __main__.py         # Module entry point
│   ├── main.py             # Main entry point
│   ├── cli.py              # CLI interface
│   ├── config.py           # Configuration parser
│   ├── logger.py           # Logging setup
│   ├── podman_manager.py   # Podman operations
│   ├── updater.py          # Update logic
│   └── scheduler.py        # Scheduling
├── config/
│   └── watchtower.yml      # Example config
├── systemd/
│   └── watchtower.service  # Systemd service
├── tests/
│   └── test_*.py           # Unit tests
├── README.md
├── LICENSE
├── requirements.txt
└── setup.py
```

### Running Tests

```bash
# Install test dependencies
pip3 install pytest pytest-cov

# Run tests
pytest tests/

# Run with coverage
pytest --cov=watchtower tests/
```

### Contributing

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Add tests for new functionality
5. Ensure tests pass
6. Submit a pull request

For full contribution guidance, see [CONTRIBUTING.md](CONTRIBUTING.md).

### Extending WatchTower (For Contributors)

WatchTower is intended to be extended by the community. Common extension areas:

1. **New Deployment Integrations**
  - Add additional build/deploy workflows in `watchtower/deploy_server.py`
  - Add new API endpoints for deployment strategies (blue/green, canary)

2. **Notification and Observability**
  - Extend notifications beyond logs (email, webhook, Slack, Teams)
  - Add metrics export and health dashboards

3. **Safety Features**
  - Add pre-deploy checks (disk space, service availability, config validation)
  - Add automated rollback on failed health checks

4. **Packaging and Platform Support**
  - Improve `watchtower/package_builder.py` targets and artifact signing
  - Add optional installers for additional Linux distributions

If you add new functionality, please include:
- Tests for success and failure paths
- README updates for new commands/config
- Security implications and safe defaults

## Future Roadmap

- [ ] Windows support with Docker Desktop
- [ ] macOS support
- [ ] Docker runtime support (in addition to Podman)
- [ ] Email notification support
- [ ] Webhook notification support
- [ ] Web UI for monitoring and configuration
- [ ] Container rollback capability
- [ ] Update scheduling with cron expressions
- [ ] Slack/Discord integration
- [ ] Metrics and monitoring integration (Prometheus)
- [ ] Multi-host support

## License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

## Support

For issues, questions, or contributions, please visit:
- GitHub Issues: https://github.com/sinhaankur/WatchTower/issues
- Documentation: https://github.com/sinhaankur/WatchTower

## Acknowledgments

- Inspired by the Docker Watchtower project
- Built for the Podman container runtime
- Thanks to all contributors

---

**Note**: This is a container management tool that performs automatic updates. Always test in a non-production environment first and ensure you have proper backups before deploying to production systems.
