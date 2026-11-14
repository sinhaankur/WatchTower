# Security Policy

WatchTower runs unattended on hardware you own and holds credentials to your
GitHub, your servers (SSH), and your databases. We take its security posture
seriously and build to a standard where you don't have to take its behaviour on
faith. See [docs/SECURITY_HARDENING.md](docs/SECURITY_HARDENING.md) for the full
hardening guide.

## Supported versions

WatchTower ships from a single `main` line; security fixes land in the next
patch release. Always run the latest release — the desktop app auto-updates
from GitHub Releases, and other install methods are a one-line upgrade.

| Version | Supported          |
| ------- | ------------------ |
| Latest release (`2.1.x`) | ✅ Fixes shipped here |
| Older releases | ❌ Please upgrade |

## Reporting a vulnerability

**Please do not open a public issue for security vulnerabilities.**

Report privately through
[**GitHub Security Advisories**](https://github.com/sinhaankur/WatchTower/security/advisories/new).
This creates a private channel between you and the maintainers where we can
discuss, fix, and coordinate disclosure without exposing users in the meantime.

When reporting, please include where you can:

- The version (`watchtower --version` or the About panel) and install method
  (desktop app / PyPI / Docker / source).
- A description of the issue and its impact.
- Steps to reproduce, or a proof-of-concept.
- Any relevant logs (with secrets redacted — WatchTower never logs secret
  values, but your own environment might).

## What to expect

- **Acknowledgement within 72 hours.** We'll confirm we received the report and
  whether we can reproduce it.
- **A fix timeline.** Once triaged, we'll share an expected timeline and keep
  you updated. Severe issues are prioritised for the next patch release.
- **Credit.** With your permission, we'll credit you in the release notes and
  the advisory. We support coordinated disclosure and ask that you give us a
  reasonable window to ship a fix before any public write-up.

## Scope

In scope: the WatchTower application and its official distribution artifacts
(desktop app, PyPI package, container image, release scripts).

Out of scope: vulnerabilities in third-party dependencies that are already
publicly known and tracked upstream (we floor these in `pyproject.toml` /
`Dockerfile` and the Trivy scans gate them), and issues that require an
already-compromised host or physical access — WatchTower assumes the machine it
runs on is trusted.

## Our baseline

For context on what WatchTower already does to protect you:

- **No telemetry, ever.** Fully self-hosted; nothing phones home.
- **Secrets encrypted at rest** (Fernet) — GitHub tokens, SSH keys, LLM API
  keys. Never echoed by the API, never written to logs or audit records.
- **SSRF + path-traversal guards**, shell-free container commands, strict
  input validation on all user-supplied names.
- **Append-only audit log** of every mutating action.
- **Supply chain**: Dependabot, Trivy filesystem + container scans, CodeQL
  code scanning, cosign-signed images with SBOM + SLSA provenance.
