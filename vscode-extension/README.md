# WatchTower Ops for VS Code

Deploy, monitor, and manage your [WatchTower](https://github.com/sinhaankur/WatchTower) projects without leaving the editor. WatchTower Ops adds a sidebar, status bar, and command palette integration that talks directly to your WatchTower API server — local, remote, or self-hosted.

WatchTower itself is a desktop-first deployment control plane for projects backed by Podman (or Docker) and Nixpacks. This extension is the IDE-side companion: trigger a deploy, watch logs stream, roll back a bad deployment, or pop open the project's live URL — all from inside VS Code.

## Features

- **Full WatchTower dashboard inside VS Code.** `WatchTower: Open Dashboard (in editor)` opens the entire WatchTower SPA — projects, deployments, diagnose, auto-fix, backup, settings, audit log — as a side-tab inside VS Code. Signed in automatically with your stored API token; no browser switch, no second login. **The seamless deploy-without-leaving-the-editor flow.**
- **Sidebar tree of your projects.** Every project in your WatchTower org appears in a dedicated sidebar with its current deployment status, last build time, and last commit.
- **One-click deploy.** Right-click a project → **Deploy** → tail the build log inside an Output channel as it streams.
- **Live deployment logs.** `WatchTower: Show Deployment Logs` opens the most recent build's output in an OS-native log view that auto-refreshes.
- **Rollback the last deployment.** When a deploy goes sideways, `WatchTower: Rollback Last Deployment` flips the project back to the previous successful build without leaving the editor.
- **Open in browser / open in editor.** Jump straight to the deployed URL or open the project's source folder in a new VS Code window.
- **Status bar item** — current org and connection state at a glance; click to refresh.
- **Token-based auth, stored in the system keychain.** `WatchTower: Set API Token` stores credentials in the OS-native secret store (macOS Keychain, Windows Credential Manager, libsecret on Linux) — never in `settings.json`.

## Quick start

### 1. Install the extension

```bash
code --install-extension sinhaankur.watchtower-podman
```

Or search for **WatchTower Ops** in the Extensions sidebar (`Ctrl+Shift+X` / `⌘⇧X`).

### 2. Run a WatchTower API server

The extension talks to a running WatchTower backend. Easiest option — install the desktop app from the [GitHub Releases page](https://github.com/sinhaankur/WatchTower/releases) and launch it. The backend starts on `http://127.0.0.1:8000` by default.

Other options:
- **PyPI** (Ubuntu 24.04+ / Debian 12+ / Fedora 38+ / recent Homebrew): `pipx install watchtower-podman` then `watchtower-deploy serve`. Older distros: `pip install watchtower-podman`
- **Docker**: `docker run -p 8000:8000 ghcr.io/sinhaankur/watchtower:latest`
- **Source**: `./run.sh browser` from the repo

Once it's up, browse to `http://127.0.0.1:8000` and complete the setup wizard (GitHub OAuth or device-flow login).

### 3. Point the extension at it

1. Command palette (`Ctrl+Shift+P` / `⌘⇧P`) → **WatchTower: Set API Token**
2. Paste the API token from your WatchTower instance (Settings → API Tokens, or the `WATCHTOWER_API_TOKEN` env var your backend was started with)
3. The sidebar populates with your projects within a few seconds.

If your API server isn't on the default `http://localhost:8000`, also set `watchtower.apiUrl` in your VS Code settings.

## Commands

All commands are available via the command palette:

| Command | What it does |
|---|---|
| `WatchTower: Open Dashboard (in editor)` | Open the full WatchTower SPA inside VS Code as a side-tab — diagnose failures, apply fixes, manage env vars, all without switching apps |
| `WatchTower: Refresh` | Re-fetch projects, deployments, and status from the API |
| `WatchTower: Set API Token` | Store the API token in the system keychain |
| `WatchTower: Open Web UI` | Open the WatchTower web dashboard in your default browser |
| `WatchTower: Deploy Project` | Trigger a fresh deployment of the selected project |
| `WatchTower: Show Deployment Logs` | Stream the most recent build's logs in an Output channel |
| `WatchTower: Rollback Last Deployment` | Roll the project back to the previous successful deployment |
| `WatchTower: Open Project URL` | Open the deployed project URL in your browser |
| `WatchTower: Open Project Folder in VS Code` | Open the project's source folder in a new VS Code window |
| `WatchTower: Copy Project ID` | Copy the project's UUID to the clipboard (handy for API/curl) |

## Settings

| Setting | Default | Description |
|---|---|---|
| `watchtower.apiUrl` | `http://localhost:8000` | Base URL of your WatchTower API server. Use the LAN/WAN address if you're connecting to a remote/self-hosted instance. |
| `watchtower.apiToken` | *(stored in keychain)* | Don't set this directly — use `WatchTower: Set API Token` instead, which stores it in the OS-native secret store. |
| `watchtower.pollIntervalSeconds` | `30` | How often the sidebar refreshes project status. Lower = more responsive, more API calls. |
| `watchtower.openWebUiOnDeploy` | `false` | If true, automatically open the web UI after triggering a deploy so you can watch the build there. |

## Requirements

- **VS Code 1.80 or newer.** The extension is intentionally compatible with older VS Code versions to support users on long-term-support distros and older corporate installs.
- **A running WatchTower API server** (see Quick start step 2). The extension is purely a client; it does not run a backend itself.
- **Network access** between VS Code and the API server. For remote WatchTower hosts, you can use VS Code's built-in **Remote — SSH** to forward the port, or expose the API directly.

## Privacy and security

- API tokens are stored in the OS-native secret store via `vscode.SecretStorage` — never written to `settings.json` or shipped in workspace state.
- The extension never sends data anywhere except your configured `watchtower.apiUrl`. There is no telemetry, no analytics, no third-party SaaS in the loop.
- All API calls use the token you provide; the extension can only do what your token is authorized to do — no privilege escalation.

## Links

- 🏠 **Project home:** [github.com/sinhaankur/WatchTower](https://github.com/sinhaankur/WatchTower)
- 📦 **Desktop app:** [Releases](https://github.com/sinhaankur/WatchTower/releases)
- 🐍 **Python package:** [`pip install watchtower-podman`](https://pypi.org/project/watchtower-podman/)
- 🐛 **Issues / feature requests:** [github.com/sinhaankur/WatchTower/issues](https://github.com/sinhaankur/WatchTower/issues)

## License

MIT
