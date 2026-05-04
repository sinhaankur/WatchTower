# WatchTower Release Quality Standard

The bar every release has to clear, and the checklist that verifies it. Lives at the repo root because the goal is "follow this and you ship a working build" — buried in `docs/` it gets ignored.

## Why this exists

Tonight (May 3-4, 2026) we shipped 16 releases between 1.6.2 and 1.12.1 — most because issues were caught **after** they were in users' hands. Examples:

- 1.9.0 macOS DMGs missing entirely (CI 502 ate the build silently)
- 1.10.0 Mac couldn't actually auto-update (unsigned bundle quirk, no fallback)
- 1.11.0 Linux x64 crashed on fresh install (alembic migrations weren't packaged)
- 1.12.0 Mac DMG had wrong-arch Python bundle (multi-arch overwrite bug in package.json)

Every one of these would have been caught by the checklist below before the user saw it. The standard isn't aspirational — it's "would this have caught the last 5 broken releases?"

---

## The Quality Bar

A release qualifies for **Stable** (default channel, auto-updated to all users) only if **every** item below holds.

Anything that fails one or more items ships as **Beta** (opt-in channel, must be explicitly selected by the user) or doesn't ship at all.

### 1. Code health
- All `pytest tests/` pass.
- `npm --prefix web run build` succeeds (which runs `tsc --noEmit` first — type errors block the build).
- `npm --prefix web run lint` is clean (`--max-warnings 0`).
- No uncommitted changes besides the version-bump files (`watchtower/__init__.py`, `package.json`, `desktop/package.json`, `vscode-extension/package.json`, `docs/index.html`, `CHANGELOG.md`).

### 2. Local desktop build integrity
- `cd desktop && npm run pack -- --mac --arm64` succeeds.
- The packed `.app` contains a working Python bundle:
  - `Contents/Resources/python/bin/python3` exists.
  - That binary imports `watchtower` AND `pydantic_core` AND `cryptography` AND `alembic` cleanly.
  - `Contents/Resources/python/lib/python3.12/site-packages/watchtower/alembic/env.py` exists (or platform equivalent).
- Launching the packed `.app` from `dist/mac-arm64/` boots the backend within 90s.
- `curl http://127.0.0.1:8000/health` returns `200`.
- `curl http://127.0.0.1:8000/` returns the SPA (HTML), not a 404 JSON.

### 3. CI artifact integrity (per release tag)
- `Run tests` job passes.
- `Create GitHub Release` job creates the release.
- All seven desktop matrix entries reach `success` conclusion (linux-x64, linux-arm64, linux-armv7l, mac-arm64, mac-x64, windows-x64, windows-arm64).
- The Linux x64 smoke test passes (boots backend, hits `/health` within 90s).
- Each `.dmg` / `.AppImage` / `.exe` contains the **correct arch** Python bundle:
  - mac-arm64.dmg → arm64 `_pydantic_core.cpython-3*-darwin.so` (Mach-O arm64)
  - mac-x64.dmg → x86_64 equivalent
  - linux-x64.AppImage → ELF 64-bit x86-64
  - linux-arm64.AppImage → ELF 64-bit aarch64
- All three `latest-*.yml` files are present at the release (electron-updater needs them).
- Total asset count is in the expected range (27 ± 2 for a full multi-platform release).

### 4. End-user experience
- Install path is **one of these**, no terminal required:
  - macOS: download DMG → drag to Applications → double-click. (Optional `xattr -cr` until we sign.)
  - Linux: download AppImage → `chmod +x` → double-click.
  - Windows: download installer → run.
- First launch reaches the dashboard or the login screen within 90s (cold) / 15s (warm).
- No `pipx install` required for the desktop `.app` to function.
- Failure dialogs use plain English. Words that **must not** appear in any user-facing dialog: `ImportError`, `ModuleNotFoundError`, `Traceback`, `PEP 668`.

### 5. Migration & compatibility
- Existing user data dirs (`~/.watchtower/`) survive the upgrade — Alembic upgrades cleanly from any prior version's schema.
- The 1.10.2+ self-replace updater works for the previous stable version → this one.
- No env var or config file from the previous stable is silently ignored.

### 6. Docs
- `CHANGELOG.md` has an entry for this version that names the user-visible changes (not just commit titles).
- Install commands in any docs reference the new version, not a stale one.
- Pro features added in this release have a `PRO_FEATURES` entry in `watchtower/api/edition.py` with a real description (not a placeholder).

---

## Release Checklist (run before tagging)

Run this as a script (`./scripts/preflight.sh`) but the items here are the source of truth. The script just automates them.

```
Pre-release (local):
  [ ] On main, working tree clean apart from version-bump files
  [ ] watchtower/__init__.py:__version__ matches the tag you're about to push
  [ ] CHANGELOG.md has an entry for this version
  [ ] pytest tests/ — all green
  [ ] npm --prefix web run lint — zero warnings
  [ ] npm --prefix web run build — succeeds (typecheck + bundle)
  [ ] scripts/build-python-bundle.sh — fresh bundle for current arch builds + verifies
  [ ] cd desktop && npm run pack -- --mac --arm64 — packs cleanly
  [ ] dist/mac-arm64/.../python/bin/python3 -c 'import watchtower, pydantic_core, cryptography' — succeeds
  [ ] open dist/mac-arm64/WatchTower.app — launches, dashboard visible within 90s
  [ ] curl http://127.0.0.1:8000/health — returns 200
  [ ] curl http://127.0.0.1:8000/ | head -1 — returns HTML (SPA index), not JSON 404

Release tag:
  [ ] git push origin main
  [ ] git push origin v<version>

CI gates:
  [ ] All 7 desktop jobs reach success conclusion
  [ ] Linux x64 smoke test passes
  [ ] Asset count is 27 ± 2

Post-release verification (after CI succeeds):
  [ ] scripts/verify-release.sh v<version> — checks each platform bundle's arch
  [ ] Auto-update from prior stable: install prior, launch, accept update prompt,
      verify the new version label appears after restart
  [ ] At least one fresh-install on each platform you have access to
```

---

## Standing Quality Tooling

These ship as part of the repo so anyone can run the checks without remembering them:

| Script | Runs | What it checks |
|---|---|---|
| `scripts/preflight.sh` | Locally before `git tag` | Items 1, 2, 6 above (the parts that don't need CI) |
| `scripts/verify-release.sh <vTAG>` | Locally after CI succeeds | Item 3 — downloads each release asset, runs `file` on critical bundle binaries to confirm arch, runs `python -c 'import watchtower, pydantic_core'` against each Python bundle |
| Workflow smoke test (existing) | In CI on Linux x64 | Subset of item 4 — boots backend headlessly, hits `/health` |

**Don't ship Stable without running both scripts.** If they fail, ship as Beta until fixed.

---

## Stable vs Beta channels (target state)

Not yet implemented as of 1.12.1. Target shape:

- **Stable channel** (`latest-*.yml`): tags like `v1.12.1`. Auto-applied to all users.
- **Beta channel** (`beta-*.yml`): tags like `v1.13.0-beta.1`. Users must opt in via Settings → Update channel.
- electron-updater's `channel` field in `publish` config does the routing. Workflow already half-supports this (`prerelease: ${{ contains(github.ref_name, '-') }}`).

Until channels exist, the discipline is: **only push tags that pass the Stable bar**. Anything experimental stays on a branch and is shared as a build artifact, not a tagged release.

---

## What this isn't

- Not a substitute for human judgment. The checklist catches structural issues; UX regressions still need eyes.
- Not exhaustive. New regressions add new checks. The checklist grows from real failures, not imagined ones.
- Not a gate that should block every commit. Run preflight before tagging, not on every push.
