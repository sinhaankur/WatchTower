# Deployment Configurations

Docker Compose files for each WatchTower deployment topology.

## 🔗 Complete Integration Stack

All deployments work best with the full integration stack:

**Podman → Nginx → Tailscale → Cloudflare → Coolify → WatchTower Watchdog**

- **Podman** runs your containerized workloads
- **Nginx** proxies traffic and handles SSL
- **Tailscale** secures node-to-node SSH tunnels
- **Cloudflare** exposes apps to the internet
- **Coolify** provides the app management UI
- **WatchTower Watchdog** auto-restarts containers after reboots or crashes

See the **Integrations** page in WatchTower (`/integrations`) for:
- Live connection status for all 6 tools
- Toggle the Podman Watchdog (auto-restart on reboot)
- View install commands for each tool
- Understand dependencies and connections

---

## Available Topologies

| File | Topology |
|------|----------|
| `docker-compose.yml` (root) | Standard single-node |
| `docker-compose.app.yml` (root) | Single-node app runtime (Docker-first quick start) |
| `docker-compose.ha.yml` | High-availability primary + standby |
| `docker-compose.hybrid.yml` | Hybrid cloud (local + remote nodes) |
| `docker-compose.mesh.yml` | Multi-node mesh network |
| `docker-compose.vercel-like.yml` | Vercel-style preview/production |

Example `.env` files are in the repo root (`*.example`).

Port mapping notes:
- `APP_PORT` controls the host port.
- `APP_CONTAINER_PORT` controls the port exposed inside your app container.
- Defaults are set per topology, and can be overridden in your `.env`.

See the [HA & Podman docs](../docs/HA_PODMAN_WATCHTOWER.md) and [Hybrid Cloud docs](../docs/HYBRID_CLOUD_DATABASES.md) for setup details.

Private Repo + Auto-Update (No Vercel Needed)
- If your repo is private and Vercel cannot auto-deploy on your plan, use image-based deploys with GHCR + Watchtower.
- This repo already includes workflows:
	- `.github/workflows/publish-container.yml` for `main` and tags
	- `.github/workflows/preview-image.yml` for non-main branches

Quick setup:
- In your host `.env` (or `.env.mesh`) set:
	- `APP_IMAGE=ghcr.io/<owner>/<repo>:<tag>`
	- `GH_USERNAME=<github-username>`
	- `GH_PAT_TOKEN=<token-with-read:packages>`
- For branch previews, use the sanitized branch tag produced by `preview-image.yml`.
	- Example branch: `feature/dashboard-ui-workflow`
	- Example image tag: `feature-dashboard-ui-workflow`

Cloudflare validation after deploy:
- Use a real hostname (not `app.yourdomain.com`) and run:
	- `./scripts/test-cloudflare.sh --hostname app.<your-real-domain> --path /health`
- Optional tunnel check:
	- `./scripts/test-cloudflare.sh --hostname app.<your-real-domain> --tunnel <tunnel-name> --path /health`
