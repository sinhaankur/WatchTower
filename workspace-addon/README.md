# WatchTower for Google Workspace (Gmail sidebar)

A Workspace add-on that puts a WatchTower sidebar inside Gmail (and any
other Google Workspace host). Built in Apps Script — runs free on
Google's infrastructure, no extra hosting, no OAuth proxy.

Same auth + tool surface as the [VS Code extension](../vscode-extension/)
and the [MCP server](../watchtower/mcp_server.py): a personal API token
talks to the WatchTower `/api`. Add-on adds no new server-side code,
no new data path, no new privilege escalation route.

## What it does

| Surface | What you see |
|---|---|
| **Gmail sidebar (any open email)** | Auto-detects `owner/repo` references in the subject. Shows a "Find in WatchTower" jump link + your top 5 projects with one-click Deploy buttons. |
| **Homepage card (any Workspace host)** | Project list with branch + use-case + Deploy button. Shows a friendly Configure card if no token is saved yet. |
| **Configure card** | Paste your WatchTower URL + API token; we verify by hitting `/health` so a wrong token is rejected immediately. |
| **Universal action** | Toolbar "Open dashboard" + "Configure" entries reachable from every card. |

## Install as a private add-on (5 min)

Workspace add-ons get installed by deploying them as a private Apps Script
project against your own Google account. No Marketplace listing required.

```bash
# 1. Install Google's clasp CLI (one-time, global)
npm install -g @google/clasp

# 2. Sign in
clasp login

# 3. Inside this directory, create a new Apps Script project bound to
#    no spreadsheet/doc (just a standalone add-on).
cd workspace-addon
clasp create --type standalone --title "WatchTower"
# This writes a .clasp.json with your fresh scriptId — gitignored.

# 4. Push the .gs files + manifest up to Apps Script
clasp push

# 5. Open the script in your browser
clasp open
```

In the Apps Script editor: **Deploy → Test deployments → Install**.
Pick "WatchTower" in the install dialog — it'll show up in Gmail's
sidebar (right-hand panel) within ~60 seconds.

## First-run

1. Open Gmail. Click the WatchTower icon in the right sidebar.
2. You'll see the **Configure** card.
3. Paste your WatchTower API URL (e.g. `http://localhost:8000` or
   your remote install's URL) and your `WATCHTOWER_API_TOKEN`.
4. Tap **Save and verify**. The card pings `/health` immediately;
   a wrong URL or token fails fast with the actual error.
5. Sidebar flips to the project list.

## Files

| File | Purpose |
|---|---|
| `appsscript.json` | Add-on manifest — declares OAuth scopes + Gmail triggers + the homepage trigger. |
| `Code.gs` | Entry points (`onHomepage`, `onGmailMessage`, action handlers). Pure routing — delegates card construction to `cards.gs`. |
| `cards.gs` | All CardService card builders (homepage, settings, Gmail context). Uses `escapeHtml_` defensively on every user-controlled string. |
| `api.gs` | Thin HTTP client over `/api` using `UrlFetchApp`. Mirrors the VS Code extension's `apiClient`. |
| `auth.gs` | Token storage via `PropertiesService.getUserProperties()` — scoped to the (user, script) pair, encrypted at rest by Google. |
| `.clasp.json.example` | Template for the gitignored `.clasp.json` — paste your scriptId into a copy of this file. |

## What's NOT in this scaffold (yet)

- **Marketplace publishing.** That's a separate ~1-week review process,
  blocked on the `Node2.io` launch trigger from the licensing memory.
  For now, install as a private add-on against your own Google account.
- **Read full email body.** We use the lightweight
  `gmail.addons.current.message.metadata` scope (subject only) instead
  of `gmail.addons.current.message.readonly`. Detecting repo references
  in the subject covers the GitHub-notification-email use case without
  asking for broader inbox access.
- **Multi-org switching.** PropertiesService stores a single URL+token
  pair. If you operate multiple WatchTower installs from one Google
  account, you'd swap the token in the Configure card. Workspace's
  add-on model doesn't make multi-tenancy easy — that's a known
  limitation of the platform, not this scaffold.
- **Calendar / Drive / Sheets surfaces.** The manifest only enables
  Gmail today. Adding Calendar (e.g., "deploy at this time") or Sheets
  ("export deploy metrics") is a small manifest change + new
  contextual-trigger function, but each surface adds a permission
  prompt at install time — keeping the v1 install ask narrow.

## Development

- Edit `.gs` files locally.
- `clasp push` to upload to your Apps Script project.
- Test changes via **Deploy → Test deployments → Install** in the
  Apps Script editor — installing the test version overlays the
  production add-on for your account only.
- Inspect runtime logs at **Executions** inside the editor.
- Apps Script's runtime is V8 with the global `console` available
  for `console.log`; avoid relying on Node-style modules — this is
  not Node.js, it's a sandboxed JavaScript runtime.

## Security notes

- Token storage uses `PropertiesService.getUserProperties()`. Google
  encrypts these at rest and scopes them to the (user, script) tuple
  — no other Apps Script project can read them.
- Every API call goes through `apiHeaders_()` which throws if no
  token is set. There is no "anonymous fallback" path.
- The HTML rendered inside cards is escaped via `escapeHtml_()` on
  every user-controlled string (project names, error messages).
  Card payloads are also sanitised server-side by Google before
  rendering.
- `urlFetchWhitelist` in the manifest is intentionally empty so the
  add-on can talk to any operator-configured URL. If you publish to
  the Marketplace, you must populate this list — but for private
  installs the empty allowlist + the manifest's OAuth scopes are the
  full security surface.
