# pro/

Source code in this directory is licensed under the **Elastic License 2.0**
(see [`LICENSE`](LICENSE)), not the Apache 2.0 license that covers the rest
of the repository. See [`../LICENSING.md`](../LICENSING.md) for the full
explanation.

## What goes here

Code that implements features gated by the Pro tier:

- GitHub Enterprise Server (GHES) integration
- Audit log retention/export endpoints
- Team RBAC enforcement
- SSO / SAML / OIDC providers
- Multi-region failover orchestration
- License-key validator (Ed25519 signature verification)
- Stripe billing webhook → license key issuance

## Conventions

- Python packages here use the prefix `watchtower.pro.*` — e.g.
  `watchtower.pro.ghes`, `watchtower.pro.licensing`.
- Every Pro route registers in `PRO_FEATURES` in
  `watchtower/api/edition.py` and depends on `Depends(require_pro("..."))`.
- Pro frontend components live in `web/src/pro/` and wrap the UI in
  `<ProLock feature="...">`. (The split mirrors this directory.)
- Do not import from `pro/` into the Apache-licensed core. The core may
  expose extension points (registries, hooks); `pro/` registers into them.
  Keeps the licensing boundary unambiguous.

## Running without a Pro license

The Apache-licensed core runs fine without anything in this directory.
`pro/` is only loaded when a valid license key is present (or
`WATCHTOWER_TIER=pro` is set in development). Users on the free tier never
execute Pro code paths.
