import * as vscode from "vscode";
import { createClient, WtProject, WtIntegrationsStatus } from "./api";

// ─────────────────────────────────────────────────────────── Projects tree ──

export class ProjectsProvider implements vscode.TreeDataProvider<ProjectItem | ErrorItem> {
  private _onDidChangeTreeData = new vscode.EventEmitter<ProjectItem | ErrorItem | undefined | null | void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private projects: WtProject[] = [];
  private loading = false;
  private error: string | null = null;

  constructor(private secretStorage: vscode.SecretStorage) {}

  refresh(): void {
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(element: ProjectItem | ErrorItem): vscode.TreeItem {
    return element;
  }

  async getChildren(element?: ProjectItem | ErrorItem): Promise<(ProjectItem | ErrorItem)[]> {
    if (element) {
      return [];
    }

    this.loading = true;
    this.error = null;

    try {
      const storedToken = await this.secretStorage.get("watchtower.apiToken");
      const client = createClient(storedToken);
      this.projects = await client.listProjects();
      this.loading = false;
      return this.projects.map((p) => new ProjectItem(p));
    } catch (err) {
      this.loading = false;
      this.error = err instanceof Error ? err.message : String(err);
      return [new ErrorItem(this.error)];
    }
  }

  getProject(id: string): WtProject | undefined {
    return this.projects.find((p) => p.id === id);
  }
}

export class ProjectItem extends vscode.TreeItem {
  constructor(public readonly project: WtProject) {
    super(project.name, vscode.TreeItemCollapsibleState.None);

    this.contextValue = "watchtowerProject";
    this.description = project.status ?? "";
    this.tooltip = [
      `Name: ${project.name}`,
      project.repo_url ? `Repo: ${project.repo_url}` : null,
      project.local_path ? `Path: ${project.local_path}` : null,
      project.last_deployed_at ? `Last deploy: ${new Date(project.last_deployed_at).toLocaleString()}` : null,
      project.url ? `URL: ${project.url}` : null,
    ]
      .filter(Boolean)
      .join("\n");

    this.iconPath = statusIcon(project.status);
  }
}

class ErrorItem extends vscode.TreeItem {
  constructor(message: string) {
    super("Failed to load projects", vscode.TreeItemCollapsibleState.None);
    this.description = message;
    this.iconPath = new vscode.ThemeIcon("error", new vscode.ThemeColor("errorForeground"));
  }
}

// ───────────────────────────────────────────────── Services/integrations tree

export class ServicesProvider implements vscode.TreeDataProvider<ServiceItem> {
  private _onDidChangeTreeData = new vscode.EventEmitter<ServiceItem | undefined | null | void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  constructor(private secretStorage: vscode.SecretStorage) {}

  refresh(): void {
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(element: ServiceItem): vscode.TreeItem {
    return element;
  }

  async getChildren(element?: ServiceItem): Promise<ServiceItem[]> {
    if (element) {
      return [];
    }

    try {
      const storedToken = await this.secretStorage.get("watchtower.apiToken");
      const client = createClient(storedToken);
      const status = await client.integrationsStatus();
      return statusToItems(status);
    } catch {
      return [new ServiceItem("Could not reach WatchTower API", "error", false)];
    }
  }
}

export class ServiceItem extends vscode.TreeItem {
  constructor(label: string, readonly serviceName: string, installed: boolean, detail?: string) {
    super(label, vscode.TreeItemCollapsibleState.None);
    this.description = detail ?? "";
    this.iconPath = installed
      ? new vscode.ThemeIcon("check", new vscode.ThemeColor("testing.iconPassed"))
      : new vscode.ThemeIcon("circle-slash", new vscode.ThemeColor("disabledForeground"));
  }
}

function statusToItems(s: WtIntegrationsStatus): ServiceItem[] {
  const items: ServiceItem[] = [];

  if (s.docker) {
    items.push(
      new ServiceItem(
        "Docker / Podman",
        "docker",
        s.docker.installed,
        s.docker.installed ? `${s.docker.running_containers} running` : "not installed"
      )
    );
  }
  if (s.tailscale) {
    items.push(
      new ServiceItem(
        "Tailscale",
        "tailscale",
        s.tailscale.installed,
        s.tailscale.connected ? `connected · ${s.tailscale.ip}` : "not connected"
      )
    );
  }
  if (s.cloudflared) {
    items.push(
      new ServiceItem(
        "Cloudflare Tunnel",
        "cloudflared",
        s.cloudflared.installed,
        s.cloudflared.authenticated ? `${s.cloudflared.tunnels.length} tunnel(s)` : "not authenticated"
      )
    );
  }
  if (s.nginx) {
    items.push(
      new ServiceItem("Nginx", "nginx", s.nginx.installed, s.nginx.running ? "running" : s.nginx.installed ? "stopped" : "not installed")
    );
  }
  if (s.coolify) {
    items.push(new ServiceItem("Coolify", "coolify", s.coolify.installed, s.coolify.version ?? ""));
  }

  return items.length > 0 ? items : [new ServiceItem("No integrations detected", "none", false)];
}

// ─────────────────────────────────────────────────────────────────── Helpers ─

function statusIcon(status: string | null): vscode.ThemeIcon {
  switch (status?.toLowerCase()) {
    case "running":
    case "active":
    case "deployed":
      return new vscode.ThemeIcon("circle-filled", new vscode.ThemeColor("testing.iconPassed"));
    case "failed":
    case "error":
      return new vscode.ThemeIcon("error", new vscode.ThemeColor("testing.iconFailed"));
    case "building":
    case "deploying":
      return new vscode.ThemeIcon("loading~spin");
    case "stopped":
      return new vscode.ThemeIcon("circle-slash", new vscode.ThemeColor("disabledForeground"));
    default:
      return new vscode.ThemeIcon("circle-outline");
  }
}
