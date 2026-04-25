import * as vscode from "vscode";
import { createClient } from "./api";
import { ProjectsProvider, ServicesProvider, ProjectItem } from "./treeView";
import { streamDeploymentLogs, showProjectLogs } from "./logs";

let statusBarItem: vscode.StatusBarItem;
let pollingTimer: ReturnType<typeof setInterval> | undefined;

export function activate(context: vscode.ExtensionContext): void {
  const secrets = context.secrets;

  // ── Tree view providers ────────────────────────────────────────────────────
  const projectsProvider = new ProjectsProvider(secrets);
  const servicesProvider = new ServicesProvider(secrets);

  vscode.window.createTreeView("watchtower.projectsView", {
    treeDataProvider: projectsProvider,
    showCollapseAll: false,
  });
  vscode.window.createTreeView("watchtower.servicesView", {
    treeDataProvider: servicesProvider,
    showCollapseAll: false,
  });

  // ── Status bar ────────────────────────────────────────────────────────────
  statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 10);
  statusBarItem.command = "watchtower.openWebUi";
  statusBarItem.show();
  context.subscriptions.push(statusBarItem);

  updateStatusBar(secrets);
  schedulePolling(projectsProvider, servicesProvider, secrets);

  // Watch config changes (e.g. user changes apiUrl) → re-poll immediately
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("watchtower")) {
        updateStatusBar(secrets);
        projectsProvider.refresh();
        servicesProvider.refresh();
        reschedulePolling(projectsProvider, servicesProvider, secrets);
      }
    })
  );

  // ── Command: Set API token ────────────────────────────────────────────────
  context.subscriptions.push(
    vscode.commands.registerCommand("watchtower.setApiToken", async () => {
      const token = await vscode.window.showInputBox({
        title: "WatchTower API Token",
        prompt: "Enter your WatchTower API token",
        password: true,
        placeHolder: "dev-watchtower-token",
      });
      if (token !== undefined) {
        await secrets.store("watchtower.apiToken", token);
        vscode.window.showInformationMessage("WatchTower: API token saved.");
        updateStatusBar(secrets);
        projectsProvider.refresh();
        servicesProvider.refresh();
      }
    })
  );

  // ── Command: Refresh ─────────────────────────────────────────────────────
  context.subscriptions.push(
    vscode.commands.registerCommand("watchtower.refresh", () => {
      projectsProvider.refresh();
      servicesProvider.refresh();
      updateStatusBar(secrets);
    })
  );

  // ── Command: Open web UI ──────────────────────────────────────────────────
  context.subscriptions.push(
    vscode.commands.registerCommand("watchtower.openWebUi", () => {
      const apiUrl = vscode.workspace.getConfiguration("watchtower").get<string>("apiUrl") ?? "http://localhost:8000";
      const webUrl = apiUrl.replace(/\/api$/, "");
      vscode.env.openExternal(vscode.Uri.parse(webUrl));
    })
  );

  // ── Command: Deploy project ───────────────────────────────────────────────
  context.subscriptions.push(
    vscode.commands.registerCommand("watchtower.deployProject", async (item?: ProjectItem) => {
      const project = await resolveProject(item, secrets);
      if (!project) {
        return;
      }

      const confirm = await vscode.window.showWarningMessage(
        `Deploy "${project.name}" now?`,
        { modal: true },
        "Deploy"
      );
      if (confirm !== "Deploy") {
        return;
      }

      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: `WatchTower: Triggering deployment for "${project.name}"…`,
          cancellable: false,
        },
        async () => {
          try {
            const storedToken = await secrets.get("watchtower.apiToken");
            const client = createClient(storedToken);
            const deployment = await client.createDeployment(project.id);
            vscode.window.showInformationMessage(
              `WatchTower: Deployment triggered for "${project.name}".`,
              "Show Logs"
            ).then((choice) => {
              if (choice === "Show Logs") {
                void streamDeploymentLogs(deployment.id, project.name, secrets);
              }
            });
            const openBrowser = vscode.workspace
              .getConfiguration("watchtower")
              .get<boolean>("openBrowserOnDeploy");
            if (openBrowser) {
              vscode.commands.executeCommand("watchtower.openWebUi");
            }
            projectsProvider.refresh();
          } catch (err) {
            vscode.window.showErrorMessage(
              `WatchTower: Deploy failed — ${err instanceof Error ? err.message : String(err)}`
            );
          }
        }
      );
    })
  );

  // ── Command: Show deployment logs ─────────────────────────────────────────
  context.subscriptions.push(
    vscode.commands.registerCommand("watchtower.openProjectLogs", async (item?: ProjectItem) => {
      const project = await resolveProject(item, secrets);
      if (!project) {
        return;
      }
      await showProjectLogs(project.id, project.name, secrets);
    })
  );

  // ── Command: Open project URL in browser ─────────────────────────────────
  context.subscriptions.push(
    vscode.commands.registerCommand("watchtower.openProjectInBrowser", async (item?: ProjectItem) => {
      const project = await resolveProject(item, secrets);
      if (!project) {
        return;
      }
      if (!project.url) {
        vscode.window.showWarningMessage(`WatchTower: No URL configured for "${project.name}".`);
        return;
      }
      vscode.env.openExternal(vscode.Uri.parse(project.url));
    })
  );

  // ── Command: Copy project ID ───────────────────────────────────────────────
  context.subscriptions.push(
    vscode.commands.registerCommand("watchtower.copyProjectId", async (item?: ProjectItem) => {
      const project = await resolveProject(item, secrets);
      if (!project) {
        return;
      }
      await vscode.env.clipboard.writeText(project.id);
      vscode.window.showInformationMessage(`Copied project ID: ${project.id}`);
    })
  );

  // ── Command: Rollback ─────────────────────────────────────────────────────
  context.subscriptions.push(
    vscode.commands.registerCommand("watchtower.rollbackDeployment", async (item?: ProjectItem) => {
      const project = await resolveProject(item, secrets);
      if (!project) {
        return;
      }

      try {
        const storedToken = await secrets.get("watchtower.apiToken");
        const client = createClient(storedToken);
        const deployments = await client.listDeployments(project.id);
        if (deployments.length < 2) {
          vscode.window.showWarningMessage(`WatchTower: No previous deployment to roll back to for "${project.name}".`);
          return;
        }

        // The 2nd entry is the previous deployment
        const prevDeployment = deployments[1];
        const confirm = await vscode.window.showWarningMessage(
          `Roll back "${project.name}" to deployment from ${new Date(prevDeployment.created_at).toLocaleString()}?`,
          { modal: true },
          "Rollback"
        );
        if (confirm !== "Rollback") {
          return;
        }

        await client.rollbackDeployment(prevDeployment.id);
        vscode.window.showInformationMessage(`WatchTower: Rollback triggered for "${project.name}".`);
        projectsProvider.refresh();
      } catch (err) {
        vscode.window.showErrorMessage(
          `WatchTower: Rollback failed — ${err instanceof Error ? err.message : String(err)}`
        );
      }
    })
  );

  // ── Command: Open project folder in VS Code (via server API) ─────────────
  context.subscriptions.push(
    vscode.commands.registerCommand("watchtower.openInVscode", async (item?: ProjectItem) => {
      const project = await resolveProject(item, secrets);
      if (!project) {
        return;
      }

      if (project.local_path) {
        const uri = vscode.Uri.file(project.local_path);
        await vscode.commands.executeCommand("vscode.openFolder", uri, { forceNewWindow: false });
      } else if (project.repo_url) {
        // Deep-link clone
        const cloneUrl = `vscode://vscode.git/clone?url=${encodeURIComponent(project.repo_url)}`;
        vscode.env.openExternal(vscode.Uri.parse(cloneUrl));
      } else {
        vscode.window.showWarningMessage(`WatchTower: No local path or repo URL set for "${project.name}".`);
      }
    })
  );
}

export function deactivate(): void {
  if (pollingTimer !== undefined) {
    clearInterval(pollingTimer);
  }
}

// ─────────────────────────────────────────────────────────────────── Helpers ─

async function updateStatusBar(secrets: vscode.SecretStorage): Promise<void> {
  try {
    const storedToken = await secrets.get("watchtower.apiToken");
    const client = createClient(storedToken);
    await client.runtimeStatus();
    statusBarItem.text = "$(watchtower-icon) WatchTower $(check)";
    statusBarItem.tooltip = "WatchTower is online — click to open web UI";
    statusBarItem.backgroundColor = undefined;
  } catch {
    statusBarItem.text = "$(watchtower-icon) WatchTower $(warning)";
    statusBarItem.tooltip = "Cannot reach WatchTower API — check your apiUrl setting";
    statusBarItem.backgroundColor = new vscode.ThemeColor("statusBarItem.warningBackground");
  }
}

function schedulePolling(
  projects: ProjectsProvider,
  services: ServicesProvider,
  secrets: vscode.SecretStorage
): void {
  const interval = (vscode.workspace.getConfiguration("watchtower").get<number>("pollIntervalSeconds") ?? 30) * 1000;
  pollingTimer = setInterval(() => {
    projects.refresh();
    services.refresh();
    void updateStatusBar(secrets);
  }, interval);
}

function reschedulePolling(
  projects: ProjectsProvider,
  services: ServicesProvider,
  secrets: vscode.SecretStorage
): void {
  if (pollingTimer !== undefined) {
    clearInterval(pollingTimer);
  }
  schedulePolling(projects, services, secrets);
}

async function resolveProject(
  item: ProjectItem | undefined,
  secrets: vscode.SecretStorage
): Promise<{ id: string; name: string; url: string | null; local_path: string | null; repo_url: string | null } | undefined> {
  if (item?.project) {
    return item.project;
  }

  // Called from command palette — ask user to pick
  try {
    const storedToken = await secrets.get("watchtower.apiToken");
    const client = createClient(storedToken);
    const projects = await client.listProjects();

    if (projects.length === 0) {
      vscode.window.showInformationMessage("WatchTower: No projects found.");
      return undefined;
    }

    const picked = await vscode.window.showQuickPick(
      projects.map((p) => ({ label: p.name, description: p.status ?? "", project: p })),
      { placeHolder: "Select a WatchTower project" }
    );
    return picked?.project;
  } catch {
    vscode.window.showErrorMessage("WatchTower: Could not load project list — check your connection settings.");
    return undefined;
  }
}
