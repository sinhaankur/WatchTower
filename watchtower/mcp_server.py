"""WatchTower MCP server — exposes the deploy control plane to any
MCP-aware client (Claude Desktop, Cursor, etc.) over stdio.

Architectural choice: **thin HTTP client over the existing /api surface**,
not direct DB access. Every tool call goes through the same auth, RBAC,
audit-log, and rate-limit middleware the SPA + VS Code extension already
use — so adding a new transport doesn't create a new privilege escalation
path. The MCP server inherits whatever the configured API token can do,
nothing more.

Config (env vars on the spawned process):
    WATCHTOWER_API_BASE_URL   default http://127.0.0.1:8000
    WATCHTOWER_API_TOKEN      required — same token shape used everywhere else
    WATCHTOWER_AGENT_READONLY when "true", strips write tools from the
                              list AND re-checks at dispatch time (matches
                              the in-process agent's defence-in-depth)

Installed as a console script via pyproject:
    watchtower-mcp        # binds stdio; spawned by the MCP client

Claude Desktop config snippet:
    {
      "mcpServers": {
        "watchtower": {
          "command": "watchtower-mcp",
          "env": {
            "WATCHTOWER_API_BASE_URL": "http://localhost:8000",
            "WATCHTOWER_API_TOKEN": "<token>"
          }
        }
      }
    }
"""
from __future__ import annotations

import asyncio
import json
import logging
import os
import sys
from typing import Any, Awaitable, Callable

import httpx

logger = logging.getLogger("watchtower.mcp")


# ── Config ──────────────────────────────────────────────────────────────────

def _env_base_url() -> str:
    return os.getenv("WATCHTOWER_API_BASE_URL", "http://127.0.0.1:8000").rstrip("/")


def _env_token() -> str | None:
    token = os.getenv("WATCHTOWER_API_TOKEN", "").strip()
    return token or None


def _is_readonly() -> bool:
    return os.getenv("WATCHTOWER_AGENT_READONLY", "false").strip().lower() == "true"


# ── HTTP client ─────────────────────────────────────────────────────────────


class ApiClient:
    """Synchronous HTTP wrapper around the WatchTower /api surface.

    Returns parsed JSON on success. On any non-2xx, raises ``ApiError``
    with the status code and the detail field if the response was JSON
    (every WatchTower error response uses ``{"detail": "..."}``).
    """

    def __init__(self, base_url: str, token: str, *, timeout: float = 30.0) -> None:
        self._client = httpx.Client(
            base_url=base_url,
            timeout=timeout,
            headers={
                "Authorization": f"Bearer {token}",
                "Accept": "application/json",
                "User-Agent": "watchtower-mcp/1",
            },
        )

    def close(self) -> None:
        self._client.close()

    def request(self, method: str, path: str, *, json_body: Any = None) -> Any:
        resp = self._client.request(method, path, json=json_body)
        if resp.status_code >= 400:
            detail = _extract_detail(resp)
            raise ApiError(resp.status_code, detail)
        if not resp.content:
            return None
        ctype = resp.headers.get("content-type", "")
        if "application/json" in ctype:
            return resp.json()
        return resp.text

    # Convenience aliases — easier to read at call sites.
    def get(self, path: str) -> Any:
        return self.request("GET", path)

    def post(self, path: str, json_body: Any = None) -> Any:
        return self.request("POST", path, json_body=json_body)

    def put(self, path: str, json_body: Any = None) -> Any:
        return self.request("PUT", path, json_body=json_body)


class ApiError(Exception):
    """Surface API failures with the operator-facing detail intact so
    the MCP client (and therefore the LLM) sees actionable error text,
    not a generic 5xx."""

    def __init__(self, status: int, detail: str) -> None:
        super().__init__(f"HTTP {status}: {detail}")
        self.status = status
        self.detail = detail


def _extract_detail(resp: httpx.Response) -> str:
    try:
        body = resp.json()
        if isinstance(body, dict) and "detail" in body:
            return str(body["detail"])
        return json.dumps(body)
    except Exception:
        return resp.text or f"<no body, status {resp.status_code}>"


# ── Tool definitions ────────────────────────────────────────────────────────
#
# Mirrors the OpenAI-format tool list in watchtower/api/agent.py but
# rewritten in MCP's tool shape. Kept as plain dicts (rather than
# mcp.types.Tool instances at module level) so the schemas can be
# unit-tested without importing the mcp SDK.

READ_TOOL_SCHEMAS: list[dict[str, Any]] = [
    {
        "name": "list_projects",
        "description": "List every WatchTower project the configured token can access.",
        "inputSchema": {"type": "object", "properties": {}, "additionalProperties": False},
    },
    {
        "name": "get_project",
        "description": "Fetch one project's full details (repo, branch, use case, Phase 1+2+3 settings).",
        "inputSchema": {
            "type": "object",
            "properties": {"project_id": {"type": "string", "description": "UUID of the project."}},
            "required": ["project_id"],
            "additionalProperties": False,
        },
    },
    {
        "name": "list_deployments",
        "description": "List the most recent deployments for a project, newest first.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "project_id": {"type": "string"},
                "limit": {"type": "integer", "default": 10, "minimum": 1, "maximum": 50},
            },
            "required": ["project_id"],
            "additionalProperties": False,
        },
    },
    {
        "name": "get_deployment",
        "description": "Fetch one deployment's status, branch, commit, and timestamps.",
        "inputSchema": {
            "type": "object",
            "properties": {"deployment_id": {"type": "string"}},
            "required": ["deployment_id"],
            "additionalProperties": False,
        },
    },
    {
        "name": "view_build_logs",
        "description": (
            "Fetch the build output for a deployment's most recent build. Returns the tail "
            "when the full log would exceed the model's context window."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {"deployment_id": {"type": "string"}},
            "required": ["deployment_id"],
            "additionalProperties": False,
        },
    },
    {
        "name": "list_nodes",
        "description": "List deployment target nodes for the project's organization.",
        "inputSchema": {
            "type": "object",
            "properties": {"project_id": {"type": "string", "description": "UUID of any project in the org — used to resolve the org."}},
            "required": ["project_id"],
            "additionalProperties": False,
        },
    },
    {
        "name": "list_domains",
        "description": "List CustomDomain rows configured for a project — useful before adding a new one or checking DNS sync status.",
        "inputSchema": {
            "type": "object",
            "properties": {"project_id": {"type": "string"}},
            "required": ["project_id"],
            "additionalProperties": False,
        },
    },
    {
        "name": "list_cloudflare_credentials",
        "description": "List Cloudflare credentials configured for the caller's organization. Returns the credential_id you'll need for sync_domain_dns.",
        "inputSchema": {"type": "object", "properties": {}, "additionalProperties": False},
    },
    {
        "name": "get_autonomous_status",
        "description": (
            "Inspect the live in-memory probe state for a project — consecutive "
            "failures per (project, node) pair, last probe time, quarantine status. "
            "Use after enabling autonomous mode to confirm the tick is running."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {"project_id": {"type": "string"}},
            "required": ["project_id"],
            "additionalProperties": False,
        },
    },
    {
        "name": "list_cloud_provider_regions",
        "description": (
            "List the regions/datacenters available under a saved cloud provider "
            "credential (DigitalOcean or Hetzner). Call this before provision_node "
            "so you can pick a valid region id."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {"credential_id": {"type": "string"}},
            "required": ["credential_id"],
            "additionalProperties": False,
        },
    },
    {
        "name": "list_cloud_provider_sizes",
        "description": (
            "List the VM sizes offered in the given region for a saved cloud "
            "provider credential. Returns id, vcpus, memory_gb, and monthly_usd "
            "(when the provider reports it) sorted cheapest-first."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "credential_id": {"type": "string"},
                "region": {"type": "string"},
            },
            "required": ["credential_id", "region"],
            "additionalProperties": False,
        },
    },
    {
        "name": "get_provisioning_job",
        "description": (
            "Poll the status of an in-flight or completed provision job. Returns "
            "the current state-machine status, any error, the assigned public IP "
            "once the VM is ready, and node_id once registered."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {"job_id": {"type": "string"}},
            "required": ["job_id"],
            "additionalProperties": False,
        },
    },
    {
        "name": "list_provisioning_jobs",
        "description": (
            "List recent provision jobs for the caller's organization, newest first."
        ),
        "inputSchema": {"type": "object", "properties": {}, "additionalProperties": False},
    },
]

WRITE_TOOL_SCHEMAS: list[dict[str, Any]] = [
    {
        "name": "trigger_deployment",
        "description": (
            "Queue a new deployment for a project. Uses the project's configured branch unless "
            "overridden. Disabled when WATCHTOWER_AGENT_READONLY=true."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "project_id": {"type": "string"},
                "branch": {"type": "string", "description": "Optional branch override."},
            },
            "required": ["project_id"],
            "additionalProperties": False,
        },
    },
    {
        "name": "set_run_as_container",
        "description": (
            "Toggle Phase 1 of autonomous deploy — when enabled, future deploys wrap "
            "the artifact in a Podman container on the remote (nginx:alpine for static "
            "sites). Requires the project to have a recommended_port set."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "project_id": {"type": "string"},
                "enabled": {"type": "boolean"},
            },
            "required": ["project_id", "enabled"],
            "additionalProperties": False,
        },
    },
    {
        "name": "set_autonomous_mode",
        "description": (
            "Toggle Phase 4 — when enabled, the WatchTower API probes the project's "
            "container every minute, restarts on transient failure, and auto-rolls "
            "back to the previous LIVE deployment after 3 consecutive probe failures. "
            "Requires run_as_container=True; the API rejects the toggle otherwise."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "project_id": {"type": "string"},
                "enabled": {"type": "boolean"},
            },
            "required": ["project_id", "enabled"],
            "additionalProperties": False,
        },
    },
    {
        "name": "add_custom_domain",
        "description": (
            "Add a CustomDomain row to a project — Phase 2 will write an nginx server block "
            "for this hostname on the next deploy. Doesn't touch DNS; use sync_domain_dns "
            "after for managed-DNS via Cloudflare."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "project_id": {"type": "string"},
                "domain": {"type": "string", "description": "Fully-qualified hostname (e.g. site.example.com)."},
            },
            "required": ["project_id", "domain"],
            "additionalProperties": False,
        },
    },
    {
        "name": "sync_domain_dns",
        "description": (
            "Force a Cloudflare A-record refresh for a CustomDomain — same call the post-deploy "
            "hook makes. Use list_cloudflare_credentials first to discover credential_id, then "
            "list_nodes to pick target_ip. Idempotent."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "project_id": {"type": "string"},
                "domain_id": {"type": "string"},
                "credential_id": {"type": "string"},
                "target_ip": {"type": "string", "description": "IPv4 the A record should point at — usually the node's public IP."},
                "proxied": {"type": "boolean", "default": False, "description": "Cloudflare orange-cloud proxy. Phase 3 defaults to false."},
            },
            "required": ["project_id", "domain_id", "credential_id", "target_ip"],
            "additionalProperties": False,
        },
    },
    {
        "name": "provision_node",
        "description": (
            "Phase 5: create a fresh VM on DigitalOcean or Hetzner using a saved "
            "credential, install Podman+nginx, and register it as a deploy node. "
            "Returns the ProvisioningJob — poll with get_provisioning_job until "
            "status='registered' (success) or 'failed'."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "credential_id": {"type": "string", "description": "From list_cloud_provider_credentials."},
                "name": {"type": "string", "description": "Hostname-safe name (alphanumeric + hyphen/underscore)."},
                "region": {"type": "string", "description": "From list_cloud_provider_regions."},
                "size": {"type": "string", "description": "From list_cloud_provider_sizes."},
            },
            "required": ["credential_id", "name", "region", "size"],
            "additionalProperties": False,
        },
    },
]


def list_tool_schemas() -> list[dict[str, Any]]:
    """The full visible tool list, gated by readonly mode."""
    if _is_readonly():
        return list(READ_TOOL_SCHEMAS)
    return list(READ_TOOL_SCHEMAS) + list(WRITE_TOOL_SCHEMAS)


_WRITE_TOOL_NAMES = {t["name"] for t in WRITE_TOOL_SCHEMAS}


# ── Tool dispatch ───────────────────────────────────────────────────────────


def _ok(payload: Any) -> str:
    return json.dumps(payload, default=str)


def _err(msg: str) -> str:
    return json.dumps({"error": msg})


def _tool_list_projects(client: ApiClient, args: dict[str, Any]) -> str:
    return _ok(client.get("/api/projects"))


def _tool_get_project(client: ApiClient, args: dict[str, Any]) -> str:
    return _ok(client.get(f"/api/projects/{args['project_id']}"))


def _tool_list_deployments(client: ApiClient, args: dict[str, Any]) -> str:
    limit = max(1, min(int(args.get("limit", 10)), 50))
    data = client.get(f"/api/projects/{args['project_id']}/deployments")
    return _ok(data[:limit] if isinstance(data, list) else data)


def _tool_get_deployment(client: ApiClient, args: dict[str, Any]) -> str:
    return _ok(client.get(f"/api/deployments/{args['deployment_id']}"))


def _tool_view_build_logs(client: ApiClient, args: dict[str, Any]) -> str:
    # Logs live under the deployment's build record. We look up the
    # deployment first because the build_id isn't in the MCP request —
    # the LLM only knows the deployment ID. One extra round-trip vs
    # adding a build-lookup tool the model has to chain.
    dep = client.get(f"/api/deployments/{args['deployment_id']}")
    build_id = (dep or {}).get("build_id") or (dep or {}).get("latest_build_id")
    if not build_id:
        # Some deployments expose builds via a list endpoint instead.
        builds = client.get(f"/api/deployments/{args['deployment_id']}/builds")
        if isinstance(builds, list) and builds:
            build_id = builds[0].get("id")
    if not build_id:
        return _err("No build has run for this deployment yet.")
    return _ok(client.get(f"/api/builds/{build_id}"))


def _tool_list_nodes(client: ApiClient, args: dict[str, Any]) -> str:
    project = client.get(f"/api/projects/{args['project_id']}")
    org_id = (project or {}).get("org_id")
    if not org_id:
        return _err("Project has no org_id — can't resolve nodes.")
    return _ok(client.get(f"/api/orgs/{org_id}/nodes"))


def _tool_list_domains(client: ApiClient, args: dict[str, Any]) -> str:
    return _ok(client.get(f"/api/projects/{args['project_id']}/domains"))


def _tool_list_cloudflare_credentials(client: ApiClient, args: dict[str, Any]) -> str:
    return _ok(client.get("/api/integrations/cloudflare"))


def _tool_trigger_deployment(client: ApiClient, args: dict[str, Any]) -> str:
    body: dict[str, Any] = {}
    if "branch" in args and args["branch"]:
        body["branch"] = args["branch"]
    else:
        # The API requires a branch; pull the project's default if the
        # caller didn't pin one. Saves the LLM a round-trip when it
        # just wants "deploy whatever's current."
        project = client.get(f"/api/projects/{args['project_id']}")
        body["branch"] = (project or {}).get("repo_branch") or "main"
    return _ok(client.post(f"/api/projects/{args['project_id']}/deployments", json_body=body))


def _tool_set_run_as_container(client: ApiClient, args: dict[str, Any]) -> str:
    return _ok(client.put(
        f"/api/projects/{args['project_id']}",
        json_body={"run_as_container": bool(args["enabled"])},
    ))


def _tool_set_autonomous_mode(client: ApiClient, args: dict[str, Any]) -> str:
    return _ok(client.put(
        f"/api/projects/{args['project_id']}",
        json_body={"autonomous_mode": bool(args["enabled"])},
    ))


def _tool_get_autonomous_status(client: ApiClient, args: dict[str, Any]) -> str:
    return _ok(client.get(f"/api/projects/{args['project_id']}/autonomous-status"))


def _tool_list_cloud_provider_regions(client: ApiClient, args: dict[str, Any]) -> str:
    return _ok(client.get(f"/api/integrations/cloud-providers/{args['credential_id']}/regions"))


def _tool_list_cloud_provider_sizes(client: ApiClient, args: dict[str, Any]) -> str:
    import urllib.parse
    region = urllib.parse.quote(args["region"], safe="")
    return _ok(client.get(f"/api/integrations/cloud-providers/{args['credential_id']}/sizes?region={region}"))


def _tool_get_provisioning_job(client: ApiClient, args: dict[str, Any]) -> str:
    return _ok(client.get(f"/api/integrations/cloud-providers/provisioning-jobs/{args['job_id']}"))


def _tool_list_provisioning_jobs(client: ApiClient, args: dict[str, Any]) -> str:
    return _ok(client.get("/api/integrations/cloud-providers/provisioning-jobs"))


def _tool_provision_node(client: ApiClient, args: dict[str, Any]) -> str:
    return _ok(client.post(
        "/api/integrations/cloud-providers/provision",
        json_body={
            "credential_id": args["credential_id"],
            "name": args["name"],
            "region": args["region"],
            "size": args["size"],
        },
    ))


def _tool_add_custom_domain(client: ApiClient, args: dict[str, Any]) -> str:
    return _ok(client.post(
        f"/api/projects/{args['project_id']}/domains",
        json_body={"domain": args["domain"]},
    ))


def _tool_sync_domain_dns(client: ApiClient, args: dict[str, Any]) -> str:
    return _ok(client.post(
        f"/api/integrations/cloudflare/projects/{args['project_id']}/domains/{args['domain_id']}/sync",
        json_body={
            "credential_id": args["credential_id"],
            "target_ip": args["target_ip"],
            "proxied": bool(args.get("proxied", False)),
        },
    ))


TOOL_DISPATCH: dict[str, Callable[[ApiClient, dict[str, Any]], str]] = {
    "list_projects": _tool_list_projects,
    "get_project": _tool_get_project,
    "list_deployments": _tool_list_deployments,
    "get_deployment": _tool_get_deployment,
    "view_build_logs": _tool_view_build_logs,
    "list_nodes": _tool_list_nodes,
    "list_domains": _tool_list_domains,
    "list_cloudflare_credentials": _tool_list_cloudflare_credentials,
    "get_autonomous_status": _tool_get_autonomous_status,
    "list_cloud_provider_regions": _tool_list_cloud_provider_regions,
    "list_cloud_provider_sizes": _tool_list_cloud_provider_sizes,
    "get_provisioning_job": _tool_get_provisioning_job,
    "list_provisioning_jobs": _tool_list_provisioning_jobs,
    "trigger_deployment": _tool_trigger_deployment,
    "set_run_as_container": _tool_set_run_as_container,
    "add_custom_domain": _tool_add_custom_domain,
    "sync_domain_dns": _tool_sync_domain_dns,
    "set_autonomous_mode": _tool_set_autonomous_mode,
    "provision_node": _tool_provision_node,
}


def dispatch_tool(client: ApiClient, name: str, arguments: dict[str, Any]) -> str:
    """Run *name* with *arguments*, returning a JSON-serialised string.

    Re-checks readonly mode even though write tools are filtered from
    list_tools — defence-in-depth for a model that hallucinates a tool
    name rather than picking from the supplied list.
    """
    if _is_readonly() and name in _WRITE_TOOL_NAMES:
        return _err(f"Tool '{name}' is disabled because WATCHTOWER_AGENT_READONLY=true.")
    fn = TOOL_DISPATCH.get(name)
    if fn is None:
        return _err(f"Unknown tool: {name}")
    try:
        return fn(client, arguments)
    except ApiError as exc:
        return _err(exc.detail)
    except httpx.HTTPError as exc:
        return _err(f"Network error talking to WatchTower API: {exc}")
    except Exception as exc:  # pragma: no cover - defensive
        logger.exception("MCP tool %s crashed", name)
        return _err(f"Internal error: {exc}")


# ── MCP server bootstrap ────────────────────────────────────────────────────
#
# Kept thin on purpose — the actual tool surface is in TOOL_DISPATCH /
# the schema lists above, both of which are pure data so they're unit-
# testable without the SDK loaded.


def build_server(client: ApiClient):
    """Construct the MCP Server, wiring list_tools + call_tool handlers
    that dispatch through *client*. Import the SDK lazily so the rest of
    this module (schemas, dispatch, HTTP client) stays importable without
    the optional [mcp] extra installed."""
    from mcp.server import Server
    from mcp.types import TextContent, Tool

    server: Any = Server("watchtower")

    @server.list_tools()
    async def _list_tools() -> list[Tool]:
        return [
            Tool(name=t["name"], description=t["description"], inputSchema=t["inputSchema"])
            for t in list_tool_schemas()
        ]

    @server.call_tool()
    async def _call_tool(name: str, arguments: dict[str, Any]) -> list[TextContent]:
        result = dispatch_tool(client, name, arguments or {})
        return [TextContent(type="text", text=result)]

    return server


async def _run_stdio() -> None:
    from mcp.server.stdio import stdio_server

    base_url = _env_base_url()
    token = _env_token()
    if not token:
        # Fail loudly to stderr so the MCP client's error log surfaces
        # the actual cause instead of "server exited without responding."
        print(
            "watchtower-mcp: WATCHTOWER_API_TOKEN must be set (same token your "
            "dashboard / VS Code extension uses).",
            file=sys.stderr,
        )
        sys.exit(2)

    client = ApiClient(base_url, token)
    server = build_server(client)
    try:
        async with stdio_server() as (read, write):
            await server.run(read, write, server.create_initialization_options())
    finally:
        client.close()


def main() -> None:
    """Console-script entry point (pyproject ``[project.scripts]``)."""
    try:
        from mcp.server import Server  # noqa: F401  — import probe
    except ImportError:
        print(
            "watchtower-mcp: the 'mcp' package is not installed. Install the optional extra:\n"
            "    pip install watchtower-podman[mcp]",
            file=sys.stderr,
        )
        sys.exit(2)
    logging.basicConfig(
        level=os.getenv("WATCHTOWER_MCP_LOG", "WARNING").upper(),
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
        stream=sys.stderr,
    )
    asyncio.run(_run_stdio())


if __name__ == "__main__":
    main()
