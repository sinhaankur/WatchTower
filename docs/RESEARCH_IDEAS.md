# Research → Feature Ideas

Ideas mined from published research (IEEE and adjacent), mapped onto WatchTower's
**existing** code so each one is a concrete next step rather than a blue-sky wish.
The lead theme is **peer-to-peer node connectivity** — the direction we're most
excited about — with self-healing and edge-caching as supporting threads.

> How to read this: every idea names the paper, the one-line takeaway, and the
> exact WatchTower files it would touch today. "Fit" rates how well it matches
> what we already have. Nothing here is committed; it's a menu.

---

## Where WatchTower already is (the P2P foundation)

Before the ideas, the honest baseline — WatchTower already has real P2P plumbing:

| Capability | Code today | Gap |
|---|---|---|
| Encrypted node-to-node transport | Tailscale/WireGuard, used everywhere | none — this is solid |
| Peer discovery | `watchtower/tailscale.py` (`peers()`, `online_peers()`), `api/this_pc.py` (`_discover_tailnet_peers`, `_peer_runs_watchtower`) | discovery is *on-demand*, not continuous |
| Primary/standby pairing | `api/this_pc.py` pairing endpoints + `control_plane_sync.py` | warm snapshot only; **no live failure detection, no auto-failover** |
| State sync between nodes | `control_plane_sync.py` pulls the primary's export every 5 min | pull-based, coarse (whole DB tar.gz), one-directional |
| Managed-DB replication over tailnet | `managed_db_replication.py` | separate from control-plane HA |

The recurring gap across all of these: **there is no live, decentralized view of
"which nodes are up right now."** Every feature re-derives liveness by polling. That
single gap is what the strongest research findings below address.

---

## Tier 1 — the high-fit, high-impact ideas

### 1. A SWIM-style gossip membership layer for the node mesh ⭐ best fit — ✅ SHIPPED

> **Built** in `watchtower/mesh.py` (SWIM state machine + HMAC UDP daemon over the
> tailnet), surfaced at `GET /api/this-pc/mesh` and on the Servers page's live mesh
> panel. Kill switch `WATCHTOWER_MESH_DISABLE=true`; tunables `WATCHTOWER_MESH_*`.
> The write-up below is the original rationale.


- **Paper:** Das, Gupta, Motivala, *"SWIM: Scalable Weakly-consistent Infection-style
  Process Group Membership Protocol,"* IEEE DSN 2002.
  [IEEE Xplore](https://ieeexplore.ieee.org/document/1028914/) ·
  [PDF](https://www.cs.cornell.edu/projects/Quicksilver/public_pdfs/SWIM.pdf)
- **Plus:** Dadgar et al., *"Lifeguard: Local Health Awareness for More Accurate
  Failure Detection"* (HashiCorp, extends SWIM).
  [arXiv 1707.00788](https://arxiv.org/pdf/1707.00788)
- **Takeaway:** SWIM gives every node a continuously-maintained, weakly-consistent
  view of cluster membership with **constant per-node message load regardless of
  cluster size** (heartbeat-all is O(n²); SWIM is O(1) per node per period). Two
  components: a *failure detector* (randomized direct ping → indirect ping via `k`
  random peers if the direct ping times out, so one bad link doesn't cause a false
  death) and a *dissemination* component that **piggybacks membership deltas onto the
  ping/ack messages themselves** — no separate multicast. The self-healing bit is the
  **suspect state**: `alive → suspect → confirmed-dead`, where a suspected node gets a
  gossip-broadcast window to refute before eviction. Lifeguard adds "maybe *I'm* the
  slow one" local-health awareness and cut false positives **50×** in production
  (Consul/Serf/Nomad all ship this via `memberlist`).
- **Why it fits WatchTower:** we already have the peer list (`tailscale.py`) and the
  encrypted transport (tailnet). What's missing is exactly SWIM's output: a live
  membership view. This turns "poll the primary every 5 min" into "know within
  seconds that a node went down, with almost no false alarms."
- **Where it lands:**
  - New `watchtower/mesh.py` — a lightweight SWIM loop (UDP or HTTP-over-tailnet)
    seeded from `tailscale.online_peers()`. Start with `T`≈1s protocol period,
    `k`≈3 indirect probes (SWIM's own suggested small constants).
  - Reuse the scheduler pattern already in `control_plane_sync.py:start_scheduler()`.
  - Surface membership on `api/this_pc.py` (`GET /api/this-pc/mesh` → live node
    up/suspect/down list) and render it on the Servers/HA page.
  - Feed the `confirmed-dead` event straight into the HA pairing so **auto-failover**
    (Tier-1 idea #2) finally has a trustworthy trigger.
- **Fit:** ★★★★★ · **Effort:** medium (the protocol is small; `memberlist`'s Go
  source is a proven reference to port the state machine from).

### 2. Auto-failover driven by the membership signal — ✅ SHIPPED

> **Built** in `watchtower/failover.py`: on a confirmed primary death the mesh fires
> `on_dead`, and a standby with the toggle on self-promotes (with a quorum/partition
> guard against split-brain). Toggle `PUT /api/this-pc/control-plane/failover`
> (default OFF); env `WATCHTOWER_AUTO_FAILOVER`, solo override
> `WATCHTOWER_FAILOVER_ALLOW_SOLO`. `ha.failover` audit event + org notification.
> No live DB hot-swap — the warm snapshot is staged, consistent with the existing
> restore-while-stopped safety stance.


- **Paper:** Bessani et al., *"Semias: Self-Healing Active Replication on Top of a
  Structured Peer-to-Peer Overlay,"* IEEE.
  [IEEE Xplore](https://ieeexplore.ieee.org/document/5623396/)
- **Takeaway:** "self-healing" for a replica group = automatically reconfigure the
  group (promote a new primary, re-point followers) when the overlay detects a
  node arrival/failure/departure — *carefully*, to keep replicas consistent.
- **Why it fits:** `control_plane_sync.py` already keeps a warm standby snapshot; its
  own docstring calls out the honest gap — *"does NOT do automatic failover."* SWIM's
  `confirmed-dead` event (idea #1) is the missing trustworthy trigger. Promotion logic
  is small once liveness is reliable.
- **Where it lands:** extend the standby role in `control_plane_sync.py` — on a
  confirmed primary-death event, restore the latest snapshot and self-promote to
  primary; guard with a quorum/"is the primary *really* gone or just partitioned
  from me" check (SWIM's indirect-probe result answers this). Record `ha.failover`
  in the audit log.
- **Fit:** ★★★★☆ · **Effort:** medium, **blocked on #1**.

### 3. Push-based, gossip-disseminated state sync (replace 5-min polling) — ✅ SHIPPED

> **Built** as gossip-*triggered* sync (the pragmatic, safe form): the primary
> advertises a monotonic ``state_version`` (derived from audit-row count +
> latest system_settings mtime — no new column) on every mesh datagram; when a
> standby sees its paired primary's version advance, it pulls the existing
> tar.gz export **immediately** (debounced) instead of waiting up to 5 min. The
> timed pull stays as the fallback/reseed. `control_plane_sync.on_primary_version`
> + `mesh` version carrier. Latency: minutes → seconds, zero new partial-restore
> risk (transport is the proven full export). True row-level deltas were
> deliberately NOT built — too large/risky against the restore-while-stopped
> stance; see the original note below.


- **Papers:** Kermarrec & van Steen, *"Gossip-Based Networking for Internet-Scale
  Distributed Systems"* ([Springer](https://link.springer.com/chapter/10.1007/978-3-642-20862-1_18)) ·
  the gossip-failure-detection line generally.
- **Takeaway:** epidemic/gossip dissemination is self-healing, self-organizing, and
  scales logarithmically — updates spread by piggybacking, no central broker.
- **Why it fits:** `control_plane_sync.py` pulls the **entire** DB tar.gz every 5 min.
  That's fine as a fallback but heavy and stale. Once a mesh (#1) exists, config/state
  *deltas* can ride the gossip channel so standbys converge in seconds, with the full
  export kept only as periodic reseed.
- **Where it lands:** evolve `control_plane_sync.py` from pull-only to
  gossip-push-with-pull-fallback; the pull path stays as the reseed/cold-start road.
- **Fit:** ★★★★☆ · **Effort:** medium-high, **best after #1**.

---

## Tier 2 — validates our architecture / smaller wins

### 4. Full-mesh WireGuard control-plane pattern (we already chose right)

- **Paper:** Kjorveziroski et al., *"Full-mesh VPN performance evaluation for a secure
  edge-cloud continuum,"* *Software: Practice and Experience*, 2024.
  [Wiley](https://onlinelibrary.wiley.com/doi/full/10.1002/spe.3329)
- **Takeaway:** a **centralized control plane that only ever sees public keys +
  endpoints** (never private keys) can automate full-mesh WireGuard, avoiding the
  hub-and-spoke performance penalty, "well suited for geographically distributed
  infrastructure." A 2026 analysis makes the same point about Tailscale/Headscale:
  the *data plane stays peer-to-peer WireGuard*; only coordination is centralized.
- **Why it matters:** this is **exactly** Tailscale, which WatchTower already builds
  on. The research is external validation that our transport choice is the right one —
  useful for the README/marketing "why Tailscale" story, and a nudge that supporting
  **self-hosted Headscale** would let privacy-max users drop the last SaaS dependency
  while keeping the same code paths in `tailscale.py`.
- **Action:** small — document the "bring-your-own-coordination-server (Headscale)"
  option; verify `tailscale.py`'s `tailscale` CLI calls work unchanged against it.
- **Fit:** ★★★☆☆ (mostly confirms) · **Effort:** low.

### 5. NAT-traversal honesty for nodes without public IPs

- **Source:** the FogBus2/K3s + WireGuard edge work
  ([arXiv 2203.05161](https://arxiv.org/pdf/2203.05161)) and full-mesh WireGuard
  practice: *"for a connection to work, at least one machine in each pair must be
  publicly reachable; it fails if both are behind NAT"* — which is why edge designs
  put a public-IP node in the mesh alongside NAT'd ones.
- **Why it fits:** WatchTower's "your own PC" pitch means **most nodes are behind
  NAT**. Tailscale already does DERP relay + NAT hole-punching for us, so we're
  covered — but the diagnostics (`api/diagnose.py`) should *say so* clearly and warn
  when a would-be primary is only reachable via relay (higher latency for failover).
- **Action:** add a mesh-reachability check to `api/diagnose.py` (direct vs
  DERP-relayed peer), surfaced in system-readiness.
- **Fit:** ★★★☆☆ · **Effort:** low.

### 6. Decentralized, application-centric orchestration (longer horizon)

- **Papers:** *"Towards a decentralised application-centric orchestration framework in
  the cloud-edge continuum,"* IEEE ICFEC 2025 · *"Swarmchestrate,"* Springer 2024 ·
  Pires et al., *"Caravela: volunteer edge container orchestration"* using standard
  Docker containers, no centralized cluster.
- **Takeaway:** container placement decided **across peers without a central
  scheduler** — each node advertises capacity, work is matched P2P.
- **Why it fits (later):** WatchTower deploys to nodes over SSH from a control plane
  today (`builder.py`, `api/deployments.py`). A future "deploy to whichever mesh node
  has capacity" scheduler is the natural evolution once the mesh (#1) can carry
  per-node capacity in its gossip payload (SWIM already piggybacks arbitrary metadata).
- **Fit:** ★★☆☆☆ (vision) · **Effort:** high; depends on #1.

---

## Supporting thread — edge caching / CDN (the other roadmap item)

IEEE edge-caching research is mostly ML-driven *placement* theory (federated-learning
cache decisions, popularity prediction) — overkill for a single-home/small-fleet tool.
The **practical** layering is what maps to WatchTower:

- **Papers (for completeness):** *"Coordinated Edge-Caching for Content Delivery in
  Future Internet Architecture,"* IEEE
  ([Xplore](https://ieeexplore.ieee.org/document/8254484/)) ·
  *"Content-Aware Caching at the Mobile Edge Network Using Federated Learning,"* IEEE
  ([Xplore](https://ieeexplore.ieee.org/document/10542512/)).
- **What we'd actually build:** cache-control headers on static assets in the SPA/
  deploy path + an optional NGINX `proxy_cache` reverse-proxy layer in front of a
  deployed site, and (already on our Cloudflare integration road) let Cloudflare's CDN
  cache assets in front of the tunnel. Key practical concerns from the practitioner
  literature: **TTL with jitter** (avoid synchronized expiry), **versioned/ETag cache
  keys** for clean invalidation, and **stale-while-revalidate** to dodge cache
  stampedes.
- **Where it lands:** `watchtower/cloudflare*` for the CDN toggle; a cache-header pass
  in the deploy artifact step (`builder.py`). Tracked in the README roadmap.
- **Fit:** ★★★☆☆ · **Effort:** medium.

---

## Suggested sequence

The dependency chain is clean and all P2P-first:

```
#1 SWIM mesh (live membership)  ─┬─▶  #2 auto-failover
     └ validated by #4, #5       ├─▶  #3 gossip state sync
                                 └─▶  #6 decentralized placement (later)

edge-caching / CDN — parallel track, independent of the mesh
```

**#1 (the SWIM-style mesh) is the keystone.** It's self-contained, high-impact, ports
from a battle-tested reference (`memberlist`), and unlocks #2/#3/#6. If we build one
thing from this list, it's #1.

---

*Sources are linked inline. Papers behind IEEE Xplore paywalls are cited by title +
DOI; summaries here are drawn from abstracts and open-access companion PDFs, not
paywalled full text.*
