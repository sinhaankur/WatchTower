# Directory & marketplace listings kit

Ready-to-paste copy for submitting WatchTower to software directories. Keep the
name, tagline, and description identical everywhere — consistent wording across
listings is what search engines and AI models key on.

**Canonical one-liner (use everywhere):**

> Turn a computer you already own into your personal cloud. Deploy from GitHub
> with managed databases and backups — and when a deploy breaks, WatchTower
> diagnoses and fixes it itself.

---

## alternativeto.net (manual submission)

- **Name:** WatchTower (by Ankur Sinha) — the plain name "Watchtower" is taken
  by containrrr's Docker updater; the parenthetical avoids the clash.
- **Tagline:** Self-hosting that fixes itself — your personal cloud on a
  computer you already own.
- **Description:** use the canonical one-liner plus: "Rootless Podman, private
  by default over Tailscale, one-click Postgres/MySQL/MariaDB/Mongo/Redis,
  desktop apps for macOS/Linux/Windows. Open-core (Apache 2.0 + ELv2), no
  telemetry, free forever for self-hosting."
- **Website:** https://sinhaankur.github.io/WatchTower/
- **Set as alternative to:** Coolify, Dokploy, CapRover, Umbrel, CasaOS,
  Vercel, Netlify, Render.
- **Tags:** self-hosted, PaaS, deployment, personal-cloud, podman, tailscale,
  self-healing, homelab.
- **Platforms:** Mac, Windows, Linux, Self-Hosted.

## awesome-selfhosted (PR to github.com/awesome-selfhosted/awesome-selfhosted-data)

Submission rules to check at PR time (they evolve): project age, activity,
description ≤ 250 chars, tags must exist in their `tags/` directory, license
must be on their free-license list (core is Apache-2.0, which qualifies —
mention the open-core split in the PR description for transparency).

Draft `software/watchtower-deploy.yml`:

```yaml
name: "WatchTower"
website_url: "https://sinhaankur.github.io/WatchTower/"
source_code_url: "https://github.com/sinhaankur/WatchTower"
description: "Self-hosted deployment platform that turns a computer you own into a personal cloud: GitHub push-to-deploy, managed databases, private access over Tailscale, and self-healing deploys that diagnose and fix failures automatically."
licenses:
  - Apache-2.0
platforms:
  - Python
  - Nodejs
tags:
  - self-hosting-solutions
depends_3rdparty: false
```

(Verify the exact tag slug against their `tags/` directory before submitting —
`self-hosting-solutions` or the PaaS category, whichever fits their taxonomy
at the time.)

## VS Code Marketplace

The extension already exists in `vscode-extension/`. To list it:
`npm --prefix vscode-extension run package`, then publish with `vsce publish`
under a publisher account. Marketplace listing needs: publisher display name,
128×128 icon (reuse the Wt monogram), category "Other" + keywords
(deploy, self-hosted, podman), and a README with screenshots — the extension
README becomes the listing page.

## Linux stores (Flathub / Snap Store)

Real packaging work (estimated ~days each, tracked in the integration backlog):

- **Flathub:** needs a flatpak manifest wrapping the Electron app;
  electron-builder has no first-class flatpak target, so this is a separate
  manifest repo submitted to github.com/flathub.
- **Snap Store:** electron-builder supports `--linux snap` natively — the
  cheaper first step. Needs a snapcraft.io publisher account.

Both give WatchTower a storefront presence independent of the GitHub brand —
relevant if the name clash with containrrr/watchtower ever becomes a problem.

## Submission status

| Directory | Status |
|---|---|
| alternativeto.net | Ankur submitting manually (2026-07) |
| awesome-selfhosted | Draft ready above — not yet submitted |
| VS Code Marketplace | Extension built, not yet published |
| Snap Store | Not started |
| Flathub | Not started |
| Google Search Console | Site not yet submitted — needs Google account, verify via HTML tag on the Pages site |
