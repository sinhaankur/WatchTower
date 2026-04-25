import * as vscode from "vscode";

export interface WtProject {
  id: string;
  name: string;
  repo_url: string | null;
  local_path: string | null;
  branch: string | null;
  status: string | null;
  last_deployed_at: string | null;
  url: string | null;
}

export interface WtDeployment {
  id: string;
  project_id: string;
  status: string;
  created_at: string;
  finished_at: string | null;
  logs: string | null;
  commit_sha: string | null;
}

export interface WtIntegrationsStatus {
  docker?: { installed: boolean; version: string | null; running_containers: number };
  podman?: { installed: boolean; version: string | null; running_containers: number };
  tailscale?: { installed: boolean; connected: boolean; ip: string | null };
  cloudflared?: { installed: boolean; authenticated: boolean; tunnels: { id: string; name: string; status: string }[] };
  nginx?: { installed: boolean; running: boolean };
  coolify?: { installed: boolean; version: string | null };
}

export interface WtAuthStatus {
  api_token: { configured: boolean };
  oauth: { github_configured: boolean };
  dev_auth: { allow_insecure: boolean };
}

export interface WtContext {
  user: { id: string; email: string; name: string };
  organization: { id: string; name: string };
  membership: { role: string };
}

class WatchTowerApiClient {
  private apiUrl: string;
  private token: string;

  constructor(apiUrl: string, token: string) {
    this.apiUrl = apiUrl.replace(/\/$/, "");
    this.token = token;
  }

  private async fetch<T>(path: string, options?: RequestInit): Promise<T> {
    const url = `${this.apiUrl}${path}`;
    const response = await fetch(url, {
      ...options,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.token}`,
        ...(options?.headers ?? {}),
      },
    });
    if (!response.ok) {
      throw new Error(`WatchTower API error ${response.status}: ${response.statusText} (${path})`);
    }
    return response.json() as Promise<T>;
  }

  async authStatus(): Promise<WtAuthStatus> {
    return this.fetch<WtAuthStatus>("/api/auth/status");
  }

  async context(): Promise<WtContext> {
    return this.fetch<WtContext>("/api/context");
  }

  async listProjects(): Promise<WtProject[]> {
    return this.fetch<WtProject[]>("/api/projects");
  }

  async getProject(id: string): Promise<WtProject> {
    return this.fetch<WtProject>(`/api/projects/${id}`);
  }

  async createDeployment(projectId: string): Promise<WtDeployment> {
    return this.fetch<WtDeployment>(`/api/projects/${projectId}/deployments`, {
      method: "POST",
      body: JSON.stringify({ trigger: "manual" }),
    });
  }

  async listDeployments(projectId: string): Promise<WtDeployment[]> {
    return this.fetch<WtDeployment[]>(`/api/projects/${projectId}/deployments`);
  }

  async getDeployment(deploymentId: string): Promise<WtDeployment> {
    return this.fetch<WtDeployment>(`/api/deployments/${deploymentId}`);
  }

  async rollbackDeployment(deploymentId: string): Promise<WtDeployment> {
    return this.fetch<WtDeployment>(`/api/deployments/${deploymentId}/rollback`, {
      method: "POST",
    });
  }

  async integrationsStatus(): Promise<WtIntegrationsStatus> {
    return this.fetch<WtIntegrationsStatus>("/api/runtime/integrations/status");
  }

  async runtimeStatus(): Promise<{ status: string; version: string }> {
    return this.fetch<{ status: string; version: string }>("/api/runtime/status");
  }

  async openInVscode(rootDir: string): Promise<{ success: boolean; message: string }> {
    return this.fetch<{ success: boolean; message: string }>(
      "/api/runtime/integrations/vscode/open",
      { method: "POST", body: JSON.stringify({ root_dir: rootDir }) }
    );
  }
}

/** Returns a client from current VS Code configuration. */
export function createClient(secretToken?: string): WatchTowerApiClient {
  const config = vscode.workspace.getConfiguration("watchtower");
  const apiUrl = config.get<string>("apiUrl") ?? "http://localhost:8000";
  const token = secretToken ?? config.get<string>("apiToken") ?? "";
  return new WatchTowerApiClient(apiUrl, token);
}

export { WatchTowerApiClient };
