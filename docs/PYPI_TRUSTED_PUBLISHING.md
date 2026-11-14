# PyPI Trusted Publishing (OIDC)

WatchTower publishes `watchtower-podman` to PyPI via **Trusted Publishing** —
GitHub Actions authenticates to PyPI with a short-lived OpenID Connect (OIDC)
token instead of a long-lived API token stored as a repo secret. Nothing to
rotate, nothing that can leak. The workflow (`.github/workflows/publish-pypi.yml`)
is already configured for it; the one remaining step is a one-time registration
on PyPI.

## ⚠️ Do this on PyPI BEFORE the next release

The publish workflow no longer passes `PYPI_API_TOKEN` — it relies solely on
OIDC. **If you don't register the Trusted Publisher first, the next `v*` tag will
fail to publish** (no token to fall back on). Order matters:

1. Register the Trusted Publisher on PyPI (below).
2. *Then* tag a release.

## Registration (one time)

`watchtower-podman` already exists and you're the sole owner, so use the
**ordinary** publisher, not a "pending" one:

1. Go to <https://pypi.org/manage/project/watchtower-podman/settings/publishing/>
   (Your projects → watchtower-podman → **Settings** → **Publishing**).
2. Under **Add a new publisher → GitHub**, enter exactly:

   | Field | Value |
   |---|---|
   | **Owner** | `sinhaankur` |
   | **Repository name** | `WatchTower` |
   | **Workflow name** | `publish-pypi.yml` |
   | **Environment name** | `pypi` |

3. Save.

> The "Pending publishers" section on PyPI is only for projects that **don't
> exist yet**. Ours exists, so don't use it — and note PyPI's warning that a
> pending publisher does **not** reserve the name.

## GitHub side (already done in this repo)

- `publish-pypi.yml` publish job has `permissions: id-token: write` (OIDC) at the
  **job** level (required — top-level alone isn't enough).
- The job runs in a dedicated **`pypi`** GitHub Actions environment. Configure
  protection in **repo Settings → Environments → pypi** (required reviewers
  and/or allowed branches) so a publish can't be triggered by anyone with mere
  commit access. The environment name must match the Trusted Publisher above.
- The `pypa/gh-action-pypi-publish` step passes **no `user`/`password`** — that's
  what makes it use OIDC.

## Cleanup after it works

Once a release publishes successfully via OIDC, **delete the now-unused
`PYPI_API_TOKEN`** from repo Settings → Secrets so there's no stale credential
to leak. (Keep it until you've confirmed one green OIDC publish.)

## Related
Supply-chain hardening overview: [CONTAINER_SUPPLY_CHAIN.md](CONTAINER_SUPPLY_CHAIN.md).
