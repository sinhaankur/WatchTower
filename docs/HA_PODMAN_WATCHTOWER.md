# WatchTower HA Edge Cluster (Podman + Watchtower + Tailscale)

This guide implements a two-node Primary-Standby deployment across different physical locations.

## Topology

- Node A (Primary): serves app traffic and hosts primary PostgreSQL.
- Node B (Standby): hot standby for app and replicated PostgreSQL.
- Tailscale: private mesh network between all nodes.
- Watchtower: pulls new images from GHCR and restarts services on both nodes.
- Failover: choose Cloudflare health-based DNS failover or host-level Keepalived VIP.

Upstream Watchtower reference:

- This HA mode uses the upstream container updater behavior from `containrrr/watchtower`.
- For feature flags, scheduling behavior, notifications, and limitations, refer to:
  https://github.com/containrrr/watchtower

## 1. Prerequisites

Install on both nodes:

```bash
sudo apt-get update
sudo apt-get install -y podman podman-compose curl
curl -fsSL https://tailscale.com/install.sh | sh
```

Login node to your tailnet:

```bash
sudo tailscale up
tailscale ip -4
```

Record each node static Tailscale IP.

## 2. Configure Node Environment

Files provided:

- `.env.ha.primary.example`
- `.env.ha.standby.example`
- `docker-compose.ha.yml`

On Node A:

```bash
cp .env.ha.primary.example .env.ha
```

On Node B:

```bash
cp .env.ha.standby.example .env.ha
```

Edit `.env.ha` on both nodes:

- set `NODE_TAILSCALE_IP` and `PEER_TAILSCALE_IP`
- set `APP_IMAGE` to your GHCR image
- set strong values for all `POSTGRESQL_*PASSWORD` variables
- set `GH_USERNAME` and `GH_PAT_TOKEN` if GHCR image is private

## 3. Start HA Stack on Each Node

```bash
./scripts/ha-node-up.sh .env.ha
```

This script:

- enables Podman user socket for Watchtower
- logs in to GHCR when credentials are present
- launches `database`, `app-server`, and `watchtower` from `docker-compose.ha.yml`

Validate services:

```bash
podman ps
podman logs wt-db-$(grep NODE_NAME .env.ha | cut -d= -f2) --tail=50
```

## 4. Database Replication Model

Replication mode is env-driven:

- Primary node: `POSTGRESQL_REPLICATION_MODE=master`
- Standby node: `POSTGRESQL_REPLICATION_MODE=slave`
- Standby follows `POSTGRESQL_MASTER_HOST=<primary tailscale ip>`

This uses Bitnami PostgreSQL replication variables for a free self-hosted setup.

## 5. Failover Strategy

### Option A: Cloudflare (recommended for internet-facing)

1. Put app behind Cloudflare DNS.
2. Create health checks to Node A endpoint.
3. Configure failover to Node B origin when Node A is unhealthy.

Pros:

- no host networking complexity
- simple rollback and global edge protection

### Option B: Keepalived VIP (recommended for local/private routing)

Install Keepalived on both Linux hosts:

```bash
sudo apt-get install -y keepalived
```

Use health check helper:

```bash
chmod +x ./scripts/check-watchtower-app.sh
```

Example health script line in Keepalived config:

```conf
vrrp_script chk_watchtower {
  script "/path/to/scripts/check-watchtower-app.sh http://127.0.0.1:8080/health"
  interval 2
  timeout 3
  rise 2
  fall 3
}
```

Use higher priority on primary node and lower priority on standby.

## 6. CI/CD Update Flow

The repository workflow `.github/workflows/deploy.yml` does this:

1. Run tests.
2. Build multi-arch image.
3. Push to GHCR (`latest` + SHA tag).

At runtime:

- Watchtower on both nodes polls GHCR every `WATCHTOWER_POLL_INTERVAL` seconds.
- both nodes pull and restart the app container automatically.

## 7. Daily Standby Backup

Use standby node for backups:

```bash
./scripts/ha-db-backup.sh .env.ha
```

Add cron on standby host:

```bash
crontab -e
```

```cron
0 2 * * * cd /path/to/WatchTower && ./scripts/ha-db-backup.sh .env.ha >> /var/log/watchtower-ha-backup.log 2>&1
```

## 8. Add a New Team Member

1. Add collaborator/team permission on GitHub repo.
2. Add member device to Tailscale tailnet.
3. Share `.env.ha` template values (without committing secrets).
4. Member starts node with:

```bash
./scripts/ha-node-up.sh .env.ha
```

## 9. Security Baseline

- Keep all secrets only in `.env.ha` (never commit real values).
- use short-lived GHCR token where possible.
- set `WATCHTOWER_API_TOKEN` and `WATCHTOWER_SECRET_KEY` in `.env.ha`.
- rotate DB and replication passwords regularly.
- restrict Tailscale ACLs so only trusted devices can access DB ports.

## 10. Operational Checks

Quick checks:

```bash
podman ps
podman logs wt-updater-$(grep NODE_NAME .env.ha | cut -d= -f2) --tail=100
curl -fsS http://127.0.0.1:8080/health
```

Failover drill:

1. stop app on primary node
2. verify traffic shifts to standby via Cloudflare or VIP
3. recover primary and confirm steady-state routing
