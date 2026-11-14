# Owning the stack: can WatchTower be "its own Tailscale and Podman"?

> Decision doc, 2026-11-14. Question raised: *"Can we be Tailscale and Podman
> ourselves?"* Short answer: **containers — bundle, don't rebuild; networking —
> keep Tailscale as default but add a self-hosted mesh provider behind our
> abstraction so users *can* run zero-dependency.** Reasoning below.

## Why this question matters

WatchTower's pitch is "a personal cloud on hardware you already own, $0/month,
nothing phones home." Two load-bearing dependencies make it work — **Tailscale**
(private networking) and **Podman/Docker** (containers). The user's instinct:
*without these two it's weak* ([[watchtower-is-a-layer-not-the-dep]]). The real
risk isn't *depending* on them — it's *lock-in* and *install friction*. So the
goal is **independence and zero-install, not reinvention for its own sake.**

---

## Containers — DECISION: bundle the engine, don't rebuild

### Where we already are
- **Runtime-agnostic**: `WATCHTOWER_CONTAINER_RUNTIME` selects Podman (rootless
  default) or Docker ([[container-runtime-agnostic]]). The abstraction exists.
- Today we **guide** installation (`apt install podman`, `brew install podman`
  in `api/runtime.py`) — the user still installs it themselves.

### Why NOT build our own OCI runtime
Containers are an **open standard** (OCI image + runtime specs). The hard parts —
image pull/unpack, overlayfs layering, cgroups v2, rootless user-namespace
mapping, CNI networking, seccomp — are *years* of hardened work in `runc`/`crun`
+ `containerd`/Podman. Reimplementing them would be rebuilding open plumbing to
own plumbing. No strategic payoff; large ongoing security-maintenance burden.

### What "own it" actually means here: **zero-install bundling**
The win the user wants ("runs on a PC you already own") is that the engine is
*already there* — not a second thing to install. Options, in order of effort:
1. **Auto-install on first run** (shortest path): extend the existing tool-install
   flow to actually fetch + install Podman/crun non-interactively per-OS, instead
   of just printing the command. Low risk, big UX win.
2. **Bundle a static `crun` + minimal `containerd`** in the desktop app for the
   deploy path, falling back to system Podman/Docker if present. Heavier; revisit
   only if first-run install proves unreliable.

**Action:** pursue (1); keep the runtime abstraction as the seam. Do NOT build an
OCI runtime. (Caveat: managed-DB *pods* are Podman-only — Docker has no pods —
so the pod features stay gated to Podman regardless; see [[podman-manager]].)

---

## Networking — DECISION: default Tailscale, add a self-hosted mesh *provider*

This is the subtle one, because "be our own Tailscale" can quietly destroy the
trust pillar.

### Where we already are (more than expected)
- **`watchtower/tailscale.py`** is a small, clean seam: `local_ip()`, `peers()`,
  `online_peers()` — all shelling to the `tailscale` CLI. Easy to put behind an
  interface.
- **`watchtower/mesh.py` is already OUR OWN transport**: SWIM-style gossip over
  **UDP datagrams authenticated with HMAC-SHA256**, for node membership +
  auto-failover ([[mesh-swim-shipped]]). It currently *rides on* Tailscale IPs
  (the tailnet provides the WireGuard encryption), but the membership/coordination
  logic is ours.
- **`cloud_providers.py`** proves we already do clean pluggable providers (a
  `Protocol` + a `_PROVIDERS` registry for DigitalOcean/Hetzner). Same pattern
  applies to networking.
- The Remote Access page was *designed* provider-agnostic ([[remote-access-feature]]).

### What Tailscale actually gives us (the hard parts)
1. **WireGuard transport** — open, in-kernel, free. Not the hard part.
2. **Coordination server** — key exchange, ACLs, device identity. **Open-source
   reimplementation exists: [Headscale](https://github.com/juanfont/headscale).**
3. **NAT traversal + DERP relays** — getting two peers connected when both are
   behind NAT. **This is the genuinely hard, operationally expensive part.**
4. **MagicDNS, exit nodes, SSO** — convenience layers.

### The three paths
| Path | What it costs | Trust-promise impact |
|---|---|---|
| **A. Keep Tailscale (today)** | Nothing new | Honest "layer on top" dependency |
| **B. Self-hosted mesh *provider*** (Headscale + WireGuard, behind our abstraction) | Build the provider; user runs a Headscale coordinator (or we embed one) | **Preserves $0/no-phone-home** *if* peers can connect directly; NAT'd peers still need a relay |
| **C. Fully replace Tailscale** | We operate DERP relays + coordination infra + key rotation 24/7 | **BREAKS "$0/month, nothing phones home"** — now *we* run always-on infra NAT'd users depend on |

**Path C is the trap.** The moment NAT'd users need a relay *we* operate, we've
become a SaaS with uptime obligations and a phone-home — the opposite of the
product's promise. Avoid unless the model changes.

### DECISION: Path B, behind the existing provider abstraction
Add **"Self-hosted mesh (Headscale + WireGuard)"** as a Remote Access *provider*
alongside Tailscale (default), Cloudflare Tunnel, and SSH. We own the
**interface** and the **membership layer** (`mesh.py`); the user picks their
tradeoff:
- **Tailscale** → easiest, just works, depends on Tailscale Inc.
- **Self-hosted mesh** → zero third-party dependency; works great on a LAN /
  same-tailnet; NAT traversal is best-effort (document honestly — direct
  connections + our relay only if the user runs one).

This is consistent with everything we've already built: provider registry
pattern (`cloud_providers.py`), our own authenticated gossip (`mesh.py`), and the
"WatchTower is the layer on top" framing.

### Proposed design sketch (when built)
- `watchtower/net/` package with a `NetworkProvider` Protocol:
  `local_ip()`, `peers()`, `up(config)`, `status()`.
- `TailscaleProvider` (wrap today's `tailscale.py`), `HeadscaleProvider`
  (coordinator URL + WireGuard key mgmt), later `CloudflareProvider`.
- `mesh.py` stays transport-agnostic — it already just needs peer IPs + a shared
  HMAC key; feed it from whichever provider is active.
- Remote Access page lists providers (the UI already renders provider cards).

---

## Recommended sequence
1. **Containers**: wire real first-run auto-install of the runtime (finish the
   tool-install flow). Low risk, immediate zero-install win.
2. **Networking**: extract the `NetworkProvider` interface around `tailscale.py`
   (pure refactor, no behavior change) — cheap, and it de-risks everything after.
3. **Networking**: prototype `HeadscaleProvider` as an opt-in provider; keep
   Tailscale default. Measure NAT-traversal reality before promising it.
4. Revisit bundling a static `crun` only if first-run install proves flaky.

**Do not** build an OCI runtime or operate DERP relays. Own the *abstractions*
and the *coordination logic* (we already do) — not the hardened plumbing or the
always-on infra.

---

## Concepts to think on (not decided — parked for design)

### P2P networking — we have prior art
The maintainer built a peer-to-peer system as a college project that became an
**IEEE paper but was never productized.** That's directly relevant: WatchTower's
`mesh.py` is already an authenticated P2P membership layer (SWIM gossip, HMAC).
The IEEE work is worth revisiting as source material for:
- **Decentralized deploy placement** — the next step the README roadmap already
  names ("decentralized deploy placement over the same fabric"). Which node runs
  what, decided by the mesh rather than a central scheduler.
- **P2P content distribution** — relevant to the Files/Photos pillar: replicate
  blobs peer-to-peer across your own devices (content-addressed, dedup'd) instead
  of a hub-and-spoke copy. The SHA-256 vault already content-addresses; a P2P
  distribution layer on top is a natural fit.
- **NAT traversal lessons** — if the paper tackled hole-punching / relay
  election, that's exactly the hard part of the self-hosted-mesh networking
  provider (Path B above). Reusing proven ideas de-risks it.

**Action:** dig out the paper; extract the membership/placement/NAT algorithms;
map them onto `mesh.py` + the Files/Photos replication design. Capture as its own
research note before committing to a build.

### Zero-install as the real "own it"
The through-line of both decisions above: users shouldn't *install* Tailscale or
Podman separately — the appliance should bring (or trivially set up) what it
needs. The Podman **detect-and-set-up** flow shipped 2026-11-14
(`ensure_machine()` / `/api/podman/machine/setup`: if no machine exists, init it;
if stopped, start it) is the first concrete step. The networking equivalent —
first-run mesh bring-up — is the parallel to design.

*Related: [[platform-evolution-four-pillars]] (this is the "reach everywhere"
pillar's foundation), [[container-runtime-agnostic]], [[mesh-swim-shipped]],
[[p2p-mesh-research]].*
