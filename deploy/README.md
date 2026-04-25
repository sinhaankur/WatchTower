# Deployment Configurations

Docker Compose files for each WatchTower deployment topology.

| File | Topology |
|------|----------|
| `docker-compose.yml` (root) | Standard single-node |
| `docker-compose.ha.yml` | High-availability primary + standby |
| `docker-compose.hybrid.yml` | Hybrid cloud (local + remote nodes) |
| `docker-compose.mesh.yml` | Multi-node mesh network |
| `docker-compose.vercel-like.yml` | Vercel-style preview/production |

Example `.env` files are in the repo root (`*.example`).

See the [HA & Podman docs](../docs/HA_PODMAN_WATCHTOWER.md) and [Hybrid Cloud docs](../docs/HYBRID_CLOUD_DATABASES.md) for setup details.
