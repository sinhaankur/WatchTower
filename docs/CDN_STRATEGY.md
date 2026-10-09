# CDN Strategy for WatchTower

**Status:** research + implemented baseline (2026-09-26)
**Scope:** how a CDN fits WatchTower's two very different asset surfaces —
the control-plane SPA, and user-deployed sites/apps.

---

## 0. TL;DR

WatchTower has **two** things a CDN could sit in front of, and they need
opposite treatment:

| Surface | What it is | CDN posture |
|---|---|---|
| **Control-plane SPA** (`web/dist`, served by `watchtower.api`) | The dashboard the operator uses | Cache hashed `/assets` forever, never cache `index.html` or `/api/*` |
| **User-deployed sites** (projects deployed to nodes) | The websites/apps a user ships *through* WatchTower | This is where a CDN is a **product feature**, wired through the existing Cloudflare integration |

The single most important thing for **both** is the cache-header contract,
which is now enforced in `watchtower/api/__init__.py` and tested in
`tests/test_spa_security_headers.py::test_hashed_assets_are_immutable`.

---

## 1. Why a CDN even applies to WatchTower

WatchTower's product vision is "turn a computer you already own into your
personal cloud" (see the product-vision memory). That computer is typically:

- on a **home/residential connection** with limited upstream bandwidth,
- **single-homed** (one geography), and
- **sometimes offline** (laptop closes, power blips).

A CDN in front of a user's deployed site directly attacks all three:

1. **Bandwidth** — the origin (the user's PC) serves each asset once; the
   edge serves it a million times. A home uplink can't do the latter.
2. **Latency / geography** — the edge terminates TLS close to the visitor;
   the user's single box can't be in 300 cities.
3. **Availability** — with "always online"/edge caching, a cached page can
   still serve while the origin box is briefly down. This dovetails with the
   self-heal story: the CDN masks the blip the healer is fixing.

So a CDN isn't a nice-to-have bolt-on — it's what makes "host from your own
PC" actually viable for a real audience. It belongs on the roadmap next to
the Cloudflare tunnel work already in `watchtower/api/cloudflare.py`.

---

## 2. Surface A — the control-plane SPA (done)

### The cache tri-state

The FastAPI process serves the SPA. Three classes of response, three
policies (all enforced in `watchtower/api/__init__.py`):

| Path | Header | Rationale |
|---|---|---|
| `/assets/*` (JS/CSS, content-hashed by Vite) | `public, max-age=31536000, immutable` | Filename changes when bytes change, so the URL is a permanent ID. `immutable` skips even the revalidation 304. |
| `/` and SPA-route fallbacks (`index.html`) | `no-cache, no-store, must-revalidate` | `index.html` is the *only* unhashed file; it points at the current hashed bundles. Must never be stale or a deploy would keep loading deleted JS. |
| `/favicon.ico`, root public files | `public, max-age=900` | Content-stable but unhashed — short TTL so they refresh across deploys. |

This is the canonical "hashed assets immutable, HTML never cached" pattern
that every SPA CDN guide recommends. It was **the gap this work closed**:
`StaticFiles` previously emitted only `Last-Modified`/`ETag` on `/assets`,
so browsers sent a 304 revalidation request *per chunk* on every reload
(~30 chunks → 30 round-trips). Now: zero round-trips for return visitors,
and a CDN can cache the bundle at the edge indefinitely.

Implementation: `_ImmutableStaticFiles` subclass overriding `file_response`
to stamp `Cache-Control`. See the class docstring for the full reasoning.

### Putting a CDN in front of the control plane (optional)

Most operators reach the dashboard over the LAN or a Tailscale tunnel, so
edge-caching the control plane is usually pointless. But if someone exposes
the dashboard publicly (Cloudflare tunnel), the header contract above means
a CDN "just works" with zero config:

- `/assets/*` → cached at edge for a year (the `immutable` directive).
- `/` + `/api/*` → the `no-cache` / dynamic headers keep them uncached.

**Do NOT** enable a blanket "cache everything" CDN rule — it would cache
`/api/*` responses and serve one user's data to another. The header
contract is the guardrail; the CDN must be configured to *honour origin
cache headers*, not override them.

---

## 3. Surface B — user-deployed sites (the product feature)

This is where CDN becomes a WatchTower feature, not just an ops detail.

### 3.1 Where it plugs in

The existing integration (`watchtower/api/cloudflare.py` +
`watchtower/cloudflare_dns.py`) already:

- stores a verified Cloudflare API token per org (Fernet-encrypted),
- syncs an **A record** for a project's custom domain to the user's box.

It does **not** yet touch CDN/cache behaviour. The CDN feature is the
natural next layer on the same credential:

```
existing:  domain → [DNS A record] → user's box (origin)
add:       domain → [DNS, proxied ✅] → Cloudflare edge (CDN) → user's box
```

The one-line difference in Cloudflare terms: set the DNS record's
`proxied: true` flag (the "orange cloud"). That alone routes traffic
through Cloudflare's CDN + TLS termination + DDoS protection, for free,
on the free plan. `cloudflare_dns.sync_a_record` currently creates the
record; exposing a `proxied` toggle is the minimal first step.

### 3.2 What "wire up the CDN" concretely means

Incremental, each independently shippable:

1. **Proxy toggle (smallest, highest value).** Add `proxied: bool` to the
   DNS sync path. Default **on** for user sites (that's the whole point),
   off for anything that must be a direct connection (e.g. SSH/game
   servers). This flips on Cloudflare's CDN with no other work.

2. **Cache purge on deploy.** When a deployment succeeds, the old cached
   assets at the edge are stale. Call Cloudflare's
   `POST /zones/{zone}/purge_cache` (purge-everything, or by-URL for
   surgical purges) as a post-deploy hook in `builder.py`. Without this,
   a user deploys a fix and visitors keep seeing the old page until the
   TTL expires — the #1 "CDN makes things not work as expected" complaint.
   **This is the single most important CDN correctness step.**

3. **Sane cache rules for user origins.** WatchTower can't assume a user's
   framework sets good cache headers (many don't). Two options, in order:
   - *Preferred:* teach the reverse proxy WatchTower already puts in front
     of user containers (nginx, per the autonomous-global-deploy vision) to
     emit the same hashed-immutable / HTML-no-cache contract from §2.
   - *Fallback:* set a Cloudflare Cache Rule via API so the edge does the
     right thing even when the origin is silent.

4. **Cache analytics surface.** Cloudflare's analytics API returns
   cache-hit ratio, bandwidth saved, requests offloaded. Surfacing "your
   CDN served 94% of requests, saving 12 GB off your home connection" is a
   concrete, motivating metric that reinforces the product's core promise.

### 3.3 Provider-agnostic shape

Cloudflare is the default (already integrated, free tier is generous,
tunnel story is best-in-class). But mirror the pattern used elsewhere in
the codebase (LLM providers, remote-access providers per the memories):
a thin `CdnProvider` seam so Fastly / Bunny / CloudFront can slot in later
without touching callers. v0 = Cloudflare only; don't over-abstract before
the second provider is real.

---

## 4. Failure modes a CDN introduces (the "doesn't work as expected" trap)

A CDN is a **cache**, and caches lie for a living. The predictable ways it
bites, each with the mitigation WatchTower should own so users never hit it:

| Symptom | Cause | Mitigation |
|---|---|---|
| "I deployed a fix but the site is unchanged" | Edge still serving old cached HTML/asset | **Auto-purge on deploy** (§3.2.2). Non-negotiable. |
| "Users see each other's data" / "logged in as someone else" | CDN cached a dynamic/authenticated response | Never cache `/api/*` or anything with `Set-Cookie`/`Authorization`. Honour origin `no-cache`. |
| "My redirect loop / infinite HTTPS" | CF "Flexible SSL" + origin also redirects to HTTPS | Use **Full (strict)** SSL mode when the origin has a real cert (Tunnel gives you one); document it. |
| "WebSocket / SSE broken" | Proxied WS not enabled, or buffering | CF proxies WS by default, but SSE (`/api/agent/chat`) needs `no-cache` + no buffering — verify with the proxied dashboard. |
| "Real visitor IP is always Cloudflare's" | Origin sees edge IP, not client | Read `CF-Connecting-IP`; the audit-log client-IP capture (`audit.py`) must trust that header **only** when behind CF. |
| "Large uploads fail at 100 MB" | CF free-tier request-body limit | Route uploads (photos, DB backups) direct-to-origin or via a non-proxied subdomain; document the limit. |

The row that matters most for WatchTower's audience is the first one:
**stale-after-deploy**. Autonomy + self-heal means the system deploys on
its own; if the CDN then serves a stale page, the user's mental model
("WatchTower fixed it") breaks. Auto-purge closes that loop.

---

### 2.1 Readiness vs liveness (for a CDN / LB in front)

A CDN or load balancer fronting the control plane should health-check
`/ready`, not `/health`:

- `GET /health` — **liveness**. Shallow, dependency-free, always 200 while
  the process can answer. An orchestrator uses this to decide whether to
  *restart* the process. Deliberately does **not** touch the DB, so a brief
  DB blip doesn't trigger a restart-loop of an otherwise-fine process. The
  Docker `HEALTHCHECK` and CI smoke test key off this + the `watchtower-api`
  marker — don't change that contract.
- `GET /ready` — **readiness**. Runs a cheap `SELECT 1`; returns 503
  `not_ready` if the DB is unreachable. A load balancer / k8s readiness gate
  routes traffic here so a pod with a dead DB connection is pulled from
  rotation instead of serving 500s. The container `HEALTHCHECK` now uses
  `/ready` (see `Dockerfile` + `docker-compose.app.yml`).

## 5. Interaction with the desktop app + build pipeline

- The **desktop app** serves the SPA locally (`WATCHTOWER_WEB_DIST` →
  bundled `web/dist`). No CDN involved; the immutable headers still help
  (zero revalidation on the loopback). No build-pipeline change needed —
  the same `web/dist` is baked into the Docker image and the AppImage.
- The **two-stage updater** payload (`scripts/build-payload.sh`) ships the
  SPA to desktops out-of-band. That path is signed + arch-independent and
  is unrelated to CDN; don't conflate them.
- **Docker image**: `web/dist` is baked in at build time (multi-stage
  `web-builder`). If a reverse proxy / CDN fronts the container in
  production, it inherits the §2 header contract for free.

---

## 6. Recommended order of work

1. ✅ **Immutable asset headers on the control-plane SPA** — done, tested.
2. ✅ **`proxied` toggle** on Cloudflare DNS sync (§3.2.1) — the sync
   endpoint accepts + persists `cloudflare_proxied`; the Domains tab UI
   defaults it on and shows CDN state. Post-deploy auto-DNS now honours the
   persisted flag (was hardcoded off, which flipped users back to grey-cloud
   on every deploy).
3. ✅ **Auto-purge on successful deploy** (§3.2.2) — `cloudflare_dns.purge_cache`
   + a hook in `builder._sync_dns_for_project` that purges the edge cache for
   every proxied domain after a successful deploy (best-effort, never fails
   the deploy). A manual `POST .../purge-cache` endpoint + a "Purge cache"
   button back it up. This is the correctness keystone.
4. ✅ **`CF-Connecting-IP` awareness** — `rate_limit.client_ip()` (shared by
   the audit log + rate limiter) prefers `CF-Connecting-IP` →
   `X-Forwarded-For` → socket peer, gated on `WATCHTOWER_TRUST_FORWARDED_FOR`
   so the headers aren't spoofable when WatchTower is directly exposed (§4).
5. ✅ **Origin cache rules** via the fronting nginx (§3.2.3) —
   `_build_nginx_proxy_config` now emits two extra `location` blocks: hashed
   assets (`.<hash>.{js,css,woff2,…}`) → `immutable, max-age=1yr`; HTML →
   `no-cache`. `proxy_hide_header Cache-Control` makes ours authoritative over
   whatever the user's app sends (or doesn't). So the edge caches correctly
   even for a framework that sets no cache headers. Validated by a real
   `nginx -t` test (which caught a `{8,}`-quantifier parser bug — location
   regexes with braces must be single-quoted).
6. ✅ **Cache analytics** — `cloudflare_dns.zone_analytics()` queries the
   GraphQL Analytics API (`httpRequests1dGroups`), summing cached-vs-total
   requests + bytes over N days. `GET .../analytics` exposes cache-hit ratio
   + **bytes served off the origin uplink** (the payoff metric). The Domains
   tab shows a "CDN stats" panel: "served from edge %", "off your uplink" (GB),
   and request count. Friendly zero-state for DNS-only / no-traffic-yet.

**The CDN roadmap is fully shipped (steps 1–6).** Steps 2–4 shipped together
(the CDN without auto-purge is a net-negative UX); analytics (6) and origin
cache rules (5) followed. Future work is optional polish: provider-agnostic
seam for a second CDN (§3.3), by-URL surgical purge instead of full-zone.
