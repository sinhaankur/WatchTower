# WatchTower Mesh: Vercel-On-Podman

This mode implements the closest practical equivalent to a self-hosted Vercel workflow in this repository.

## Visual Overview

![WatchTower mesh topology](./assets/mesh-topology.svg)

![WatchTower deployment process](./assets/deploy-process.svg)

## Architecture

- Git listener: GitHub Actions builds images from repository pushes.
- Image registry: GHCR stores the deployable versions.
- Sync layer: each node can see the same image tags.
- Routing: Caddy terminates TLS and routes your domain to the active slot.
- Rollout model: blue-green deploy script starts the new slot, waits for health, reloads Caddy, and only then removes the old slot.
- Persistence: MongoDB Atlas or another managed database remains the shared source of truth.

## Important Constraint

Watchtower is good at polling registries and restarting containers, but it does not natively provide a health-gated blue-green cutover by itself.

Because of that, this mesh mode uses:

- GitHub Actions for automated image creation
- Watchtower for fast infrastructure image sync and registry polling
- `scripts/mesh-bluegreen-deploy.sh` for zero-downtime application promotion

Upstream reference:

- Watchtower updater semantics in this mode come from `containrrr/watchtower`.
- Use upstream docs for supported flags and runtime behavior:
	https://github.com/containrrr/watchtower

That is the safe engineering tradeoff in this repository today.

## Files

- `docker-compose.mesh.yml`
- `.env.mesh.primary.example`
- `.env.mesh.standby.example`
- `config/caddy/Caddyfile.mesh`
- `scripts/join-watchtower-mesh.sh`
- `scripts/mesh-bluegreen-deploy.sh`
- `scripts/mesh-preview-deploy.sh`
- `.github/workflows/deploy.yml`
- `.github/workflows/preview-image.yml`

## Main Deployment Flow

1. Push to `main`.
2. `.github/workflows/deploy.yml` builds and pushes `latest` and SHA tags to GHCR.
3. A node joins the mesh with `./scripts/join-watchtower-mesh.sh .env.mesh`.
4. The join script starts Caddy and Watchtower, then performs the initial blue-green deployment.
5. Subsequent zero-downtime promotions are done with `./scripts/mesh-bluegreen-deploy.sh .env.mesh`.

## Reverse Proxy

The checked-in Caddy config is in [config/caddy/Caddyfile.mesh](/home/ankursinha/Documents/GitHub/WatchTower/config/caddy/Caddyfile.mesh).

It provides:

- automatic Let's Encrypt certificates
- a stable application domain such as `app.example.com`
- optional preview-site imports from the `config/caddy/previews` directory

## Developer Experience: Join A New Node

On a new PC:

```bash
cp .env.mesh.primary.example .env.mesh
# or cp .env.mesh.standby.example .env.mesh
echo 'mongodb+srv://user:pass@cluster.mongodb.net/dbname?retryWrites=true&w=majority' | podman secret create mongo_uri -
./scripts/join-watchtower-mesh.sh .env.mesh
```

That script:

- enables `podman.socket`
- logs in to GHCR when credentials are configured
- verifies required secrets exist
- starts Caddy and Watchtower
- performs the first blue-green deployment

## Preview URL Hack

The preview workflow at [.github/workflows/preview-image.yml](/home/ankursinha/Documents/GitHub/WatchTower/.github/workflows/preview-image.yml) publishes a branch-tagged image for every non-main push.

For example, a branch named `feature/login` becomes an image tag like:

```text
ghcr.io/<owner>/<repo>:feature-login
```

You can then start a preview container on any mesh node:

```bash
./scripts/mesh-preview-deploy.sh .env.mesh feature-login
```

That creates a per-branch route such as:

```text
https://feature-login.preview.example.com
```

## Zero-Downtime Deployment Logic

`scripts/mesh-bluegreen-deploy.sh` performs these steps:

1. choose the inactive slot (`blue` or `green`)
2. pull the target image
3. start the inactive slot on its loopback port
4. wait for `HEALTHCHECK_PATH` to succeed
5. rewrite the active Caddy upstream file
6. reload Caddy
7. wait for a short grace period
8. remove the old slot

This is what provides the Vercel-style health-gated cutover.

## Multi-Node Sync

If you run the mesh on two nodes:

- both nodes can join with the same `.env.mesh` pattern
- both nodes point at the same managed database
- both nodes use the same GHCR image tags
- both nodes can promote the same release independently

For traffic failover, use Cloudflare Tunnel or Cloudflare origin health checks in front of the nodes.

## Recommended Operational Model

- Use `WATCHTOWER_POLL_INTERVAL=15` for fast infrastructure sync.
- Use `mesh-bluegreen-deploy.sh` when you want health-gated promotion.
- Use `mesh-preview-deploy.sh` for branch previews.
- Keep MongoDB credentials in Podman secrets, not in Git.

## Comparison To Hosted Vercel

| Feature | Vercel | WatchTower Mesh |
| --- | --- | --- |
| Push to deploy | Built-in | GitHub Actions + GHCR |
| Zero-downtime promotion | Built-in | Caddy + blue-green deploy script |
| Preview URLs | Built-in | Branch-tagged GHCR images + preview deploy script |
| Automatic SSL | Built-in | Caddy |
| Managed database | Add-on | MongoDB Atlas free tier |
| Hardware | Shared cloud | Your own machines |