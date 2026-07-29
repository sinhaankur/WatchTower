# Serving a large static file (e.g. 41 GB PMTiles) over WatchTower + Tailscale

**Use case:** you have a big data file — here, `india-buildings.pmtiles` (~41.6 GB, all-India
building footprints) for the [India District Atlas](https://github.com/sinhaankur/india-fiscal-map) —
that is far too large for a GitHub repo (repo cap ~5 GB, Pages 1 GB, file max 100 MB). You want
to serve it from **a computer you already own**, private over your **tailnet**, for **$0/month** —
exactly what WatchTower is for.

The web app reads it via **HTTP range requests** (it fetches only the few KB of tiles in the
current view, never the whole 41 GB). So all you need on the host is a static file server that
supports **range requests + CORS**, running as a WatchTower app, reachable over Tailscale.

Key idea: **the 41 GB file lives on the host disk as a volume — never in the repo or the image.**
The container is tiny; the data is mounted in.

---

## Prereqs

- WatchTower running on the Linux box (rootless Podman), joined to your Tailscale tailnet.
- The Linux box's tailnet IP (e.g. `100.x.y.z`) — `tailscale ip -4`.
- The file on that box's disk, e.g. `/srv/pmtiles/india-buildings.pmtiles`. Get it there with:
  ```sh
  mkdir -p /srv/pmtiles && cd /srv/pmtiles
  curl -L -C - -o india-buildings.pmtiles \
    "https://data.source.coop/vida/google-microsoft-open-buildings/pmtiles/by_country/country_iso=IND/IND.pmtiles"
  ```
  (Resumable: re-run to continue. ~41.6 GB, ODbL — © Google, © Microsoft, VIDA.)

---

## Option A — Caddy static server (simplest; ranges + CORS built in)

A tiny image, the big file mounted as a **host volume** (read-only).

**`Caddyfile`:**
```
:8080 {
    root * /data
    file_server browse
    header Access-Control-Allow-Origin "*"
    header Access-Control-Allow-Methods "GET, HEAD, OPTIONS"
    header Access-Control-Allow-Headers "Range"
    header Access-Control-Expose-Headers "Content-Length, Content-Range, Accept-Ranges"
}
```

**Run it (Podman, the WatchTower way) — mount the data dir as a volume:**
```sh
podman run -d --name pmtiles-server \
  -p 8080:8080 \
  -v /srv/pmtiles:/data:ro,z \
  -v ./Caddyfile:/etc/caddy/Caddyfile:ro,z \
  docker.io/library/caddy:2
```

**Or as a WatchTower app** — deploy the `caddy:2` image with:
- **Port:** `8080`
- **Volumes:** `/srv/pmtiles → /data (ro)` and your `Caddyfile → /etc/caddy/Caddyfile (ro)`
- WatchTower keeps it running / self-heals; nothing is public until you choose.

The archive is then at: `http://<linux-tailnet-ip>:8080/india-buildings.pmtiles`

## Option B — `pmtiles serve` (purpose-built for PMTiles)

```sh
# on the Linux box, or in a minimal container with the pmtiles binary
pmtiles serve /srv/pmtiles --cors="*" --port 8080
```
Serves the tiles with ranges + CORS. Point the atlas at the URL it prints.

---

## Point the atlas at it

The atlas takes the PMTiles URL as a parameter (never hardcoded):
```
india-3d.html?buildings_pmtiles=http://<linux-tailnet-ip>:8080/india-buildings.pmtiles
```
Then: drop-to-street fly-down → **🏙 all-India buildings**. It streams from your Linux box.

- Any device **on the tailnet** (this Mac, your WebOS TV, phone) can reach `100.x.y.z:8080`
  once Tailscale is **connected** on both ends. (Common gotcha: Tailscale shows an IP but the
  service is *stopped* — run `tailscale up` / click Connect first.)

---

## HTTP vs HTTPS (the one real gotcha)

- Opening the atlas **locally** (`http://localhost/...`) → an **http** tailnet server is fine.
- Opening the atlas on the **live `https://` site (GitHub Pages)** → the browser blocks it from
  fetching an `http://` URL (mixed content). Two fixes, both WatchTower-friendly:
  - **Tailscale Serve/Funnel** gives the service an **https** name:
    `tailscale serve https / http://localhost:8080` → `https://<host>.<tailnet>.ts.net/…`
    (private to your tailnet; **Funnel** if you want it public).
  - Or put Caddy in front with a real domain (WatchTower's domain/tunnel flow) for public https.

---

## Why this fits WatchTower

- **Your hardware, $0/month** — the 41 GB lives on the Linux box's disk, served from it.
- **Rootless Podman** — the static server is a rootless container; the data is a host volume,
  so it's never baked into an image or a repo.
- **Private over Tailscale by default** — reachable only on your tailnet until you Funnel it.
- **Self-heal** — WatchTower keeps the file server up; if it dies (reboot, OOM), it restarts.

## Notes / limits

- Availability = your Linux box being **on and reachable**. Fine for personal use / demos.
  For always-on public serving without your device, mirror the file to Cloudflare R2 / Backblaze
  B2 (~$0.25–0.62/mo, free egress) — see the atlas's `BUILDINGS_SERVE.md`.
- Keep the **ODbL attribution** wherever it's served: "© Google, © Microsoft, VIDA — ODbL".
- This pattern works for **any** large static dataset, not just buildings — tiles, model
  weights, video, backups. It's a good WatchTower recipe to generalise.

*Written 2026-07-29 for the india-fiscal-map all-India buildings, verified against the live
41.6 GB ODbL source.*
