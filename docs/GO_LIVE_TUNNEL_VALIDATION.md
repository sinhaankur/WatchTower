# Go Live — Cloudflare Tunnel: real-infra validation runbook

The Go Live tunnel path is fully unit-tested (command shapes, CF API request
bodies, arch mapping, teardown), but the **live** path — real Cloudflare API
calls + `cloudflared` installed over SSH on a real node — can only be proven
with actual credentials and a reachable host. This runbook walks that
validation in ~15 minutes.

## Prerequisites

1. **A Cloudflare account** with a zone (domain) you control, e.g. `example.com`.
2. **A scoped API token** (My Profile → API Tokens → Create Token) with:
   - `Account › Cloudflare Tunnel › Edit`
   - `Zone › DNS › Edit` (scoped to the test zone)
   - `Account › Account Settings › Read` (so credential-verify can capture `account_id`)
3. **A reachable Linux node** registered in WatchTower (Servers → add node) with:
   - SSH access from the WatchTower host (key in the node's config)
   - `sudo` without a password prompt for the deploy user (or run the connector
     install command manually when prompted)
   - `curl` available (for the cloudflared download)

## Steps

1. **Add the Cloudflare credential** — Integrations → Cloudflare → paste the
   token. Confirm the card shows an **account name** (proves `account_id` was
   captured; tunnel mode needs it).
2. **Create/import a project** and make sure at least one node is active and
   marked primary (Servers).
3. **Go Live** — open the project → Overview → Go Live card:
   - Hostname: `app.example.com` (a subdomain of your zone)
   - Public access: **Cloudflare Tunnel**
   - Credential: the one from step 1
   - Click **Go Live**.
4. **Expected per-step result:**
   - ✓ Run as container
   - ✓ Deploy latest
   - ✓ Custom domain
   - ✓ Public access (Cloudflare Tunnel) — "Tunnel '…' live → app.example.com"
   - ✓ Autonomous monitoring
   - Overall: **live**
5. **Verify on the node:** `systemctl status cloudflared` → active (running).
6. **Verify on Cloudflare:** Zero Trust → Networks → Tunnels → a tunnel named
   `wt-<project>` is Healthy; DNS shows a proxied CNAME
   `app.example.com → <tunnel-id>.cfargotunnel.com`.
7. **Verify reachability:** `curl -I https://app.example.com` returns the app
   (may take ~30s for the connector to register).
8. **Teardown check:** delete the project in WatchTower, then confirm the
   tunnel disappears from Zero Trust → Tunnels and the CNAME is gone. (Best-
   effort — a CF outage won't block the local delete, but normal path removes
   both.)

## Known good/bad signals

- **"manual" public step** = a prerequisite was missing (no credential, no
  `account_id` on the credential, or no active node). The step's detail says
  which; the rest of Go Live still applied. Re-run after fixing it.
- **connector install fails but tunnel created** = CF side is set up; SSH/sudo
  on the node failed. The step text gives the one command to finish by hand.
- **`unsupported arch`** in the build log = the node's CPU arch isn't one of
  amd64/arm64/arm/386. cloudflared doesn't ship a binary for it; install
  manually.

## What's covered by automated tests (no infra needed)

- `tests/test_cloudflare_tunnel.py` — CF tunnel API request shapes, arch
  normalisation, connector-install command + token redaction, teardown 404
  tolerance.
- `tests/test_go_live.py` — full orchestration through the real route
  (CF API + SSH install mocked): tunnel success → `overall: live`, graceful
  `manual` fallback, `tunnel_id` persisted, project-delete teardown.
