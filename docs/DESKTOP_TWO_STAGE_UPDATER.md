# Two-Stage Desktop Updater — Design

Status: **phases 1 + 2 + 3 implemented** (2026-07-14).

> **RELEASE REQUIREMENT: the first release carrying this code MUST be
> versioned `1.21.0`** (not 1.20.3). Payload manifests declare
> `minShellVersion: 1.21.0` by default (the first payload-aware shell);
> shipping the payload-aware shell under a lower version would make it
> reject every payload. Bump the default in `scripts/build-payload.sh`
> ONLY when a payload starts depending on newer main.js behavior.

- Phase 1 — `scripts/build-payload.sh` + `scripts/payload_tools.py` build/sign
  the payload, the `build-payload` job in `release.yml` publishes it,
  `build-python-bundle.sh` stamps `runtime-fingerprint.json` into the shell,
  and `preflight.sh` / `verify-release.sh` gate it. Signing: private key in
  the `WATCHTOWER_PAYLOAD_SIGNING_KEY` repo secret (local copy at
  `~/.watchtower/payload-signing-key.pem`), public key pinned at
  `desktop/payload-signing.pub`.
- Phase 2 — payload boot selection + health gate + quarantine + forward-only
  floor in `desktop/main.js` (see §4; selection logic verified against
  fixture payload dirs). Kill switch: `WATCHTOWER_DISABLE_PAYLOADS=1`.
  `wt:getDependencyStatus` IPC reports `payloadVersion` when a payload is
  active. **Manual test** (packaged build only): extract a payload tarball
  and move its `payload/` dir to `~/.watchtower/payloads/<version>/`, e.g.
  `tar -xzf watchtower-payload-1.21.0.tar.gz && mv payload
  ~/.watchtower/payloads/1.21.0`, then launch the installed app — the splash
  shows "Starting the engine (update 1.21.0)". Note: signature verification
  happens at *download* time (phase 3); a hand-dropped payload boots
  unverified by design (local disk is out of the threat model, §3).
- Phase 3 — downloader in `desktop/main.js`: `tryPayloadUpdate()` runs FIRST
  in both the automatic 4-hour check (`checkForAppUpdates`) and the manual
  "Update Now" button (`runUpdateNow`). Fetches the latest release, applies
  the compatibility gates, downloads to `payloads/.tmp-<v>/`, verifies
  sha256 + Ed25519 (pubkey pinned as `PAYLOAD_SIGNING_PUBKEY_PEM` in
  main.js = `desktop/payload-signing.pub`), extracts via system tar
  (bsdtar ships with Windows 10 1803+), atomic-renames into place. Restart
  UX: OS notification (auto path) / Restart Now dialog (manual path). A
  verification failure discards and retries next poll — it never falls
  through to the installer path, so a tampered payload can't steer users to
  a less-verified channel. GC after successful boot keeps active + one
  rollback + pending. The full client logic is regression-tested by
  `desktop/scripts/test-payload-logic.js` (runs the verbatim main.js code
  in a vm sandbox against the real signed artifacts; wired into
  preflight.sh §5 — it caught the minShellVersion default bug).

Phases 4-5 (default-on posture in RELEASE_QUALITY.md, delta/channels) not
yet started — but phase 3 ships enabled (payload path simply finds no
payload assets on pre-payload releases and falls through).
Prior art: verified teardown of Obsidian 1.12.7 (`app.asar` bootstrap + downloadable
signed `obsidian.asar` payload). This document adapts that model to WatchTower's
Electron + bundled-Python desktop app.

## 1. Problem

Every release today ships a full installer (~200 MB DMG/AppImage per arch), even
when the change is three lines of Python. Consequences we have actually paid for:

- **Unsigned macOS builds can't use Squirrel/electron-updater's seamless replace.**
  `applyMacUpdate()` downloads the whole DMG and runs a detached bash script that
  rm-rf's `/Applications/WatchTower.app`, sometimes prompting for admin. Fragile,
  slow, and scary-looking to exactly the beginner audience the product targets.
- **Five per-arch artifacts that must each be correct.** The 1.12.0 cross-arch
  overwrite bug (arm64 DMG with x86_64 binaries) is a class of failure that exists
  only because we rebuild the world for every patch.
- **Stale-bundle desync.** A leftover `desktop/dist` or `python-bundle` behind the
  DB's alembic revision crashes at startup (bit a real user on 1.16.3). The more
  rarely the heavy artifact changes, the smaller this surface.
- **16 releases in one night (1.6.2 → 1.12.1)** each required users to re-download
  everything. A payload update would have been ~5 MB each.

## 2. The model (what Obsidian does, adapted)

Split the desktop app into two independently-versioned pieces:

| | **Shell** (rare updates) | **Payload** (every release) |
|---|---|---|
| Contents | Electron + `main.js`/`preload.js`/`splash.html`, bundled Python runtime (`resources/python/` incl. all pip deps with native extensions), nixpacks binaries | `watchtower/` pure-Python package (with `alembic/` inside, same convention as the bundle), `web-dist/` SPA build |
| Size | ~200 MB, per-OS/per-arch (5 artifacts) | ~5–10 MB, **one artifact for all platforms** (pure Python + static assets are arch-independent) |
| Changes when | Electron bump, Python bump, `requirements.txt` change, `desktop/*.js` change | any backend/frontend code change |
| Update path | existing installer flows (`applyMacUpdate`, electron-updater, GitHub API prompt) | new: verified download to `~/.watchtower/payloads/`, applied on restart |

The killer property: the payload is arch-independent, so the entire cross-arch
bug class *cannot exist* for the artifact that changes 95% of the time.

## 3. Payload format

`watchtower-payload-<version>.tar.gz` containing:

```
payload/
  watchtower/           # pip install --no-deps --target, alembic/ copied inside
  web-dist/             # web/dist verbatim
  payload.json          # embedded copy of its manifest entry (self-describing)
```

Published alongside it in the GitHub release: `payload-manifest.json`:

```json
{
  "version": "1.21.0",
  "minShellVersion": "1.20.0",
  "requirementsSha256": "<sha256 of normalized requirements.txt>",
  "sha256": "<sha256 of the .tar.gz>",
  "signature": "<base64 Ed25519 signature over the .tar.gz bytes>",
  "keyId": "2026-07",
  "sizeBytes": 7340032
}
```

### Compatibility gating — two independent checks

1. **`requirementsSha256`** — the payload's Python code may only run on a shell
   whose bundled site-packages were built from the same `requirements.txt`. The
   shell records its own fingerprint at build time in
   `resources/runtime-fingerprint.json` (written by `build-python-bundle.sh`):
   `{ "shellVersion": "...", "pythonVersion": "3.12.13", "requirementsSha256": "..." }`.
   Mismatch ⇒ payload not applicable ⇒ fall back to a full shell update via the
   existing installer path. This is what makes "a dep only in pyproject.toml"
   (the v1.20.0 python-multipart incident) structurally impossible to ship as a
   payload: any dep change changes the fingerprint and forces the shell path.
2. **`minShellVersion`** — for Electron-side needs (new IPC used by the SPA, new
   `main.js` behavior). Same role as Obsidian's `minimumVersion`: too-old shell
   gets a "please reinstall" prompt instead of a broken update.

### Signing

- Ed25519 keypair. Private key lives only in a GitHub Actions secret
  (`WATCHTOWER_PAYLOAD_SIGNING_KEY`); public key is pinned in `desktop/main.js`
  (and committed as `desktop/payload-signing.pub` for reference).
- CI signs the compressed tarball (exactly like Obsidian signs the gzipped asar).
- Client verifies **both** sha256 and signature before the payload ever touches
  its final location. `keyId` enables rotation: a new key ships in a shell
  update, old shells simply reject newer payloads and prompt for reinstall.
- Threat model note: this protects the download path (mirror compromise, MITM,
  tampered release asset). Local-disk tampering of `~/.watchtower/payloads` is
  out of scope — the unsigned `.app` itself is equally writable today.

## 4. Client behavior (`desktop/main.js`)

### Boot selection (packaged builds only; dev clones never use payloads)

```
candidates = ~/.watchtower/payloads/<semver>/ dirs
           filtered: version > builtin version
                     AND fingerprint matches shell's runtime-fingerprint.json
                     AND no .quarantined marker
           sorted descending
for candidate in [newest, second-newest]:
    spawn backend with --app-dir <payloadDir>   # uvicorn sys.path.insert(0) —
                                                # payload watchtower/ shadows the
                                                # bundled site-packages copy
          and WATCHTOWER_WEB_DIST=<payloadDir>/web-dist
    if /health within timeout → done, record in payloads/state.json
    else → write .quarantined with the failure reason, kill, try next
fallback: spawn with builtin (today's exact behavior)
```

Two existing `main.js` mechanisms make this nearly free: `--app-dir` is already
how the backend finds code, and `WATCHTOWER_WEB_DIST` is already how the SPA
path is injected. The payload boot is the same spawn with two different values.

### Health gate & rollback

The existing `waitForUrl(/health)` + `backendExited` early-exit capture is the
gate. On quarantine-fallback, scan the backend log tail for
`Can't locate revision` — that means the DB was migrated past the fallback
code's alembic head (the known stale-bundle failure). In that case skip straight
to the newest payload… which just failed, so show a **targeted** dialog: "The
update was rolled back but your database is newer than the installed version.
Download the latest installer." — never a dead end (product principle).

Forward-only rule: `state.json` records the highest version that ever passed the
health gate. Candidates below it are excluded from selection (prevents the
old-code-newer-DB crash by construction, not just by detection).

### Download flow

Reuses the existing GitHub release polling (`checkForUpdatesViaGitHubAPI`):

1. Latest release found → fetch `payload-manifest.json` asset.
2. Fingerprint + `minShellVersion` match ⇒ download tarball to
   `payloads/.tmp-<version>`, verify sha256 + signature, extract, atomic rename
   to `payloads/<version>/`. Notify: "Update ready — restart WatchTower" (tray +
   in-app toast via the existing notification IPC).
3. Fingerprint mismatch ⇒ current behavior (full installer update prompt /
   `applyMacUpdate` on macOS).
4. Cleanup after successful boot: keep current + one previous payload, delete
   the rest (Obsidian's GC policy).

## 5. Build & release pipeline changes

- **`scripts/build-payload.sh`** (new): stage `pip install --no-deps --target`,
  copy `alembic/` into the package (reuse the logic from
  `build-python-bundle.sh:205-225`), copy `web/dist`, tar, sha256, sign, emit
  manifest. Runs once per release — not per matrix entry.
- **`release.yml`**: one new job (linux, fast) that builds + signs + uploads the
  payload and manifest to the release. Installer matrix unchanged — we keep
  publishing full installers every release so new users always get current
  bits; *existing* users just stop needing them.
- **`preflight.sh`** additions: build the payload; assert it contains
  `watchtower/alembic/env.py`, `web-dist/index.html`, and that
  `payload.json.version == watchtower/__init__.py.__version__`; verify the
  signature round-trips against the pinned public key.
- **`verify-release.sh`** additions: download the released payload + manifest,
  re-verify sha256 + signature, assert manifest `requirementsSha256` matches the
  released shell bundles' `runtime-fingerprint.json`.

## 6. Implementation phases

1. **Artifacts only** — `build-payload.sh`, signing key setup, CI job,
   preflight/verify checks. Ship one release publishing payloads nobody consumes.
   Risk: zero (no client changes). **DONE 2026-07-14.** Measured payload size:
   0.7 MB (vs the 5-10 MB estimate).
2. **Boot path** — payload selection/health-gate/quarantine in `main.js`, tested
   by manually dropping a payload into `~/.watchtower/payloads/`. Feature-flag:
   `WATCHTOWER_DISABLE_PAYLOADS=1` env kill switch. **DONE 2026-07-14.**
3. **Downloader** — manifest fetch, verify, install, restart-to-update UX.
   **DONE 2026-07-14** (incl. GC + regression tests in
   `desktop/scripts/test-payload-logic.js`).
4. **Flip on by default** + document in RELEASE_QUALITY.md. Shell updates become
   the exception; measure by watching how rarely `requirementsSha256` changes.
5. **Later** — skip rebuilding installers when the shell is unchanged (CI time),
   delta payloads, insider/beta channel via a `beta` key in the manifest
   (Obsidian's exact mechanism).

## 7. Failure modes

| Failure | Outcome |
|---|---|
| Corrupt/tampered download | hash or signature fails → tarball discarded, retry next poll, builtin/current keeps running |
| Payload crashes on boot | quarantined after one attempt → previous payload → builtin; targeted dialog if DB is ahead |
| Dep added to requirements.txt | fingerprint mismatch → payload never offered → full installer prompt (existing path) |
| Shell too old for new main.js contract | `minShellVersion` → reinstall prompt |
| Both payload dirs + builtin fail | existing "backend failed to start" dialog with log path — unchanged worst case, but now reachable only if the *builtin* is broken |
| Signing key compromised/rotated | new pubkey ships in shell update; old shells reject new payloads and fall back to installer prompts |

## 8. Explicitly unchanged

- Dev clones (`./run.sh desktop`, `npm start`): payloads are ignored entirely
  when `!app.isPackaged`.
- `pip install watchtower-podman`, Docker, browser mode: untouched — this is
  desktop-only plumbing.
- The installer artifacts, their names, and `verify-release.sh`'s cross-arch
  checks: still built and still verified every release.
