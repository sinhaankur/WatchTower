# WatchTower — Security Audit (2026-10-08)

End-to-end review: dependencies, auth, secrets, network exposure, known guards.
Grounded in the actual code. Prioritised by real-world risk.

---

## 🔴 HIGH — fix now

### H1 · Default bind is `0.0.0.0` (all interfaces)
`deploy_server.py` `serve` defaults `--host` to `os.getenv("WATCHTOWER_HOST", "0.0.0.0")`.
Running the backend directly exposes the API to the **whole local network**, not
just the machine. `run.sh` correctly passes `127.0.0.1`, but the *default* should
be safe. **Fix:** default to `127.0.0.1`; require an explicit opt-in (or the
Remote-Access/Tailscale flow) to bind wider. Defence in depth — the app is still
token-authed, but "private by default" is the promise.

### H2 · Dependency CVEs (genuinely fixable)
Python (`pip-audit`): the real fixable ones —
| Package | Have | Fix |
|---|---|---|
| cryptography | 47.0.0 | **50.0.0** (several CVEs) |
| anyio | 4.13.0 | 4.14.2 |
| idna | 3.13 | 3.15 |
| mcp | 1.27.1 | 1.28.1 |
| requests | 2.31.0 | (bump to latest 2.x) |
| starlette | 0.38.6 | (bump; known CVEs) |

npm (`npm audit`): 11 issues — all **build-time tooling** (vitest, tailwindcss,
postcss, braces, source-map-js), none in shipped runtime. Clear the safe ones.

---

## 🟢 GOOD — already solid (verified)

- **Auth:** one single dependency (`get_current_user`), HMAC-SHA256 signed
  sessions, **`hmac.compare_digest`** (constant-time) — no timing leak. The old
  insecure "any-bearer-accepted" dev bypass was **removed** (1.12.5). Static
  token path uses a constant-time match.
- **Secrets:** Fernet `SECRET_KEY` + `AUTH_SECRET` auto-generated on first run,
  written atomically with **`0600`** perms in a **`0700`** dir. Not in env, not
  in git.
- **Known guards (per CLAUDE.md + tests):** SSRF protection (private/loopback/
  cloud-metadata blocked), path-traversal-guarded static serving, container
  commands never shelled, strict name validation, SPA security headers. Tests
  cover these.

---

## 🟡 MEDIUM — worth doing

- **M1 · `requests 2.31.0`** is old (it's the one most likely to matter at
  runtime — used for outbound calls). Bump.
- **M2 · npm build-tool CVEs** — run the safe `npm audit fix` (no `--force`);
  anything needing a major bump, pin + note.
- **M3 · Rotate the committed/pasted tokens** if any were shared in chat/history
  (general hygiene — not a code issue).

---

## The fix order
1. H1 — default host `127.0.0.1` (one-line, high value).
2. H2/M1 — bump cryptography, anyio, idna, mcp, requests, starlette; re-audit.
3. M2 — `npm audit fix` (safe), verify build.
4. Re-run `pip-audit` + `npm audit` → confirm clean(er).

---

## OUTCOME (2026-10-08)

**Fixed:**
- **H1** — default host is now `127.0.0.1` (was `0.0.0.0`). Private by default.
- **H2/M1** — bumped cryptography 47→50.0.2, anyio→4.15.1, idna→3.20,
  requests 2.31→2.34.2, pillow→12.3.0, urllib3→2.8.0, PyJWT→2.15.1,
  python-multipart→0.0.32, paramiko→5.0.0. Pinned in requirements.txt.
- **M2** — `npm audit fix` (safe) applied; web still builds.
- **Python vulns: 93 → 20.** npm: 11 → 10 (remainder = build-time tooling only).
- **All 892 Python tests pass** after every bump.

**Deliberately NOT bumped (would break the app — verified):**
- **starlette (14 CVEs)** + **mcp (6)** are tangled: patched starlette needs a
  FastAPI/pydantic major jump. Forcing FastAPI→0.143 / pydantic→2.14 **broke 3
  tests** (pydantic model-rebuild change) — reverted. starlette's CVEs are mostly
  DoS/edge cases; the app is loopback-only + token-authed, so real exposure is
  low. Revisit when FastAPI ships a release compatible with patched starlette.
- **npm --force** majors (vitest/tailwind) left alone — dev-only, breaking-change risk.
