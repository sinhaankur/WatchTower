# Licensing

WatchTower is **open-core** software. Two licenses apply, and which one
covers a given file depends on where the file lives in this repository.

## Quick reference

| Path | License | What it means for you |
|---|---|---|
| Everything **outside** `pro/` | [Apache License 2.0](LICENSE) | Free to use, modify, redistribute, host, fork, and ship — including in your own commercial products. Includes a patent grant. |
| Everything **inside** `pro/` | [Elastic License 2.0](pro/LICENSE) | Source-available. You may run it, modify it, and use it internally. You **may not**: (1) offer it to third parties as a hosted/managed service, (2) remove or circumvent the license-key check, or (3) strip copyright/trademark notices. |

If a file does not have an explicit license header, the license is determined
by which directory it sits in.

## Copyright holder

Copyright in this codebase is held collectively by **The WatchTower Authors**
— every contributor retains copyright in their own contributions. The
canonical list of contributors lives in [`AUTHORS`](AUTHORS) at the
repository root and grows by pull request: each new contributor adds
themselves in the same change that introduces their first contribution.

There is no central copyright assignment. Contributions are licensed
inbound under the same terms that govern outbound distribution (see
[Contributing](#contributing) below).

## What's in each tier

The **free core** (Apache 2.0) covers the deploy/run-locally experience that
most individual operators and small teams need:

- Container auto-update (the original `watchtower` daemon)
- Project / build / deployment management for a single org
- GitHub OAuth + Device Flow login
- Webhook-driven CI deploys
- React SPA + Electron desktop + VS Code extension
- SQLite + Postgres support, Alembic migrations
- Single-node and basic multi-node deployment over SSH
- Local LLM agent (any OpenAI-compatible endpoint)

The **`pro/` tier** (Elastic License 2.0) covers features available under
a separate commercial agreement with The WatchTower Authors:

- GitHub Enterprise Server (GHES) integration
- Audit log retention and export
- Team roles & granular RBAC
- SSO (SAML 2.0 / OIDC)
- Multi-region failover with health-checked standby nodes
- Priority email support with response SLA

The authoritative list of Pro features lives in
`watchtower/api/edition.py` (`PRO_FEATURES`). License keys issued by The
WatchTower Authors unlock the runtime gate in `pro/`.

## Why two licenses

- **Apache 2.0 in the root** so anyone can self-host, contribute, and build
  on the core forever — including users who never pay us a cent. The patent
  grant matters for enterprise legal review.
- **Elastic License 2.0 in `pro/`** so the source remains visible and
  auditable (security teams can read every line that runs in their
  environment) while preventing competitors from rehosting Pro features as
  a service or stripping out the license check to resell.

This is the same split used by Elastic, Sentry, AppFlowy, and Sourcegraph.

## Trademarks

"WatchTower" is an unregistered trademark held by The WatchTower Authors.
The Apache 2.0 license does **not** grant trademark rights — see
Section 6 of the Apache License. You may build and distribute your own
fork, but you must not call it "WatchTower" or imply it is the official
project.

## Commercial licensing

A separate commercial agreement with The WatchTower Authors supersedes
the Elastic License for paying customers and may also relicense `pro/`
content for specific contractual purposes (OEM, reseller, regulated
environments). To inquire, open a private security advisory or a labelled
issue at <https://github.com/Node2-io/WatchTowerOps/issues>; a maintainer
will route the request.

## Contributing

This project follows the **inbound = outbound** convention: by submitting
a pull request, you agree to license your contribution under the same
terms that govern the directory it lands in (Apache 2.0 outside `pro/`,
Elastic License 2.0 inside `pro/`). You retain copyright in your own
work — there is no copyright assignment.

Add yourself to the [`AUTHORS`](AUTHORS) file in the same pull request
that introduces your first contribution. See [`CONTRIBUTING.md`](CONTRIBUTING.md)
for the full workflow.

## Questions

- General licensing questions → open an issue at <https://github.com/Node2-io/WatchTowerOps/issues>
- Security disclosures → use [GitHub Security Advisories](https://github.com/Node2-io/WatchTowerOps/security/advisories/new)
- Commercial inquiries → open a labelled issue (a maintainer will follow up privately)
