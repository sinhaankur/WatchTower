"""Unit tests for watchtower/mcp_server.py.

The MCP SDK is intentionally NOT exercised here — every assertion runs
against the pure tool-schema lists and the ``dispatch_tool`` function,
which only needs an ``ApiClient`` (mockable). This is why the
``build_server`` function lazy-imports the SDK and why schemas live as
plain dicts at module level — tests stay fast and don't depend on the
optional [mcp] extra being installed.
"""
from __future__ import annotations

import json
from unittest.mock import MagicMock
import pytest

from watchtower import mcp_server
from watchtower.mcp_server import (
    READ_TOOL_SCHEMAS,
    WRITE_TOOL_SCHEMAS,
    TOOL_DISPATCH,
    ApiError,
    dispatch_tool,
    list_tool_schemas,
)


# ── Schema invariants ───────────────────────────────────────────────────────


def test_every_tool_has_a_dispatch_handler():
    """Any schema we advertise must be runnable — no dangling entries.
    Catches the easy regression where someone adds a schema and forgets
    the dispatch line (or vice versa)."""
    declared = {t["name"] for t in READ_TOOL_SCHEMAS} | {t["name"] for t in WRITE_TOOL_SCHEMAS}
    assert declared == set(TOOL_DISPATCH.keys()), (
        f"Missing handlers: {declared - set(TOOL_DISPATCH.keys())}; "
        f"orphan handlers: {set(TOOL_DISPATCH.keys()) - declared}"
    )


def test_tool_schemas_have_required_fields():
    """MCP requires name + description + inputSchema. inputSchema must
    be a JSON-Schema object. Smoke-test all 12 in one go so a malformed
    addition can't slip through."""
    for tool in READ_TOOL_SCHEMAS + WRITE_TOOL_SCHEMAS:
        assert tool["name"], f"name missing on {tool}"
        assert tool["description"], f"description missing on {tool['name']}"
        assert tool["inputSchema"]["type"] == "object", tool["name"]
        # additionalProperties: false on every tool keeps the LLM from
        # smuggling extra keys past the schema check. Worth enforcing.
        assert tool["inputSchema"].get("additionalProperties") is False, (
            f"{tool['name']} missing additionalProperties=false"
        )


def test_tool_names_are_snake_case_and_unique():
    """Mixed naming styles are a UX bug — the LLM gets confused. Pin
    snake_case explicitly so a refactor can't drift."""
    names = [t["name"] for t in READ_TOOL_SCHEMAS + WRITE_TOOL_SCHEMAS]
    assert len(set(names)) == len(names), f"Duplicate tool names: {names}"
    for n in names:
        assert n == n.lower() and " " not in n and "-" not in n, n


# ── Readonly mode ───────────────────────────────────────────────────────────


def test_list_tools_includes_write_tools_when_not_readonly(monkeypatch):
    monkeypatch.delenv("WATCHTOWER_AGENT_READONLY", raising=False)
    names = {t["name"] for t in list_tool_schemas()}
    assert "trigger_deployment" in names
    assert "set_run_as_container" in names


def test_list_tools_strips_write_tools_when_readonly(monkeypatch):
    monkeypatch.setenv("WATCHTOWER_AGENT_READONLY", "true")
    names = {t["name"] for t in list_tool_schemas()}
    # No write tools — only the read surface.
    for w in WRITE_TOOL_SCHEMAS:
        assert w["name"] not in names, f"{w['name']} leaked into readonly tool list"
    # And read tools still present.
    assert "list_projects" in names


def test_dispatch_rejects_write_tools_in_readonly_mode(monkeypatch):
    """Defence-in-depth: even if the LLM hallucinates a write tool name
    instead of picking from list_tools, dispatch must still refuse."""
    monkeypatch.setenv("WATCHTOWER_AGENT_READONLY", "true")
    client = MagicMock()
    result = dispatch_tool(client, "trigger_deployment", {"project_id": "x"})
    body = json.loads(result)
    assert "error" in body
    assert "WATCHTOWER_AGENT_READONLY" in body["error"]
    # And the HTTP client was never even touched.
    client.post.assert_not_called()


# ── Tool dispatch — HTTP shape ──────────────────────────────────────────────


def test_list_projects_dispatches_to_get_api_projects():
    client = MagicMock()
    client.get.return_value = [{"id": "p1"}]
    out = json.loads(dispatch_tool(client, "list_projects", {}))
    client.get.assert_called_once_with("/api/projects")
    assert out == [{"id": "p1"}]


def test_get_project_uses_path_param():
    client = MagicMock()
    client.get.return_value = {"id": "abc", "name": "x"}
    dispatch_tool(client, "get_project", {"project_id": "abc-123"})
    client.get.assert_called_once_with("/api/projects/abc-123")


def test_list_deployments_caps_limit_to_50():
    """Belt-and-suspenders: API already paginates, but capping locally
    means a buggy LLM asking for limit=99999 doesn't OOM the response."""
    client = MagicMock()
    client.get.return_value = [{"id": f"d{i}"} for i in range(200)]
    out = json.loads(dispatch_tool(client, "list_deployments", {"project_id": "p1", "limit": 99999}))
    assert len(out) == 50


def test_trigger_deployment_defaults_branch_from_project():
    """When the LLM doesn't specify a branch, we fetch the project to
    use its configured branch — saves a tool-call round-trip the model
    would otherwise have to chain. The fallback is 'main' if even the
    project lookup doesn't yield one."""
    client = MagicMock()
    client.get.return_value = {"id": "p1", "repo_branch": "develop"}
    client.post.return_value = {"id": "d1", "status": "pending"}
    dispatch_tool(client, "trigger_deployment", {"project_id": "p1"})
    client.post.assert_called_once_with(
        "/api/projects/p1/deployments",
        json_body={"branch": "develop"},
    )


def test_trigger_deployment_honours_branch_override():
    client = MagicMock()
    client.post.return_value = {"id": "d1"}
    dispatch_tool(client, "trigger_deployment", {"project_id": "p1", "branch": "feature"})
    # No GET — we have the branch already.
    client.get.assert_not_called()
    client.post.assert_called_once_with(
        "/api/projects/p1/deployments",
        json_body={"branch": "feature"},
    )


def test_set_run_as_container_puts_boolean():
    client = MagicMock()
    client.put.return_value = {"id": "p1", "run_as_container": True}
    dispatch_tool(client, "set_run_as_container", {"project_id": "p1", "enabled": True})
    client.put.assert_called_once_with(
        "/api/projects/p1",
        json_body={"run_as_container": True},
    )


def test_add_custom_domain_posts_to_domains_endpoint():
    client = MagicMock()
    client.post.return_value = {"id": "d1", "domain": "x.example.com"}
    dispatch_tool(client, "add_custom_domain", {"project_id": "p1", "domain": "x.example.com"})
    client.post.assert_called_once_with(
        "/api/projects/p1/domains",
        json_body={"domain": "x.example.com"},
    )


def test_set_autonomous_mode_puts_boolean():
    """Phase 4 toggle dispatches the same shape as set_run_as_container.
    The API enforces the cross-field rule (requires run_as_container) so
    the MCP layer can stay dumb here."""
    client = MagicMock()
    client.put.return_value = {"id": "p1", "autonomous_mode": True}
    dispatch_tool(client, "set_autonomous_mode", {"project_id": "p1", "enabled": True})
    client.put.assert_called_once_with(
        "/api/projects/p1",
        json_body={"autonomous_mode": True},
    )


def test_get_autonomous_status_is_a_read_tool(monkeypatch):
    """Inspecting the probe state must work even in readonly mode —
    that's the operator's only window into what the tick is doing."""
    monkeypatch.setenv("WATCHTOWER_AGENT_READONLY", "true")
    names = {t["name"] for t in list_tool_schemas()}
    assert "get_autonomous_status" in names

    client = MagicMock()
    client.get.return_value = {"enabled": True, "entries": []}
    dispatch_tool(client, "get_autonomous_status", {"project_id": "p1"})
    client.get.assert_called_once_with("/api/projects/p1/autonomous-status")


def test_list_cloud_provider_regions_dispatches(monkeypatch):
    """Regions listing is read-only — must be available in readonly mode
    so an operator can ask Claude 'what regions can I deploy to?' without
    granting write access."""
    monkeypatch.setenv("WATCHTOWER_AGENT_READONLY", "true")
    names = {t["name"] for t in list_tool_schemas()}
    assert "list_cloud_provider_regions" in names

    client = MagicMock()
    client.get.return_value = [{"id": "nyc3", "name": "New York 3"}]
    dispatch_tool(client, "list_cloud_provider_regions", {"credential_id": "cred-1"})
    client.get.assert_called_once_with("/api/integrations/cloud-providers/cred-1/regions")


def test_list_cloud_provider_sizes_url_encodes_region(monkeypatch):
    monkeypatch.setenv("WATCHTOWER_AGENT_READONLY", "true")
    client = MagicMock()
    client.get.return_value = []
    dispatch_tool(client, "list_cloud_provider_sizes", {
        "credential_id": "cred-1",
        "region": "weird region/with slash",  # adversarial — verify quoting
    })
    called_path = client.get.call_args.args[0]
    # The region MUST be URL-encoded — a raw '/' would route to a
    # different endpoint and silently return wrong results.
    assert "weird%20region%2Fwith%20slash" in called_path
    assert called_path.startswith("/api/integrations/cloud-providers/cred-1/sizes?region=")


def test_provision_node_posts_full_payload():
    """Write-only tool: assemble the exact JSON shape the API expects."""
    client = MagicMock()
    client.post.return_value = {"id": "job-1", "status": "queued"}
    dispatch_tool(client, "provision_node", {
        "credential_id": "cred-1",
        "name": "my-node",
        "region": "nyc3",
        "size": "s-1vcpu-1gb",
    })
    client.post.assert_called_once_with(
        "/api/integrations/cloud-providers/provision",
        json_body={
            "credential_id": "cred-1",
            "name": "my-node",
            "region": "nyc3",
            "size": "s-1vcpu-1gb",
        },
    )


def test_provision_node_is_blocked_in_readonly_mode(monkeypatch):
    """Sanity: provisioning a VM is a write — must not be reachable when
    WATCHTOWER_AGENT_READONLY=true (defence-in-depth, since the schema
    is also stripped from list_tools)."""
    monkeypatch.setenv("WATCHTOWER_AGENT_READONLY", "true")
    names = {t["name"] for t in list_tool_schemas()}
    assert "provision_node" not in names

    client = MagicMock()
    result = json.loads(dispatch_tool(client, "provision_node", {
        "credential_id": "c", "name": "n", "region": "r", "size": "s",
    }))
    assert "error" in result
    client.post.assert_not_called()


def test_get_provisioning_job_is_a_read_tool(monkeypatch):
    monkeypatch.setenv("WATCHTOWER_AGENT_READONLY", "true")
    names = {t["name"] for t in list_tool_schemas()}
    assert "get_provisioning_job" in names
    assert "list_provisioning_jobs" in names

    client = MagicMock()
    client.get.return_value = {"id": "j", "status": "registered"}
    dispatch_tool(client, "get_provisioning_job", {"job_id": "j"})
    client.get.assert_called_once_with("/api/integrations/cloud-providers/provisioning-jobs/j")


def test_sync_domain_dns_assembles_cloudflare_payload():
    client = MagicMock()
    client.post.return_value = {"domain": "x.example.com", "cloudflare_target_ip": "1.2.3.4"}
    dispatch_tool(client, "sync_domain_dns", {
        "project_id": "p1",
        "domain_id": "d1",
        "credential_id": "c1",
        "target_ip": "1.2.3.4",
    })
    client.post.assert_called_once_with(
        "/api/integrations/cloudflare/projects/p1/domains/d1/sync",
        json_body={"credential_id": "c1", "target_ip": "1.2.3.4", "proxied": False},
    )


def test_list_nodes_resolves_org_from_project():
    """list_nodes wants an org_id, but the LLM only has a project_id —
    we resolve org_id ourselves rather than forcing the LLM to make
    two tool calls. Worth pinning the order so a refactor can't
    introduce N+1 fetches."""
    client = MagicMock()
    client.get.side_effect = [
        {"id": "p1", "org_id": "org-1"},   # project lookup
        [{"id": "n1", "host": "1.2.3.4"}], # nodes list
    ]
    dispatch_tool(client, "list_nodes", {"project_id": "p1"})
    assert client.get.call_args_list[0].args == ("/api/projects/p1",)
    assert client.get.call_args_list[1].args == ("/api/orgs/org-1/nodes",)


# ── Error mapping ───────────────────────────────────────────────────────────


def test_api_error_passes_through_detail():
    """The LLM needs the actual error text to recover (or report to the
    operator). A generic '500 internal error' is worse than 'Project not
    found' even though both are 4xx/5xx."""
    client = MagicMock()
    client.get.side_effect = ApiError(404, "Project not found.")
    out = json.loads(dispatch_tool(client, "get_project", {"project_id": "missing"}))
    assert out == {"error": "Project not found."}


def test_unknown_tool_returns_actionable_error():
    out = json.loads(dispatch_tool(MagicMock(), "rm_rf", {}))
    assert "Unknown tool" in out["error"]


# ── Module-level error handling ─────────────────────────────────────────────


def test_module_imports_without_mcp_sdk(monkeypatch):
    """build_server uses a lazy import. The schemas + dispatch surface
    must remain importable even when the optional [mcp] extra is not
    installed — that's how tests run today and how core CI runs."""
    # Just calling the function would crash if there were a top-level
    # import; this passes because mcp imports live inside build_server.
    assert callable(mcp_server.list_tool_schemas)
    assert callable(mcp_server.dispatch_tool)
