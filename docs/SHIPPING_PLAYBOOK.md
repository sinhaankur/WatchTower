# The Shipping Playbook

Lessons for building and releasing **any** application, distilled from
WatchTower's real release history — every rule below exists because skipping
it cost real users a broken install, a crashed launch, or a re-download.
None of them are theoretical.

WatchTower-specific mechanics live in [RELEASE_QUALITY.md](../RELEASE_QUALITY.md)
and [docs/RELEASING.md](RELEASING.md). This document is the transferable part:
take it to your next project.

---

## 1. One source of truth for the version

Pick exactly one place the version number lives (here:
`watchtower/__init__.py`) and generate every other occurrence from it —
package manifests, installers, CI tag validation. The moment two files can
disagree, they eventually will, and version drift shows up as the worst kind
of bug: an updater that thinks it's current when it isn't.

**Apply it:** a `sync_versions` script + a CI check that the git tag matches
the package version. Reject the release if they differ.

## 2. Gate releases with scripts, not judgment

One night this project shipped 16 releases (1.6.2 → 1.12.1) because every
issue was found *after* users had it. The fix wasn't "be more careful" — it
was two scripts:

- **Preflight** (before tagging): tests, lint, typecheck, a real pack of the
  installer, and inspection of what got packed.
- **Post-release verify** (after CI): download the *published* artifacts and
  inspect them the way a user's machine would.

Every "it'll probably work" that night became a real user incident. If a
check can be mechanical, make it mechanical — judgment is what you use for
the things scripts can't see yet.

## 3. Verify the artifact users download, not the build log

CI can go green while the published artifact is wrong: an arm64 Mac installer
once shipped with x86_64 binaries inside (two matrix jobs overwrote each
other's output). No build log catches that — only downloading the released
file and running `file` against the native binaries inside it does.

**Apply it:** your post-release check must start from the public download
URL, extract the artifact, and assert architecture/contents/version from
scratch. Trust nothing upstream of the user's click.

## 4. "It imports" is not "it starts"

`import myapp` succeeding proves almost nothing. WatchTower 1.20.0 shipped a
desktop build whose backend imported fine but crashed at startup, because a
route registered at app-load time needed a dependency (`python-multipart`)
that the import check never touched.

**Apply it:** the preflight check must exercise the same code path startup
does — load the ASGI/WSGI app, construct the DI container, register every
route/handler. Best of all: boot the packaged app headless and poll its
health endpoint (WatchTower smoke-tests the Linux AppImage this way in CI).

## 5. Dependency manifests drift — fingerprint them

If dependencies are declared in more than one place (`pyproject.toml` +
`requirements.txt`, `package.json` + a bundler config), the copies *will*
diverge, and the artifact built from the stale copy crashes only on user
machines. Two defenses, use both:

- A check that the shipped artifact starts (rule 4 catches the symptom).
- A **content fingerprint** (sha256 of the normalized manifest) baked into
  the artifact at build time. Anything that must be compatible with it —
  updates, plugins, sidecars — compares fingerprints instead of hoping.
  A mismatch routes to the safe path (full reinstall) automatically.

## 6. Build artifacts go stale; refuse to use them

Any build output that survives between builds (`dist/`, a cached runtime
bundle) will eventually be packaged by mistake. A user on 1.16.3 got a
launch-crash because a leftover 1.14.4 bundle was packed into a new app.

**Apply it:** stamp every intermediate artifact with the version it was built
from, and make the packaging step *refuse to run* when the stamp doesn't
match the source tree. "Rebuild fresh in CI" is necessary but not
sufficient — local packs need the guard too.

## 7. Old code must never run against a newer database

Schema migrations only run forward. The stale bundle in rule 6 crashed with
"Can't locate revision" because the user's database had been migrated past
the code's newest migration. Any mechanism that can select which code version
runs (updaters, rollbacks, side-by-side installs) must enforce
**forward-only selection**: never boot a version older than the last one that
touched the data, and when that's impossible, say exactly what to install
instead of dying with a migration error.

## 8. Split what changes often from what changes rarely

A 3-line fix shouldn't cost users a 200 MB download, and shouldn't re-roll
the dice on five per-architecture builds. Split the deliverable:

- **Shell** — runtime, native deps, the expensive per-arch part. Rebuilt only
  when its inputs change (fingerprint from rule 5 tells you when).
- **Payload** — your actual code + assets. If it's pure
  interpreted-code-plus-static-files, it's *one artifact for every platform*,
  and the entire cross-arch bug class from rule 3 structurally cannot exist
  for it. (WatchTower's payload measured 0.7 MB against a 200 MB installer.)

Sign the payload (hash + real signature, verified before it ever reaches its
final location), health-check it on first boot, and quarantine + roll back
automatically when it fails. Obsidian has run this model in production for
years; it's not exotic.

## 9. A failure the user can't act on is a bug

Every error the user sees must name what's missing and the exact next step —
never a stack trace, never a dead end. This is enforceable: WatchTower's
preflight greps the desktop dialogs for `Traceback`, `ImportError`,
`ModuleNotFoundError` and fails the release if developer jargon leaks into a
user-facing string. Rollbacks get the same care: "The update was rolled back
but your database is newer — download the latest installer from X" beats a
crash loop by a mile.

## 10. Checklists grow from incidents, not imagination

Don't try to write the perfect release checklist up front. Ship with the
obvious checks, and every time a regression slips through, add the check that
would have caught it to whichever gate (preflight or post-release verify)
could have seen it first. Every check in this repo's scripts is annotated
with the incident that created it — which also stops anyone from "cleaning
up" a check that looks paranoid.

## 11. Retry only what you've proven is transient

CI retries are a scalpel, not a blanket. Blanket-retrying every failure hides
real bugs for three attempts and burns 45 minutes. Retry on the *specific
signature* of a known-flaky failure (`hdiutil: Device not configured` on
macOS runners, npm registry 502s during postinstall) and fail fast on
everything else.

## 12. Timeouts: poll fast, deadline generous

A health-wait loop should exit the instant the service responds — so a
generous ceiling costs nothing on the happy path. WatchTower's smoke test
flaked a legitimate release at a 90-second deadline (first-run migrations on
a slow runner) and was fixed by raising only the ceiling to 150s, keeping the
2-second poll. Pair the deadline with a process-death check so a real crash
still fails in seconds, not at the timeout.

## 13. Parallel jobs writing one output need a merge step

Two CI matrix legs each publishing their own `latest-mac.yml` to the same
release raced, and whichever finished last silently disabled auto-update for
the other architecture — for months. When N parallel jobs produce one shared
file, add an explicit fan-in job that merges their outputs, and make the
post-release verifier assert the merged result (both arches listed) so a
regression is loud.

---

*Referenced from [README.md](../README.md). WatchTower's concrete
implementations: `scripts/preflight.sh`, `scripts/verify-release.sh`,
`scripts/build-payload.sh`, `scripts/build-python-bundle.sh`,
`docs/DESKTOP_TWO_STAGE_UPDATER.md`.*
