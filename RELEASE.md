# WatchTower Release & Distribution Guide

This document explains how to create releases, manage semantic versioning, and distribute WatchTower through multiple channels.

---

## Release Management

### Current Version
Current stable version: **1.2.2** (defined in `watchtower/__init__.py`)

### Semantic Versioning

WatchTower follows [semantic versioning](https://semver.org/):
- **MAJOR** (1.0.0) — Breaking changes, API incompatibilities
- **MINOR** (1.2.0) — New features, backwards-compatible
- **PATCH** (1.2.2) — Bug fixes, backwards-compatible

### Release Checklist

Before creating a release:

1. **Update Version**
   ```bash
   # Edit watchtower/__init__.py
   __version__ = "X.Y.Z"
   ```

2. **Run Tests**
   ```bash
   python -m pytest tests/
   npm run build --prefix web
   ```

3. **Update Changelog** (optional, in `CHANGELOG.md` if you maintain one)
   ```markdown
   ## [1.2.3] - 2026-04-25
   ### Added
   - Feature X
   - Feature Y
   ### Fixed
   - Bug Z
   ```

4. **Commit & Tag**
   ```bash
   git add watchtower/__init__.py CHANGELOG.md
   git commit -m "Release 1.2.3"
   git tag -a v1.2.3 -m "Release version 1.2.3"
   git push origin main
   git push origin v1.2.3
   ```

---

## Creating Tags for Releases

### Creating Your First Release Tag

```bash
# Create an annotated tag (recommended)
git tag -a v1.2.2 -m "Release WatchTower 1.2.2"

# Push the tag to GitHub
git push origin v1.2.2
```

### GitHub Actions Automation

WatchTower includes CI/CD workflows that trigger on tags:

**`.github/workflows/publish-container.yml`**
- Triggers on: `main` branch push, version tags (`v*`), manual dispatch
- Publishes: `ghcr.io/sinhaankur/watchtower:v1.2.2`
- Also tags: `ghcr.io/sinhaankur/watchtower:latest`

**`.github/workflows/publish-pypi.yml`**
- Triggers on: Version tags (`v*`)
- Publishes: Python package to PyPI as `watchtower-podman==1.2.2`

**`.github/workflows/release.yml`**
- Triggers on: Version tags (`v*`)
- Creates: GitHub Release with release notes
- Validates: Tag version matches `watchtower.__version__`

### Tag Naming Conventions

| Format | When | Example |
|--------|------|---------|
| `v1.2.2` | Stable releases | `v1.2.2` |
| `v1.2.2-alpha.1` | Alpha testing | `v1.2.2-alpha.1` |
| `v1.2.2-beta.1` | Beta testing | `v1.2.2-beta.1` |
| `v1.2.2-rc.1` | Release candidate | `v1.2.2-rc.1` |

---

## Distribution Channels

### 1. GitHub Releases

**How users get it:**
```bash
# Download via GitHub releases page
https://github.com/sinhaankur/WatchTower/releases
```

**What's included:**
- Pre-built container image references
- Source code archives (`.zip`, `.tar.gz`)
- Release notes
- Links to documentation

**Automatic via GitHub Actions:**
- Triggered when you push a `v*` tag
- Release notes auto-generated from commit messages

### 2. GitHub Container Registry (GHCR)

**How users pull it:**
```bash
docker pull ghcr.io/sinhaankur/watchtower:v1.2.2
docker pull ghcr.io/sinhaankur/watchtower:latest
```

**What's published:**
- Pre-built Docker image
- Tagged with version AND latest
- Multi-architecture support (if configured)

**Trigger:**
```bash
git tag -a v1.2.2 -m "Release"
git push origin v1.2.2
# → GitHub Actions automatically builds & pushes to GHCR
```

### 3. PyPI (Python Package Index)

**How users install it:**
```bash
pip install watchtower-podman==1.2.2
pip install watchtower-podman  # Gets latest
```

**What's published:**
- Python package with dependencies
- Available globally via `pip`
- Versioned releases for reproducibility

**Trigger:**
```bash
git tag -a v1.2.2 -m "Release"
git push origin v1.2.2
# → GitHub Actions automatically publishes to PyPI
```

**One-time PyPI setup (already configured):**
- Repository has "Trusted Publishing" enabled
- No PyPI tokens needed in GitHub Secrets

### 4. Source Code Downloads

**How users get the source:**
```bash
# Via GitHub releases page
https://github.com/sinhaankur/WatchTower/releases/download/v1.2.2/watchtower-1.2.2.tar.gz
https://github.com/sinhaankur/WatchTower/releases/download/v1.2.2/watchtower-1.2.2.zip

# Via git clone
git clone --branch v1.2.2 https://github.com/sinhaankur/WatchTower.git
```

---

## Quick Reference: Release Command Sequence

```bash
# 1. Verify you're on main and up-to-date
git checkout main
git pull origin main

# 2. Update version in watchtower/__init__.py
nano watchtower/__init__.py
# Change __version__ = "1.2.3"

# 3. Commit version bump
git add watchtower/__init__.py
git commit -m "Bump version to 1.2.3"

# 4. Create and push tag
git tag -a v1.2.3 -m "Release WatchTower 1.2.3 - Added integrations hub and watchdog"
git push origin main
git push origin v1.2.3

# 5. Watch GitHub Actions
# → Workflows will automatically build, test, and publish to all channels
```

**That's it!** Your release is now available on:
- ✅ GitHub Releases
- ✅ GitHub Container Registry
- ✅ PyPI (Python package)
- ✅ GitHub & source archives

---

## Beta Releases

For testing new features before stable release:

```bash
# Create beta tag
git tag -a v1.3.0-beta.1 -m "Beta: Integrations Hub & Watchdog"
git push origin v1.3.0-beta.1
```

Users can test via:
```bash
# Docker beta
docker pull ghcr.io/sinhaankur/watchtower:v1.3.0-beta.1

# PyPI beta
pip install watchtower-podman==1.3.0b1
```

---

## Downloading Releases as Users

### Method 1: Docker (Recommended for most)
```bash
# Latest stable
docker run ghcr.io/sinhaankur/watchtower:latest

# Specific version
docker run ghcr.io/sinhaankur/watchtower:v1.2.2
```

### Method 2: Python Package
```bash
pip install watchtower-podman
```

### Method 3: Source Code (Development)
```bash
git clone --branch v1.2.2 https://github.com/sinhaankur/WatchTower.git
cd WatchTower
./run.sh
```

### Method 4: Docker Compose (Production)
```bash
curl -O https://raw.githubusercontent.com/sinhaankur/WatchTower/v1.2.2/docker-compose.app.yml
docker compose -f docker-compose.app.yml up -d
```

---

## Viewing Release History

### On GitHub
```
https://github.com/sinhaankur/WatchTower/releases
```

### Via CLI
```bash
# List all tags
git tag -l

# Show commits for a specific tag
git show v1.2.2

# Show difference between releases
git diff v1.2.1 v1.2.2
```

---

## Troubleshooting

### Workflow doesn't trigger on tag push
- Verify tag follows `v*` pattern (e.g., `v1.2.2`, not `1.2.2`)
- Check `.github/workflows/*.yml` files have correct `tags` filter
- Verify branch protection doesn't block tag pushes

### PyPI publication fails
- Ensure `watchtower.__version__` matches tag (e.g., `1.2.2` for `v1.2.2`)
- Check PyPI "Trusted Publishing" is enabled in repo settings
- Review GitHub Actions logs for error details

### Container image not appearing in GHCR
- Verify GitHub repository has Container Registry enabled
- Check `.github/workflows/publish-container.yml` exists
- Review GitHub Actions logs for build errors
- May take 5–10 minutes to appear after workflow completes

---

## Next Steps

- **Document Features:** Add release notes to GitHub Releases
- **Announce:** Post release to discussions, socials, community channels
- **Monitor:** Watch for issues reported by early adopters
- **Iterate:** Fix bugs and plan next release

---

## Further Reading

- [Semantic Versioning](https://semver.org/)
- [GitHub Releases](https://docs.github.com/en/repositories/releasing-projects-on-github)
- [GitHub Container Registry](https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-container-registry)
- [PyPI Documentation](https://pypi.org/)
