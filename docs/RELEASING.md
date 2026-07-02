# Releasing & Publishing

> Moved out of the repo README (2026-07-02). See also RELEASE_QUALITY.md
> at the repo root for the quality bar.

## Release and Publishing

### Publish Option 3 (Containers + PyPI)

This repository supports:

- **GHCR publishing**
  - Workflow: `.github/workflows/publish-container.yml`
  - Image: `ghcr.io/<owner>/watchtower`
  - Trigger: `main`, tags `v*`, or manual dispatch

- **PyPI publishing**
  - Workflow: `.github/workflows/publish-pypi.yml`
  - Package: `watchtower-podman`
  - Trigger: tags `v*` or manual dispatch

- **GitHub Release creation**
  - Workflow: `.github/workflows/release.yml`
  - Trigger: tags `v*`
  - Validates tag matches `watchtower.__version__`

One-time setup:

- Enable workflow package write permissions in repository settings
- Configure PyPI Trusted Publishing for this repository
- Use semantic release tags (for example `v1.1.1`)

Version-controlled release process:

1. Bump `watchtower/__init__.py` version.
2. Commit and merge to `main`.
3. Create and push a semantic tag, for example `v1.1.1`.
4. Actions automatically:
   - create release notes
   - publish GHCR image
   - publish PyPI package

Optional helper:

```bash
./scripts/release.sh 1.1.1
```

---

## GitHub Pages Documentation Site

- Source: `docs/`
- Workflow: `.github/workflows/deploy-pages.yml`
- URL: <https://sinhaankur.github.io/WatchTower/>

If Pages has never been enabled:

1. Open repository settings -> Pages
2. Set Build and deployment source to **GitHub Actions**
3. Run **Deploy Docs Site** once (or push docs changes)

---

