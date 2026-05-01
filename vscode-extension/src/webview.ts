/**
 * WatchTower dashboard inside a VS Code WebviewPanel.
 *
 * Why this exists: the SPA (deploy, diagnose, auto-apply, backup,
 * settings, audit log, etc) is the place where most autonomous-ops
 * actions happen. Forcing the user to switch out to a browser to
 * touch any of them breaks flow. With this command, the entire
 * WatchTower dashboard renders in a side-tab inside VS Code, signed
 * in, with no extra credentials needed.
 *
 * Auth handoff: we read the API token from VS Code's SecretStorage
 * and pass it on the iframe URL via the `?wt_token=...` query param.
 * `web/src/main.tsx` has a one-shot bootstrap that pops the param
 * off the URL and persists it to localStorage before React mounts —
 * so the apiClient's existing token-resolution path (localStorage →
 * VITE_API_TOKEN → dev fallback) just works inside the webview.
 *
 * The token is stripped from the URL after persisting so it doesn't
 * leak into history / referrer headers / screenshots. If the user
 * resets VS Code or rebuilds the webview, the token is re-injected
 * fresh.
 *
 * One panel per workspace — repeated invocations of the command
 * focus the existing panel rather than spawning duplicates.
 */
import * as vscode from "vscode";

let activePanel: vscode.WebviewPanel | undefined;

export async function openDashboard(
  context: vscode.ExtensionContext,
  secrets: vscode.SecretStorage
): Promise<void> {
  // Refocus existing panel rather than spawning a duplicate.
  if (activePanel) {
    activePanel.reveal(vscode.ViewColumn.Active);
    return;
  }

  const apiUrl =
    vscode.workspace.getConfiguration("watchtower").get<string>("apiUrl") ??
    "http://localhost:8000";
  const baseUrl = apiUrl.replace(/\/api\/?$/, "").replace(/\/+$/, "");

  const token = await secrets.get("watchtower.apiToken");
  if (!token) {
    const choice = await vscode.window.showWarningMessage(
      "WatchTower: API token not set. The dashboard needs a token to sign in.",
      "Set Token",
      "Cancel"
    );
    if (choice === "Set Token") {
      await vscode.commands.executeCommand("watchtower.setApiToken");
    }
    return;
  }

  const dashboardUrl = `${baseUrl}/?wt_token=${encodeURIComponent(token)}`;

  const panel = vscode.window.createWebviewPanel(
    "watchtower.dashboard",
    "WatchTower",
    vscode.ViewColumn.Active,
    {
      enableScripts: true,
      retainContextWhenHidden: true,
      // Allow the iframe to load the WatchTower API origin. Without
      // this VS Code's default CSP blocks the iframe load.
      localResourceRoots: [],
    }
  );

  // Track the panel so a second openDashboard invocation re-focuses
  // instead of duplicating. Cleared on dispose.
  activePanel = panel;
  panel.onDidDispose(
    () => {
      activePanel = undefined;
    },
    null,
    context.subscriptions
  );

  // Refresh icon in the editor title bar (built-in VS Code icon).
  panel.iconPath = vscode.Uri.parse(
    "https://raw.githubusercontent.com/sinhaankur/WatchTower/main/desktop/assets/wt-logo.svg"
  );

  panel.webview.html = renderHtml(dashboardUrl, baseUrl);
}

function renderHtml(dashboardUrl: string, baseUrl: string): string {
  // CSP: explicitly allow the WatchTower origin in frame-src and
  // connect-src so the iframe loads and the SPA can talk back to the
  // API. Everything else stays default-deny.
  //
  // 'unsafe-inline' on style-src is needed because the embedder div
  // uses inline styles for the layout — we don't ship a stylesheet
  // for a single-element page.
  const csp = [
    "default-src 'none'",
    `frame-src ${baseUrl}`,
    `connect-src ${baseUrl}`,
    "style-src 'unsafe-inline'",
    "script-src 'unsafe-inline'",
  ].join("; ");

  // The iframe takes the full panel. The fallback link gives the user
  // an escape hatch if the WatchTower backend isn't reachable for
  // some reason (firewall, backend down, wrong apiUrl).
  return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta http-equiv="Content-Security-Policy" content="${csp}" />
    <title>WatchTower</title>
    <style>
      html, body, iframe {
        margin: 0;
        padding: 0;
        height: 100%;
        width: 100%;
        border: 0;
        background: #fbf6ea;
        color: #0f172a;
        font-family: system-ui, -apple-system, "Segoe UI", sans-serif;
      }
      .fallback {
        position: absolute;
        inset: 0;
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        gap: 8px;
        padding: 24px;
        text-align: center;
      }
      .fallback small { color: #64748b; }
      .fallback a {
        color: #b91c1c;
        font-weight: 600;
        text-decoration: none;
      }
    </style>
  </head>
  <body>
    <iframe src="${dashboardUrl}" sandbox="allow-scripts allow-same-origin allow-popups allow-forms allow-downloads"></iframe>
    <noscript>
      <div class="fallback">
        <p>WatchTower needs JavaScript to run.</p>
        <a href="${baseUrl}">Open in browser</a>
      </div>
    </noscript>
  </body>
</html>`;
}
