# WatchTower Mesh

This project allows a team to run a high-availability server mesh on local hardware with cloud-backed persistence.

Project goal: a decentralized, free-tier Vercel-style deployment model using local hardware for compute and a managed cloud database for persistence.

This guide covers the hybrid model where your Podman nodes provide compute and rollout automation, while a managed cloud database provides durable storage.

## Visual Overview

![WatchTower hybrid stack](https://sinhaankur.github.io/WatchTower/assets/hybrid-stack.svg)

![WatchTower application and web app surface](https://sinhaankur.github.io/WatchTower/assets/application-surface.svg)

![WatchTower secure terminal command flow](https://sinhaankur.github.io/WatchTower/assets/secure-terminal-flow.svg)

The intended fit is:

- Node A and Node B run the same application image under Podman.
- Watchtower keeps both nodes aligned with GHCR.
- Tailscale provides private connectivity between operators and nodes.
- MongoDB Atlas provides the shared system of record.
- Cloudflare or Tailscale routing decides which node receives traffic.

## Scope Boundary

This hybrid path is designed for workload containers deployed by WatchTower.

Today, the WatchTower control plane itself is still SQLAlchemy-based and expects SQLite or PostgreSQL via `DATABASE_URL`. MongoDB Atlas is therefore not a drop-in replacement for the WatchTower API internals without a persistence-layer rewrite.

If you are deploying your own application image and that image already supports Atlas, use the files in this guide.

## 1. System Architecture

- Application: hosted in GitHub and published to GHCR.
- Database: MongoDB Atlas M0 handles global persistence and managed backups.
- Nodes: any team member machine running Podman can join the mesh.
- Networking: Tailscale provides private node-to-node communication.
- Sync agent: Watchtower checks GHCR for updates every 30 seconds.

## 2. Files Added For Hybrid Mode

- `docker-compose.hybrid.yml`
- `.env.hybrid.primary.example`
- `.env.hybrid.standby.example`
- `scripts/hybrid-node-up.sh`

The hybrid compose intentionally removes the local database container. Both nodes point at the same managed database instead.

## 3. Atlas Connection String

Use the SRV connection string from Atlas so the driver can follow Atlas topology changes automatically:

```text
mongodb+srv://<username>:<password>@cluster0.abcde.mongodb.net/<database>?retryWrites=true&w=majority
```

This is the right default for Atlas because:

- it discovers the cluster topology automatically
- Atlas handles its own primary elections and failover
- both nodes share the same source of truth

## 2. Local Node Setup (Primary And Standby)

Before deployment, each team member prepares their local environment on the machine that will participate in the mesh.

### A. Enable the Podman API

Podman must expose its socket for Watchtower:

```bash
systemctl --user enable --now podman.socket
```

### B. Add the MongoDB Secret

Store the Atlas SRV URI as a Podman secret instead of committing it or placing it in plain environment variables:

```bash
echo 'mongodb+srv://user:pass@cluster.mongodb.net/app?retryWrites=true&w=majority' | podman secret create mongo_uri -
```

If the image is private in GHCR, also prepare a read-only package token and store it in the node env file as `GH_PAT_TOKEN`.

## 5. Network Access And Security

Because local node public IPs are often dynamic, choose one of these patterns:

### Preferred: Tailscale Connector Or Exit Node

- route Atlas-bound traffic through a known egress path
- whitelist that stable egress IP in Atlas
- keep direct public exposure of your home or office nodes out of Atlas rules

### Fastest But Weakest: `0.0.0.0/0`

- Atlas can be opened to all IPs
- this is acceptable only for short-lived testing
- do not treat it as a production posture

### Tailscale + Atlas Bridge Pattern

- use Tailscale to centralize operator access to the nodes
- keep Atlas restricted to approved egress IPs
- use tailnet ACLs to limit who can reach node admin ports

## 6. Protect Secrets With Podman Secrets

Do not commit Atlas credentials into Git or hardcode them in compose.

Create the secret on each node:

```bash
echo 'mongodb+srv://user:pass@cluster.mongodb.net/app?retryWrites=true&w=majority' | podman secret create mongo_uri -
```

The hybrid bootstrap script detects `HYBRID_MONGO_SECRET_NAME` and mounts that secret into the container as:

```text
/run/secrets/mongo_uri
```

Your application image should then read either:

- `MONGODB_URI_FILE=/run/secrets/mongo_uri`
- or `MONGODB_URI` directly if you intentionally use env injection instead of a secret

## 7. Connection Pool Guidance

The example env files include conservative starting values:

- `MONGO_MAX_POOL_SIZE=20`
- `MONGO_MIN_POOL_SIZE=2`
- `MONGO_MAX_IDLE_TIME_MS=300000`
- `MONGO_CONNECT_TIMEOUT_MS=10000`
- `MONGO_SOCKET_TIMEOUT_MS=30000`
- `MONGO_SERVER_SELECTION_TIMEOUT_MS=5000`

These values assume:

- two long-running Podman nodes
- low to moderate concurrency per node
- mostly OLTP-style traffic
- Atlas handling the replica set and failover internally

If your traffic is bursty or high-concurrency, increase pool size only after observing real Atlas connection counts and application wait time. Do not blindly scale connection pools upward because each connection consumes server memory and every app node creates its own pool.

## 3. Multi-Node Deployment Config

The repository ships the node-side compose file as [docker-compose.hybrid.yml](../docker-compose.hybrid.yml). This is the shared deployment config that both nodes run with Podman.

Its effective structure is:

```yaml
services:
  app-server:
    image: ghcr.io/<owner>/<repo>:latest
    restart: always
    secrets:
      - mongo_uri
    environment:
      MONGODB_URI_FILE: /run/secrets/mongo_uri
    ports:
      - "80:80"

  watchtower:
    image: docker.io/containrrr/watchtower:latest
    volumes:
      - ${XDG_RUNTIME_DIR}/podman/podman.sock:/var/run/docker.sock
    environment:
      WATCHTOWER_POLL_INTERVAL: 30
      WATCHTOWER_CLEANUP: true
      REPO_USER: ${GH_USERNAME}
      REPO_PASS: ${GH_PAT_TOKEN}
    command: --interval 30 --label-enable
```

The checked-in compose file also passes optional SQL settings through unchanged so the same hybrid path still works for apps that use a managed SQL database instead of Atlas.

## 9. Start The Hybrid Stack

On Node A:

```bash
cp .env.hybrid.primary.example .env.hybrid
```

On Node B:

```bash
cp .env.hybrid.standby.example .env.hybrid
```

Then edit the file on each node:

- set `NODE_TAILSCALE_IP` and `PEER_TAILSCALE_IP`
- set `APP_IMAGE`
- set `HYBRID_MONGO_SECRET_NAME=mongo_uri` if using Podman secrets
- or set `MONGODB_URI` directly if you are not using secrets
- keep `MONGODB_URI_FILE=/run/secrets/mongo_uri` when using secrets

Start the node:

```bash
./scripts/hybrid-node-up.sh .env.hybrid
```

What the script does:

- enables the Podman user socket for Watchtower
- logs into GHCR when credentials are provided
- checks that required Podman secrets exist
- mounts the secret only when you configured one
- starts `app-server` and `watchtower`

## 10. Hybrid Compose Shape

The hybrid stack only needs these services:

- `app-server`
- `watchtower`

There is no local database container because Atlas is the persistent layer.

This means a node failure does not require database promotion on the node itself. Traffic can move to the surviving node while both nodes continue targeting the same Atlas cluster.

## 4. Automated GitHub Action

The repository workflow at [.github/workflows/deploy.yml](../.github/workflows/deploy.yml) now builds on pushes to `main` and publishes:

- `ghcr.io/<owner>/<repo>:latest`
- `ghcr.io/<owner>/<repo>:<git-sha>`

This is the Vercel-style part of the system. Any push to `main` can trigger an image update path for the whole mesh.

That gives the node-side Watchtower agents a single registry source of truth. Your deployment loop becomes:

1. push code to `main`
2. GitHub Actions builds and pushes the image to GHCR
3. Watchtower polls GHCR every 30 seconds
4. primary and standby nodes restart onto the new image
5. both nodes reconnect to the same Atlas cluster

## 5. Backup And Failover Logic

Redundancy works at the compute layer because both nodes point to the same Atlas cluster.

If the primary node goes offline:

- the standby node keeps serving traffic
- the standby node is already using the same Atlas-backed data
- only traffic routing must shift

Atlas handles managed database backups. If you still want a local backup copy, schedule this on a standby node:

```bash
podman run --rm docker.io/mongodb/mongodb-database-tools:latest \
	mongodump --uri="$(podman secret inspect mongo_uri --showsecret | sed -n 's/^.*"SecretData": "\(.*\)".*$/\1/p')" \
	--archive > backup_$(date +%F).archive
```

If your local Podman version does not support `--showsecret`, read the URI from your team secret manager and inject it at runtime instead of storing it in shell history.

Pro tip: run a Cloudflare Tunnel on both primary and standby nodes. Cloudflare can route to whichever node is alive without exposing your home router directly.

## 6. Team Management

Adding a member is straightforward:

1. Install Podman on their machine.
2. Add them to the Tailscale network.
3. Share the Atlas secret through your normal secret-sharing process.
4. Have them create `mongo_uri` locally with `podman secret create`.
5. Have them run `./scripts/hybrid-node-up.sh .env.hybrid`.

Once their stack is up, that machine is another node in the cluster.

Any team member with write access to the repository can push to `main`. The mesh will pull the new image and restart onto it automatically.

## 7. Team Checklist

- [ ] GitHub: add team members as collaborators.
- [ ] MongoDB Atlas: add team members to the Atlas project.
- [ ] Tailscale: invite team members to the tailnet.
- [ ] Podman nodes: create the `mongo_uri` secret on each node.
- [ ] GHCR: issue read-only package access if images are private.

## 8. Operational Checks

Quick checks:

```bash
podman ps
podman logs wt-updater-$(grep NODE_NAME .env.hybrid | cut -d= -f2) --tail=100
podman secret inspect ${HYBRID_MONGO_SECRET_NAME:-mongo_uri}
curl -fsS http://127.0.0.1:${APP_PORT:-8080}/health
```

## 9. Scope Boundary

The current WatchTower control plane still uses SQLAlchemy and expects SQLite or PostgreSQL via `DATABASE_URL`. MongoDB Atlas is therefore not a drop-in replacement for the WatchTower API internals without a persistence-layer rewrite.

This mesh mode is for workload containers that already support Atlas or another managed cloud database.

## 10. If Your App Is Not Mongo-Native

If the image you are deploying still expects a SQL database, use a managed PostgreSQL provider instead and pass `DATABASE_URL` or `DATABASE_URL_FILE` through the same hybrid workflow.

That is the supported cloud-managed database path for the current WatchTower control-plane code today.