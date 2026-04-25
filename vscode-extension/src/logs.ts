import * as vscode from "vscode";
import { createClient, WtDeployment } from "./api";

const OUTPUT_CHANNEL_LABEL = "WatchTower Deployments";

let outputChannel: vscode.OutputChannel | undefined;

function getOutputChannel(): vscode.OutputChannel {
  if (!outputChannel) {
    outputChannel = vscode.window.createOutputChannel(OUTPUT_CHANNEL_LABEL);
  }
  return outputChannel;
}

/** Poll a deployment until it finishes, streaming logs to the output channel. */
export async function streamDeploymentLogs(
  deploymentId: string,
  projectName: string,
  secretStorage: vscode.SecretStorage
): Promise<void> {
  const channel = getOutputChannel();
  channel.show(true);
  channel.appendLine(`\n${"─".repeat(60)}`);
  channel.appendLine(`[WatchTower] Deployment started for "${projectName}"`);
  channel.appendLine(`[WatchTower] Deployment ID: ${deploymentId}`);
  channel.appendLine(`${"─".repeat(60)}\n`);

  const storedToken = await secretStorage.get("watchtower.apiToken");
  const client = createClient(storedToken);

  let lastLogLength = 0;
  let done = false;
  const maxPolls = 120; // 2 minutes at 1-second intervals
  let polls = 0;

  while (!done && polls < maxPolls) {
    polls++;
    await sleep(2000);

    try {
      const deployment = await client.getDeployment(deploymentId);
      const logs = deployment.logs ?? "";

      // Print any new log content since last poll
      if (logs.length > lastLogLength) {
        const newContent = logs.slice(lastLogLength);
        channel.append(newContent);
        lastLogLength = logs.length;
      }

      const terminalStatuses = ["success", "failed", "error", "cancelled", "complete", "completed"];
      if (terminalStatuses.includes(deployment.status.toLowerCase())) {
        done = true;
        const icon = deployment.status.toLowerCase().includes("fail") || deployment.status.toLowerCase().includes("error") ? "✗" : "✓";
        channel.appendLine(`\n${"─".repeat(60)}`);
        channel.appendLine(`[WatchTower] ${icon} Deployment ${deployment.status.toUpperCase()}`);
        if (deployment.finished_at) {
          channel.appendLine(`[WatchTower] Finished at: ${new Date(deployment.finished_at).toLocaleString()}`);
        }
        channel.appendLine(`${"─".repeat(60)}\n`);
      }
    } catch (err) {
      channel.appendLine(`[WatchTower] Error fetching logs: ${err instanceof Error ? err.message : String(err)}`);
      done = true;
    }
  }

  if (!done) {
    channel.appendLine(`[WatchTower] Stopped polling after ${maxPolls} attempts. Check the web UI for final status.`);
  }
}

/** Show all logs for the most recent deployment of a project. */
export async function showProjectLogs(
  projectId: string,
  projectName: string,
  secretStorage: vscode.SecretStorage
): Promise<void> {
  const channel = getOutputChannel();
  channel.show(true);

  try {
    const storedToken = await secretStorage.get("watchtower.apiToken");
    const client = createClient(storedToken);
    const deployments = await client.listDeployments(projectId);

    if (deployments.length === 0) {
      channel.appendLine(`[WatchTower] No deployments found for "${projectName}".`);
      return;
    }

    // Most recent first (API returns in descending order)
    const latest: WtDeployment = deployments[0];
    channel.appendLine(`\n${"─".repeat(60)}`);
    channel.appendLine(`[WatchTower] Latest deployment for "${projectName}"`);
    channel.appendLine(`[WatchTower] ID: ${latest.id}  Status: ${latest.status.toUpperCase()}`);
    channel.appendLine(`[WatchTower] Started: ${new Date(latest.created_at).toLocaleString()}`);
    if (latest.finished_at) {
      channel.appendLine(`[WatchTower] Finished: ${new Date(latest.finished_at).toLocaleString()}`);
    }
    if (latest.commit_sha) {
      channel.appendLine(`[WatchTower] Commit: ${latest.commit_sha}`);
    }
    channel.appendLine(`${"─".repeat(60)}\n`);
    channel.appendLine(latest.logs ?? "(no logs available)");
    channel.appendLine("");
  } catch (err) {
    channel.appendLine(`[WatchTower] Failed to fetch logs: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
