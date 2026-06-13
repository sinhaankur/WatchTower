# WatchTower Privacy Policy

**Version 1.0 — effective 2026-06-12**

WatchTower is self-hosted: your data lives on **your** installation.
The Authors operate no servers for the Software, collect no telemetry,
and cannot see your data. This policy describes what the Software
stores locally and where data flows so you can operate it responsibly.

## What the Software stores (locally, on your machine)

- **Account data** from GitHub sign-in: your GitHub ID, username,
  email address, and avatar URL.
- **Operational data**: projects, deployments, build logs, node
  definitions, managed-database metadata, healing/self-heal decisions.
- **Secrets you provide** — GitHub tokens, SSH keys, environment-
  variable values, database passwords, API keys — stored encrypted
  (Fernet) with a key kept at `~/.watchtower/secret.key` (0600).
- **Audit log**: who did what, when, from which IP address — including
  acceptance of these legal documents. Append-only, for accountability
  on multi-user installations.

Default location: `~/.watchtower/` (or `DATABASE_URL` if configured).
Deleting that directory deletes the data. Backups you export contain
the encryption key and all secrets — guard them accordingly.

## Where data flows (only to services you configure)

- **GitHub** — for sign-in (OAuth / Device Flow), repository access,
  webhooks, and checking for new WatchTower releases.
- **Your deploy targets** — code, artifacts, and commands travel to
  your nodes over SSH.
- **Your LLM endpoint** — when you enable AI features, deployment logs
  and related context are sent to the OpenAI-compatible endpoint you
  configured (e.g. LM Studio or Ollama on localhost, or a cloud
  provider). Nothing is sent until you configure one.
- **DNS / cloud providers** — only when you connect them (Cloudflare,
  cloud credentials).
- **Bug reports** — only when you explicitly send one; review the
  attached diagnostics before sending.

There is **no** analytics, tracking, or "phone home" beyond the
release-update check against GitHub, which can be disabled in Settings.

## Your responsibilities as operator

If other people sign in to your installation, or workloads you deploy
process other people's personal data, **you** are the data controller.
Applicable data-protection law (GDPR, CCPA, and similar) is your
obligation, including informing your users and honoring their rights.
The audit log and encrypted-secret storage are tools to help you, not
a substitute for your own compliance.

## Contact

Questions about this policy: opensource@sinhaankur.dev
