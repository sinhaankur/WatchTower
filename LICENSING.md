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

Current copyright holder for all original work in this repository is
**Ankur Sinha**, the original author. A Canadian numbered corporation
operating as **Node2.io** is being formed; on registration, copyright in
this codebase will be assigned to that corporation by a written IP
Assignment Agreement, and the copyright notices in `LICENSE`, `pro/LICENSE`,
and this file will be updated accordingly. Until then, all licensing terms
above are granted by Ankur Sinha and continue to apply to all downstream
users of the software both before and after the assignment.

For commercial licensing, security disclosures, or legal questions during
this transition period, contact the addresses listed at the bottom of this
file.

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

The **`pro/` tier** (Elastic License 2.0) covers features sold under a
Node2.io Commercial Subscription Agreement:

- GitHub Enterprise Server (GHES) integration
- Audit log retention and export
- Team roles & granular RBAC
- SSO (SAML 2.0 / OIDC)
- Multi-region failover with health-checked standby nodes
- Priority email support with response SLA

The authoritative list of Pro features lives in
`watchtower/api/edition.py` (`PRO_FEATURES`). License keys issued by Node2.io
unlock the runtime gate in `pro/`.

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

"WatchTower" and "Node2.io" are intended trademarks of the forthcoming
Node2.io corporation; trademark applications are pending. The Apache 2.0
license does **not** grant trademark rights — see Section 6 of the Apache
License. You may build and distribute your own fork, but you must not call
it "WatchTower" or imply it is the official Node2.io product.

## Commercial licensing

A Node2.io Commercial Subscription Agreement (CSA) supersedes the Elastic
License for paying customers and may also relicense `pro/` content for
specific contractual purposes (OEM, reseller, regulated environments).
Contact <licensing@node2.io> for commercial terms.

## Contributing

By submitting a contribution to this repository you agree to the
Contributor License Agreement (CLA), which assigns Node2.io (or, prior to
its incorporation, the current copyright holder) the right to relicense
your contribution under the same terms as the surrounding directory. The
CLA is administered through cla-assistant.io and is required for all
non-trivial PRs. (Setup pending — see `CONTRIBUTING.md`.)

## Questions

- General licensing questions → <licensing@node2.io>
- Security disclosures → <security@node2.io>
- Commercial sales → <sales@node2.io>
