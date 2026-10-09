# Getting WatchTower into catalogs

Discovery, not just install — the places self-hosters *browse*. Each file here is
submission-ready; the actual PRs / submissions are external and need you to send
them (they require accounts + maintainer review you own).

| Channel | File | How to submit |
| --- | --- | --- |
| awesome-selfhosted | `awesome-selfhosted-entry.md` | PR a line into [awesome-selfhosted](https://github.com/awesome-selfhosted/awesome-selfhosted) under **Software Development → PaaS** |
| Umbrel App Store | `umbrel/` | PR to [umbrel-apps](https://github.com/getumbrel/umbrel-apps) |
| CasaOS App Store | `casaos/` | PR to [CasaOS-AppStore](https://github.com/IceWhaleTech/CasaOS-AppStore) |

## Before submitting

Most catalogs want: a stable Docker image (✓ `ghcr.io/sinhaankur/watchtower`, and
Docker Hub once secrets are set), a published release (⚠️ cut `v2.1.0` first — the
latest release is still the old 1.21.0), a clear one-line description, and a logo
(✓ `docs/wt-logo.svg`). Line up those, then send the PRs.
