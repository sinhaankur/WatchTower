# WatchTower Roadmap

> **The shift.** WatchTower began as two narrow tools: a *container auto-updater*
> (the "Watchtower classic" idea) and a *Podman-first deploy* helper. It is now
> becoming something bigger: **a personal-cloud platform for the computers and
> devices you already own** — deploy, databases, a device fleet, and your files
> and photos, all private over your own network, self-healing, for $0/month.
>
> This doc is the canonical index. Two deep-dives already exist and stay
> authoritative for their areas:
> - [WATCHTOWER_PLATFORM_ROADMAP.md](WATCHTOWER_PLATFORM_ROADMAP.md) — the deploy
>   platform (Netlify/Vercel/Coolify-class), schema, build system, SaaS mode.
> - [EASY_HOME_HOSTING_ROADMAP.md](EASY_HOME_HOSTING_ROADMAP.md) — home-hosting
>   UX, node registration, mesh networking.
> - [RESEARCH_IDEAS.md](RESEARCH_IDEAS.md) — the P2P/mesh/self-heal research that
>   fed the shipped SWIM mesh + auto-failover.

---

## The four pillars

| Pillar | What it is | Status |
|---|---|---|
| **1. Deploy** | Git push → live site on your own hardware, self-healing | ✅ Shipped, maturing |
| **2. Devices / Fleet** | Every device you connect becomes one manageable fleet | 🟡 Bones shipped, needs unifying |
| **3. Files & Photos** | Private Dropbox/Google-Photos on your hardware | 🟡 Photo vault backend exists, no UI; Files not started |
| **4. Reach everywhere** | Runs on anything from a Pi to a workstation; private via Tailscale | 🟡 arm64 ships; Pi not surfaced; 512MB target unverified-but-feasible |

---

## Pillar 2 — "When you connect, it's for ALL your devices"

The insight: connecting a device shouldn't manage one box at a time — the whole
**tailnet becomes one fleet**. This is closer than it looks; the pieces exist and
need to be *unified into one fleet view*, not built from scratch.

**Already shipped (reuse, don't rebuild):**
- `GET /api/this-pc/discover-nodes` — lists every tailnet peer, flags which run
  WatchTower (`watchtower/api/this_pc.py`).
- Managed devices — pair + operate another box from one console
  (`watchtower/api/managed_devices.py`: list, view, action).
- SWIM gossip mesh — live membership + auto-failover across nodes
  (see [[mesh_swim_shipped]] / RESEARCH_IDEAS tier 1).
- The menubar widget already surfaces "Network Devices".

**To build:**
- **Fleet dashboard** — one screen: every device, its role (deploy target / DB
  host / storage node / photo node), health, and resource footprint.
- **Fleet-wide actions** — deploy/restart/update across selected devices;
  storage/photo replication targets chosen from the fleet.
- **Capability tags per node** — a Pi might be "storage + photos only", a
  workstation "build + deploy". Drives where work is scheduled.

## Pillar 3 — Files & Photos (private cloud storage)

### 3a. Photos — extend what exists
A real per-user photo vault already ships (`watchtower/api/photos.py` +
`photo_backups.py`): device registration with push tokens, authenticated
ingest, list/download/delete/stats, **SHA-256 content dedup** keyed on
`(user_id, sha256)`, path-traversal-guarded on-disk vault. **It has no web UI
and is not in the nav yet** — that's the first, highest-value build.

**Build order:**
1. **Photos web UI** — gallery (grid + date grouping via `captured_at`), upload
   from browser, device management (the token-mint flow already exists), vault
   stats. Wire into nav + `RequireAuth`.
2. **Companion mobile push** — the ingest endpoint is designed for a phone app
   pushing new photos. (Native app = separate project.)

### 3b. Google Photos / Apple Photos sync — the hard truth (verified)
The `photos.py` docstring already records the constraint, and it's real:
- **Apple**: exposes **no API** to read a user's existing iCloud photo library.
- **Google Photos (post-2025)**: API restricted to **app-created / user-picked**
  media only — you **cannot** bulk-read someone's existing library.

So "mirror my whole Google/Apple library automatically" is **not possible via
official APIs.** Honest paths that actually work:
- **Device-push** (the current design) — the companion app uploads new photos as
  they're taken. This is the primary, reliable source.
- **Google Takeout import** — user-initiated export → one-time bulk import. Works
  for "bring my history over once."
- **Google Picker / share-sheet** — user explicitly picks items to send. Opt-in,
  per-item.

**"Make sure nothing is duplicated" across sources** — SHA-256 dedup already
handles *identical bytes*. But the same photo from phone-push vs Takeout vs a
re-encode will have **different bytes** → needs a second layer:
- **Perceptual hashing (pHash/dHash)** + capture-timestamp + dimensions to catch
  near-duplicates (re-compressed, resized, Live-Photo variants). New work; the
  `source` column already exists to track provenance per copy.

### 3c. Files — new pillar (self-hosted Dropbox)
Not started. Natural sibling to Photos, reusing the same vault/dedup/storage
seam (`photo_backups.py` generalizes to a content-addressed blob store):
- Upload/download/browse, folders, sharing links (private over Tailscale first).
- Sync client (desktop folder ↔ vault) is a later, bigger piece.

### 3d. Multi-Gmail / federated cloud storage backends
The idea: let a user **attach multiple Gmail/Google Drive accounts** (and other
providers) as *storage backends*, pooling their free/cheap quota behind
WatchTower's vault. Feasible and genuinely differentiating, with caveats:
- **Legit path**: Google Drive API with per-account OAuth; WatchTower becomes a
  storage *orchestrator* that spreads content-addressed blobs across attached
  backends, tracking which blob lives where. (Not a ToS workaround — each account
  is the user's own, used within its own quota.)
- **Design**: a pluggable `StorageBackend` interface (local vault = default;
  Drive/S3/B2 = adapters), with the DB tracking blob→backend placement. Dedup
  stays global (hash first, then place). Encrypt-at-rest before upload so a
  cloud backend never sees plaintext.
- **Honesty**: this is a multi-week backend project; sequence it after local
  Files + Photos UI prove the vault model.

## Pillar 4 — Raspberry Pi & small devices (phased)

**Verified footprint (this hardware, Nov 2026):** control plane imports at
~97 MB peak and idles at ~45 MB RSS, with the heavy optionals
(openai/redis/rq/fabric) *not* loaded in the core path. That makes an
**aggressive 512 MB headless target realistic** — but it must be *measured on a
Pi*, not promised from a Mac reading.

**Phase 1 — Pi-as-cloud (mostly positioning, it already works):**
- 64-bit Pi 4/5 already runs WatchTower via the **arm64 container**,
  **arm64 AppImage/.deb**, or **PyPI**. Surface it: add a Raspberry Pi row to the
  README install table + a short "Run it on a Pi" section + a verified lean-mode
  (no Redis worker, SQLite, tiny-LLM optional) doc.
- 32-bit ARM (Pi 2/3/Zero 2): **headless only** — Electron permanently dropped
  armv7l ([[release_pipeline_gotchas_2026_10]]); document the PyPI/container path.
- **Verify the 512 MB floor** on a real Pi Zero 2 W / 1GB Pi before claiming it.

**Phase 2 — Fleet of small devices:** WatchTower on a Pi/mini-PC "hub" manages a
fleet of small nodes (storage, photos, sensors) via Pillar 2's device registry +
capability tags. Truly tiny MCUs (ESP32) can't run WatchTower — they're *managed
targets*, not hosts.

---

## Suggested sequence

1. **Pi Phase 1 positioning** (~1–2 hrs) — unlocks a user segment that already works.
2. **Photos web UI** — turn the existing backend into a visible feature.
3. **Fleet dashboard** — unify discover-nodes + managed-devices + mesh into one view.
4. **Files pillar** — generalize the vault to arbitrary blobs.
5. **Perceptual dedup + Takeout import** — cross-source photo dedup.
6. **Federated storage backends** (multi-Gmail/Drive) — the big one, last.

*Each line above is a deliberate mini-project with its own tests + release gate
([RELEASE_QUALITY.md](../RELEASE_QUALITY.md)), not a bundled sprint.*
