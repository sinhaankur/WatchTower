"""LLM-powered DevOps agent endpoint.

Talks to any OpenAI-compatible chat-completions endpoint — Ollama,
LM Studio, vLLM, llama.cpp, OpenAI itself, OpenRouter, LiteLLM, etc.
Operators configure their own LLM via env vars; WatchTower itself
is provider-agnostic.

  WATCHTOWER_LLM_BASE_URL    e.g. http://localhost:11434/v1 (Ollama)
                                  https://api.openai.com/v1
                                  https://openrouter.ai/api/v1
  WATCHTOWER_LLM_API_KEY     local servers usually accept any string;
                             cloud providers need a real key
  WATCHTOWER_LLM_MODEL       e.g. "llama3.1:8b", "qwen2.5-coder:7b",
                                   "gpt-4o-mini", "anthropic/claude-..."
  WATCHTOWER_AGENT_READONLY  "true" to disable destructive tools
  WATCHTOWER_AGENT_MAX_ITERATIONS  cap the tool-use loop (default 10)

Tools wrap existing WatchTower API operations and run server-side
under the authenticated user's identity — the agent can only do
what the user can do; there is no privilege escalation.
"""
# NOTE: deliberately NOT using `from __future__ import annotations`. The
# slowapi @limiter.limit() wrapper loses agent.py's module globals, so
# FastAPI's pydantic-driven schema generator can't eval stringified
# annotations like 'ChatRequest' / 'StreamingResponse'. Real (non-string)
# annotations work because FastAPI sees the type objects directly.
import json
import logging
import os
from typing import Any, Dict, Iterator, List, Optional
from uuid import UUID

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Request, status
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from watchtower.database import (
    Build,
    Deployment,
    DeploymentStatus,
    DeploymentTrigger,
    OrgNode,
    Project,
    ProjectRelation,
    get_db,
)
from watchtower.api import util
from watchtower.api.rate_limit import _key_user_then_remote, limiter
from watchtower.queue import enqueue_build

router = APIRouter(prefix="/api/agent", tags=["Agent"])
logger = logging.getLogger(__name__)


# ── Configuration ────────────────────────────────────────────────────────────

# Settings are read fresh on every request so operators can flip env vars
# (READONLY toggle, model override, base URL) without restarting the API.
def _default_model() -> str:
    return os.getenv("WATCHTOWER_LLM_MODEL", "gpt-4o-mini")


def _max_iterations() -> int:
    return int(os.getenv("WATCHTOWER_AGENT_MAX_ITERATIONS", "10"))


def _max_tokens() -> int:
    return int(os.getenv("WATCHTOWER_AGENT_MAX_TOKENS", "2048"))


LOG_TAIL_BYTES = int(os.getenv("WATCHTOWER_AGENT_LOG_TAIL_BYTES", "8000"))


def _is_readonly() -> bool:
    return os.getenv("WATCHTOWER_AGENT_READONLY", "false").lower() == "true"


def _get_client():
    """Build an OpenAI-compatible client.

    Imported lazily so the openai dependency is only loaded when the
    agent endpoint is actually called.
    """
    from openai import OpenAI

    base_url = os.getenv("WATCHTOWER_LLM_BASE_URL")
    if not base_url:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail=(
                "Agent is not configured. Set WATCHTOWER_LLM_BASE_URL to your "
                "OpenAI-compatible endpoint (e.g. http://localhost:11434/v1 for "
                "Ollama, or https://api.openai.com/v1 for OpenAI)."
            ),
        )
    # Local LLM servers usually accept any non-empty key. Cloud providers
    # need a real one; fall back to a placeholder so the SDK doesn't 401
    # the request before it even leaves the box.
    api_key = os.getenv("WATCHTOWER_LLM_API_KEY") or "not-set"
    return OpenAI(base_url=base_url, api_key=api_key)


# ── System prompt ────────────────────────────────────────────────────────────

SYSTEM_PROMPT = """\
You are the WatchTower DevOps agent.

WatchTower is a self-hosted deployment control plane: it manages projects,
deployments to remote nodes over SSH, build pipelines, and webhook-triggered
releases. Operators ask you to inspect state and (when allowed) take action.

Use the provided tools to read state and trigger operations. Do not invent
data — if a tool can answer the question, call it. Be concise: report what
you found, what you did, and what the operator should look at next.

When acting destructively (triggering a deployment, running a related-app
bundle), confirm intent in your reply: state which project, branch, and
target you used. The user can see your tool calls in the UI.

If a tool returns an error, surface it directly — do not retry indefinitely.
Stop after a reasonable number of attempts and ask for guidance.
"""


# ── Tool registry ────────────────────────────────────────────────────────────

# Defined as plain dicts (OpenAI-compatible tool format) so we can attach
# them to any provider that accepts the chat-completions tool schema.

READ_TOOLS: List[Dict[str, Any]] = [
    {
        "type": "function",
        "function": {
            "name": "list_projects",
            "description": "List every WatchTower project the current user owns.",
            "parameters": {"type": "object", "properties": {}, "additionalProperties": False},
        },
    },
    {
        "type": "function",
        "function": {
            "name": "get_project",
            "description": "Fetch one project's full details (repo, branch, use case, etc.).",
            "parameters": {
                "type": "object",
                "properties": {
                    "project_id": {"type": "string", "description": "UUID of the project."},
                },
                "required": ["project_id"],
                "additionalProperties": False,
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "list_deployments",
            "description": "List the most recent deployments for a project, newest first.",
            "parameters": {
                "type": "object",
                "properties": {
                    "project_id": {"type": "string"},
                    "limit": {"type": "integer", "default": 10, "minimum": 1, "maximum": 50},
                },
                "required": ["project_id"],
                "additionalProperties": False,
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "get_deployment",
            "description": "Fetch one deployment's status, branch, commit, and timestamps.",
            "parameters": {
                "type": "object",
                "properties": {"deployment_id": {"type": "string"}},
                "required": ["deployment_id"],
                "additionalProperties": False,
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "view_build_logs",
            "description": (
                "Fetch the build output for a deployment's most recent build. Returns "
                "the tail of the log when it would otherwise exceed the model's window."
            ),
            "parameters": {
                "type": "object",
                "properties": {"deployment_id": {"type": "string"}},
                "required": ["deployment_id"],
                "additionalProperties": False,
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "list_nodes",
            "description": "List deployment target nodes for the current user's organization.",
            "parameters": {"type": "object", "properties": {}, "additionalProperties": False},
        },
    },
]

WRITE_TOOLS: List[Dict[str, Any]] = [
    {
        "type": "function",
        "function": {
            "name": "trigger_deployment",
            "description": (
                "Queue a new deployment for a project. Uses the project's configured "
                "branch unless one is specified. Disabled when WATCHTOWER_AGENT_READONLY=true."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "project_id": {"type": "string"},
                    "branch": {"type": "string", "description": "Optional branch override."},
                },
                "required": ["project_id"],
                "additionalProperties": False,
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "run_with_related",
            "description": (
                "Queue deployments for a project AND every project linked to it via "
                "ProjectRelation, in dependency order. Disabled when WATCHTOWER_AGENT_READONLY=true."
            ),
            "parameters": {
                "type": "object",
                "properties": {"project_id": {"type": "string"}},
                "required": ["project_id"],
                "additionalProperties": False,
            },
        },
    },
]


def _build_tools() -> List[Dict[str, Any]]:
    return READ_TOOLS + ([] if _is_readonly() else WRITE_TOOLS)


# ── Tool execution ───────────────────────────────────────────────────────────

def _err(msg: str) -> str:
    return json.dumps({"error": msg})


def _execute_tool(
    name: str,
    arguments: Dict[str, Any],
    user_id: UUID,
    db: Session,
    background_tasks: BackgroundTasks,
) -> str:
    """Run a tool and return its JSON-serialised result.

    Defence-in-depth: re-check ``_is_readonly()`` even though the destructive
    tools are filtered out of the tool list when readonly. A model that
    hallucinates a tool name still cannot bypass the gate.
    """
    try:
        if name == "list_projects":
            projects = db.query(Project).filter(Project.owner_id == user_id).all()
            return json.dumps([
                {
                    "id": str(p.id),
                    "name": p.name,
                    "repo_url": p.repo_url,
                    "branch": p.repo_branch,
                    "use_case": p.use_case.value if hasattr(p.use_case, "value") else str(p.use_case),
                    "is_active": p.is_active,
                }
                for p in projects
            ])

        if name == "get_project":
            project = _load_project(db, arguments.get("project_id"), user_id)
            if not project:
                return _err("Project not found or not accessible.")
            return json.dumps({
                "id": str(project.id),
                "name": project.name,
                "repo_url": project.repo_url,
                "branch": project.repo_branch,
                "use_case": project.use_case.value if hasattr(project.use_case, "value") else str(project.use_case),
                "is_active": project.is_active,
                "created_at": project.created_at.isoformat() if project.created_at else None,
            })

        if name == "list_deployments":
            project = _load_project(db, arguments.get("project_id"), user_id)
            if not project:
                return _err("Project not found or not accessible.")
            limit = max(1, min(int(arguments.get("limit", 10)), 50))
            deployments = (
                db.query(Deployment)
                .filter(Deployment.project_id == project.id)
                .order_by(Deployment.created_at.desc())
                .limit(limit)
                .all()
            )
            return json.dumps([_deployment_dict(d) for d in deployments])

        if name == "get_deployment":
            dep = _load_deployment(db, arguments.get("deployment_id"), user_id)
            if not dep:
                return _err("Deployment not found or not accessible.")
            return json.dumps(_deployment_dict(dep))

        if name == "view_build_logs":
            dep = _load_deployment(db, arguments.get("deployment_id"), user_id)
            if not dep:
                return _err("Deployment not found or not accessible.")
            build = (
                db.query(Build)
                .filter(Build.deployment_id == dep.id)
                .order_by(Build.started_at.desc().nullslast())
                .first()
            )
            if not build:
                return _err("No build has run for this deployment yet.")
            output = build.build_output or ""
            truncated = len(output) > LOG_TAIL_BYTES
            tail = output[-LOG_TAIL_BYTES:] if truncated else output
            return json.dumps({
                "build_id": str(build.id),
                "status": build.status.value if hasattr(build.status, "value") else str(build.status),
                "duration_seconds": build.duration_seconds,
                "truncated": truncated,
                "log_tail": tail,
            })

        if name == "list_nodes":
            project = db.query(Project).filter(Project.owner_id == user_id).first()
            org_id = project.org_id if project else None
            if not org_id:
                return json.dumps([])
            nodes = db.query(OrgNode).filter(OrgNode.org_id == org_id).all()
            return json.dumps([
                {
                    "id": str(n.id),
                    "name": n.name,
                    "host": n.host,
                    "status": n.status.value if hasattr(n.status, "value") else str(n.status),
                    "is_active": n.is_active,
                    "is_primary": n.is_primary,
                }
                for n in nodes
            ])

        if name == "trigger_deployment":
            if _is_readonly():
                return _err("Read-only mode is active (WATCHTOWER_AGENT_READONLY=true).")
            project = _load_project(db, arguments.get("project_id"), user_id)
            if not project:
                return _err("Project not found or not accessible.")
            branch = (arguments.get("branch") or project.repo_branch or "main").strip()
            deployment = Deployment(
                project_id=project.id,
                commit_sha="agent-trigger",
                branch=branch,
                status=DeploymentStatus.PENDING,
                trigger=DeploymentTrigger.MANUAL,
            )
            db.add(deployment)
            db.commit()
            db.refresh(deployment)
            mode = enqueue_build(str(deployment.id), background_tasks)
            return json.dumps({
                "deployment_id": str(deployment.id),
                "branch": branch,
                "status": "queued",
                "dispatch_mode": mode,
            })

        if name == "run_with_related":
            if _is_readonly():
                return _err("Read-only mode is active (WATCHTOWER_AGENT_READONLY=true).")
            project = _load_project(db, arguments.get("project_id"), user_id)
            if not project:
                return _err("Project not found or not accessible.")
            relations = (
                db.query(ProjectRelation)
                .filter(ProjectRelation.project_id == project.id)
                .order_by(ProjectRelation.order_index.asc(), ProjectRelation.created_at.asc())
                .all()
            )
            queue: List[Project] = []
            seen: set = {project.id}
            for rel in relations:
                related = db.query(Project).filter(Project.id == rel.related_project_id).first()
                if not related or not related.is_active:
                    continue
                if related.org_id != project.org_id:
                    continue
                if related.id in seen:
                    continue
                seen.add(related.id)
                queue.append(related)
            queue.append(project)

            results = []
            for proj in queue:
                deployment = Deployment(
                    project_id=proj.id,
                    commit_sha="agent-run-with-related",
                    branch=proj.repo_branch,
                    status=DeploymentStatus.PENDING,
                    trigger=DeploymentTrigger.MANUAL,
                )
                db.add(deployment)
                db.commit()
                db.refresh(deployment)
                mode = enqueue_build(str(deployment.id), background_tasks)
                results.append({
                    "project_id": str(proj.id),
                    "project_name": proj.name,
                    "deployment_id": str(deployment.id),
                    "dispatch_mode": mode,
                })
            return json.dumps({"queued": results, "count": len(results)})

        return _err(f"Unknown tool: {name}")

    except Exception as exc:  # noqa: BLE001 — surface tool errors to the model
        logger.exception("Agent tool '%s' raised", name)
        return _err(f"{type(exc).__name__}: {exc}")


def _load_project(db: Session, project_id_arg: Any, user_id: UUID) -> Optional[Project]:
    try:
        pid = UUID(str(project_id_arg))
    except (ValueError, TypeError):
        return None
    return db.query(Project).filter(Project.id == pid, Project.owner_id == user_id).first()


def _load_deployment(db: Session, deployment_id_arg: Any, user_id: UUID) -> Optional[Deployment]:
    try:
        did = UUID(str(deployment_id_arg))
    except (ValueError, TypeError):
        return None
    return (
        db.query(Deployment)
        .join(Project, Deployment.project_id == Project.id)
        .filter(Deployment.id == did, Project.owner_id == user_id)
        .first()
    )


def _deployment_dict(d: Deployment) -> Dict[str, Any]:
    return {
        "id": str(d.id),
        "project_id": str(d.project_id),
        "branch": d.branch,
        "commit_sha": d.commit_sha,
        "commit_message": d.commit_message,
        "status": d.status.value if hasattr(d.status, "value") else str(d.status),
        "trigger": d.trigger.value if hasattr(d.trigger, "value") else str(d.trigger),
        "created_at": d.created_at.isoformat() if d.created_at else None,
        "started_at": d.started_at.isoformat() if d.started_at else None,
        "completed_at": d.completed_at.isoformat() if d.completed_at else None,
    }


# ── Endpoint ─────────────────────────────────────────────────────────────────

class ChatMessage(BaseModel):
    role: str = Field(..., description='"user", "assistant", or "system"')
    content: str


class ChatRequest(BaseModel):
    messages: List[ChatMessage]
    model: Optional[str] = Field(None, description="Override the configured WATCHTOWER_LLM_MODEL.")


def _sse(event: Dict[str, Any]) -> bytes:
    return f"data: {json.dumps(event)}\n\n".encode("utf-8")


@router.get("/config")
async def agent_config(_user: dict = Depends(util.get_current_user)) -> Dict[str, Any]:
    """Surface the agent's configuration to the SPA so it can show
    "configure your LLM" UI when nothing is set."""
    return {
        "configured": bool(os.getenv("WATCHTOWER_LLM_BASE_URL")),
        "base_url": os.getenv("WATCHTOWER_LLM_BASE_URL") or None,
        "model": _default_model(),
        "readonly": _is_readonly(),
        "max_iterations": _max_iterations(),
    }


@router.post("/chat")
@limiter.limit("30/minute", key_func=_key_user_then_remote)
async def chat(
    request: Request,  # required by slowapi to extract the rate-limit key
    req: ChatRequest,
    background_tasks: BackgroundTasks,
    current_user: dict = Depends(util.get_current_user),
    db: Session = Depends(get_db),
):  # returns StreamingResponse — annotation dropped because slowapi's
    # wrapper + `from __future__ import annotations` makes FastAPI's
    # response-model resolver lose the type's namespace at decoration time.
    """Run an agent loop over the OpenAI-compatible /chat/completions API
    and stream the result back as Server-Sent Events.

    Each SSE ``data:`` line is JSON of one of:
      - ``{type: "text", delta}`` — streamed assistant text
      - ``{type: "tool_call", name, arguments, id}`` — agent invoked a tool
      - ``{type: "tool_result", id, name, result}`` — tool returned (truncated)
      - ``{type: "done", stop_reason, iterations}`` — loop ended cleanly
      - ``{type: "error", error}`` — fatal error during the loop
    """
    client = _get_client()
    user_id = util.canonical_user_id(db, current_user)
    tools = _build_tools()
    model = (req.model or _default_model()).strip()
    max_iterations = _max_iterations()
    max_tokens = _max_tokens()

    # Build the conversation: prepend the system prompt, then user-supplied turns.
    messages: List[Dict[str, Any]] = [{"role": "system", "content": SYSTEM_PROMPT}]
    for m in req.messages:
        if m.role not in {"user", "assistant", "system"}:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=f"Invalid message role: {m.role!r}",
            )
        messages.append({"role": m.role, "content": m.content})

    def event_stream() -> Iterator[bytes]:
        nonlocal messages
        for iteration in range(1, max_iterations + 1):
            try:
                stream = client.chat.completions.create(
                    model=model,
                    messages=messages,
                    tools=tools or None,
                    max_tokens=max_tokens,
                    stream=True,
                )
            except Exception as exc:  # noqa: BLE001 — surface SDK / network errors
                logger.exception("Agent LLM call failed")
                yield _sse({"type": "error", "error": f"{type(exc).__name__}: {exc}"})
                return

            assistant_content = ""
            # Aggregate streaming tool calls by index (the SDK splits each
            # tool call into multiple deltas — name in the first chunk,
            # arguments incrementally in following chunks).
            tool_calls_by_index: Dict[int, Dict[str, Any]] = {}
            finish_reason: Optional[str] = None

            for chunk in stream:
                if not chunk.choices:
                    continue
                delta = chunk.choices[0].delta
                if delta is None:
                    continue
                if delta.content:
                    assistant_content += delta.content
                    yield _sse({"type": "text", "delta": delta.content})
                if delta.tool_calls:
                    for tc in delta.tool_calls:
                        idx = tc.index if tc.index is not None else 0
                        slot = tool_calls_by_index.setdefault(
                            idx, {"id": "", "name": "", "arguments": ""}
                        )
                        if tc.id:
                            slot["id"] = tc.id
                        if tc.function and tc.function.name:
                            slot["name"] = tc.function.name
                        if tc.function and tc.function.arguments:
                            slot["arguments"] += tc.function.arguments
                if chunk.choices[0].finish_reason:
                    finish_reason = chunk.choices[0].finish_reason

            # Append the assistant turn as the API expects it for the next round.
            assistant_msg: Dict[str, Any] = {"role": "assistant", "content": assistant_content or None}
            if tool_calls_by_index:
                assistant_msg["tool_calls"] = [
                    {
                        "id": slot["id"] or f"call_{idx}",
                        "type": "function",
                        "function": {"name": slot["name"], "arguments": slot["arguments"] or "{}"},
                    }
                    for idx, slot in sorted(tool_calls_by_index.items())
                ]
            messages.append(assistant_msg)

            if finish_reason in ("stop", None) and not tool_calls_by_index:
                yield _sse({"type": "done", "stop_reason": finish_reason or "stop", "iterations": iteration})
                return

            if not tool_calls_by_index:
                # Some other terminal reason (length, content_filter) without tool calls.
                yield _sse({"type": "done", "stop_reason": finish_reason or "unknown", "iterations": iteration})
                return

            # Execute every tool call and feed results back as role=tool messages.
            for idx, slot in sorted(tool_calls_by_index.items()):
                try:
                    args = json.loads(slot["arguments"]) if slot["arguments"] else {}
                except json.JSONDecodeError:
                    args = {}
                tool_name = slot["name"] or "unknown"
                tool_call_id = slot["id"] or f"call_{idx}"
                yield _sse({
                    "type": "tool_call",
                    "name": tool_name,
                    "arguments": args,
                    "id": tool_call_id,
                })
                result_str = _execute_tool(tool_name, args, user_id, db, background_tasks)
                # Truncate the SSE preview so the UI doesn't scroll forever;
                # the model always gets the full result.
                preview = result_str if len(result_str) <= 800 else result_str[:800] + "…(truncated)"
                yield _sse({
                    "type": "tool_result",
                    "id": tool_call_id,
                    "name": tool_name,
                    "result": preview,
                })
                messages.append({
                    "role": "tool",
                    "tool_call_id": tool_call_id,
                    "content": result_str,
                })

        yield _sse({"type": "error", "error": f"Agent exceeded {max_iterations} iterations without finishing."})

    return StreamingResponse(
        event_stream(),
        media_type="text/event-stream",
        headers={
            # Common SSE friendliness — disable buffering on proxies that
            # honour these and keep keep-alives off so deltas flush immediately.
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",
        },
    )
