"""Tests for the LLM-backed DevOps agent endpoint.

The agent talks to an OpenAI-compatible chat-completions endpoint. We
do NOT spin up a real LLM in CI — instead, monkeypatch the SDK client
factory so we control exactly which streaming chunks the endpoint sees.
This lets us assert on tool dispatch, the read/write gate, the
"agent not configured" path, and the SSE wire format.
"""
from __future__ import annotations

import json
from typing import Any, Iterator
from unittest.mock import MagicMock

import pytest
from fastapi.testclient import TestClient


# ── Helpers to build fake stream chunks ──────────────────────────────────────

def _delta(content: str | None = None, tool_calls: list[Any] | None = None, finish_reason: str | None = None):
    """Mimic an openai chat-completions stream chunk."""
    delta_obj = MagicMock()
    delta_obj.content = content
    delta_obj.tool_calls = tool_calls
    choice = MagicMock()
    choice.delta = delta_obj
    choice.finish_reason = finish_reason
    chunk = MagicMock()
    chunk.choices = [choice]
    return chunk


def _tool_call_delta(idx: int, call_id: str | None = None, name: str | None = None, args_chunk: str | None = None):
    tc = MagicMock()
    tc.index = idx
    tc.id = call_id
    func = MagicMock()
    func.name = name
    func.arguments = args_chunk
    tc.function = func
    return tc


def _make_fake_client(scripted_streams: list[list[Any]]):
    """Return a MagicMock OpenAI client whose chat.completions.create
    yields the next scripted stream on each call."""
    streams = iter(scripted_streams)
    fake = MagicMock()

    def _create(**kwargs):
        return iter(next(streams))

    fake.chat.completions.create.side_effect = _create
    return fake


# ── Fixtures ─────────────────────────────────────────────────────────────────

@pytest.fixture
def with_llm_configured(monkeypatch):
    """Pretend the operator has set the LLM env vars."""
    monkeypatch.setenv("WATCHTOWER_LLM_BASE_URL", "http://fake-llm:11434/v1")
    monkeypatch.setenv("WATCHTOWER_LLM_API_KEY", "test-key")
    monkeypatch.setenv("WATCHTOWER_LLM_MODEL", "fake-model")
    monkeypatch.delenv("WATCHTOWER_AGENT_READONLY", raising=False)


@pytest.fixture
def patch_openai(monkeypatch):
    """Replace the agent's _get_client() so no real HTTP happens."""
    from watchtower.api import agent

    holder: dict[str, Any] = {"client": None}

    def _install(streams: list[list[Any]]):
        client = _make_fake_client(streams)
        holder["client"] = client
        monkeypatch.setattr(agent, "_get_client", lambda: client)
        return client

    return _install


# ── Tests ────────────────────────────────────────────────────────────────────

def test_chat_returns_503_when_not_configured(client: TestClient, monkeypatch):
    """No WATCHTOWER_LLM_BASE_URL → endpoint must refuse with a clear 503."""
    monkeypatch.delenv("WATCHTOWER_LLM_BASE_URL", raising=False)
    r = client.post("/api/agent/chat", json={"messages": [{"role": "user", "content": "hi"}]})
    assert r.status_code == 503
    assert "WATCHTOWER_LLM_BASE_URL" in r.json()["detail"]


def test_config_endpoint_reflects_env(client: TestClient, monkeypatch):
    monkeypatch.setenv("WATCHTOWER_LLM_BASE_URL", "http://x:1/v1")
    monkeypatch.setenv("WATCHTOWER_LLM_MODEL", "qwen2.5:7b")
    monkeypatch.delenv("WATCHTOWER_AGENT_READONLY", raising=False)
    r = client.get("/api/agent/config")
    assert r.status_code == 200
    body = r.json()
    assert body["configured"] is True
    assert body["base_url"] == "http://x:1/v1"
    assert body["model"] == "qwen2.5:7b"
    assert body["readonly"] is False


def test_config_endpoint_when_unconfigured(client: TestClient, monkeypatch):
    monkeypatch.delenv("WATCHTOWER_LLM_BASE_URL", raising=False)
    r = client.get("/api/agent/config")
    assert r.status_code == 200
    assert r.json()["configured"] is False


def test_chat_streams_text_only_response(client: TestClient, with_llm_configured, patch_openai):
    """Simplest flow: model emits text and a final 'stop' — no tools."""
    patch_openai([
        [
            _delta(content="Hello "),
            _delta(content="operator."),
            _delta(finish_reason="stop"),
        ]
    ])

    r = client.post(
        "/api/agent/chat",
        json={"messages": [{"role": "user", "content": "ping"}]},
    )
    assert r.status_code == 200, r.text
    events = _parse_sse(r.text)
    text_deltas = [e["delta"] for e in events if e["type"] == "text"]
    assert text_deltas == ["Hello ", "operator."]
    done = [e for e in events if e["type"] == "done"]
    assert done and done[0]["stop_reason"] == "stop"


def test_chat_executes_read_tool_and_loops(client: TestClient, with_llm_configured, patch_openai):
    """First round: model calls list_projects. Second round: model summarizes."""
    # We expect two API calls — script two streams.
    patch_openai([
        # Round 1: tool call
        [
            _delta(tool_calls=[_tool_call_delta(0, call_id="call_1", name="list_projects", args_chunk="{}")]),
            _delta(finish_reason="tool_calls"),
        ],
        # Round 2: text reply with the result, then stop
        [
            _delta(content="You have 0 projects."),
            _delta(finish_reason="stop"),
        ],
    ])

    r = client.post(
        "/api/agent/chat",
        json={"messages": [{"role": "user", "content": "list my projects"}]},
    )
    assert r.status_code == 200
    events = _parse_sse(r.text)

    tool_calls = [e for e in events if e["type"] == "tool_call"]
    tool_results = [e for e in events if e["type"] == "tool_result"]
    assert len(tool_calls) == 1 and tool_calls[0]["name"] == "list_projects"
    assert len(tool_results) == 1
    # Result is JSON-serialised; for an empty project list it's "[]".
    assert tool_results[0]["result"] in ("[]", "[]…(truncated)")

    text_deltas = [e["delta"] for e in events if e["type"] == "text"]
    assert "".join(text_deltas) == "You have 0 projects."
    assert any(e["type"] == "done" for e in events)


def test_readonly_blocks_destructive_tool_from_registry(client: TestClient, monkeypatch, patch_openai):
    """In readonly mode, trigger_deployment must not appear in the tool list
    sent to the model. Verify by inspecting the kwargs the SDK saw."""
    monkeypatch.setenv("WATCHTOWER_LLM_BASE_URL", "http://x:1/v1")
    monkeypatch.setenv("WATCHTOWER_AGENT_READONLY", "true")

    fake = patch_openai([[_delta(content="ok"), _delta(finish_reason="stop")]])

    client.post(
        "/api/agent/chat",
        json={"messages": [{"role": "user", "content": "anything"}]},
    )

    # Inspect the tools= kwarg passed to the SDK.
    call_kwargs = fake.chat.completions.create.call_args.kwargs
    tool_names = {t["function"]["name"] for t in (call_kwargs.get("tools") or [])}
    assert "list_projects" in tool_names
    assert "trigger_deployment" not in tool_names
    assert "run_with_related" not in tool_names


def test_readonly_defence_in_depth_when_model_hallucinates_destructive_tool(
    client: TestClient, monkeypatch, patch_openai, db_session
):
    """If a misbehaving model tries to call trigger_deployment despite
    readonly, the executor must still refuse — defence in depth."""
    monkeypatch.setenv("WATCHTOWER_LLM_BASE_URL", "http://x:1/v1")
    monkeypatch.setenv("WATCHTOWER_AGENT_READONLY", "true")

    # Need a real project to target.
    create = client.post(
        "/api/projects",
        json={
            "name": "p1",
            "use_case": "vercel_like",
            "repo_url": "https://example.com/p1.git",
            "repo_branch": "main",
        },
    )
    assert create.status_code == 201
    project_id = create.json()["id"]

    args = json.dumps({"project_id": project_id})
    patch_openai([
        [
            _delta(tool_calls=[_tool_call_delta(0, "call_x", "trigger_deployment", args)]),
            _delta(finish_reason="tool_calls"),
        ],
        [_delta(content="acknowledged"), _delta(finish_reason="stop")],
    ])

    r = client.post(
        "/api/agent/chat",
        json={"messages": [{"role": "user", "content": "deploy please"}]},
    )
    events = _parse_sse(r.text)
    tool_results = [e for e in events if e["type"] == "tool_result"]
    assert tool_results, events
    # The result string is what came back from _execute_tool — it must be an error.
    payload = json.loads(tool_results[0]["result"].replace("…(truncated)", ""))
    assert "error" in payload
    assert "Read-only" in payload["error"]


def test_max_iterations_terminates_loop(client: TestClient, with_llm_configured, patch_openai, monkeypatch):
    """If the model keeps calling tools forever, the loop must give up."""
    monkeypatch.setenv("WATCHTOWER_AGENT_MAX_ITERATIONS", "2")

    looping_round = [
        _delta(tool_calls=[_tool_call_delta(0, "call_loop", "list_projects", "{}")]),
        _delta(finish_reason="tool_calls"),
    ]
    patch_openai([looping_round, looping_round, looping_round])

    r = client.post(
        "/api/agent/chat",
        json={"messages": [{"role": "user", "content": "loop forever"}]},
    )
    events = _parse_sse(r.text)
    errors = [e for e in events if e["type"] == "error"]
    assert errors, "expected the loop to terminate with an error event"
    assert "exceeded" in errors[0]["error"].lower()


# ── SSE parsing helper ───────────────────────────────────────────────────────

def _parse_sse(body: str) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    for line in body.splitlines():
        line = line.strip()
        if not line.startswith("data:"):
            continue
        payload = line[len("data:"):].strip()
        if payload:
            out.append(json.loads(payload))
    return out
