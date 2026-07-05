"""Local Podman management API: machine, containers, pods.

Backs the Containers page's full manager UI. Thin HTTP shell around
watchtower/podman_runtime.py — validation and argv construction live
there; this layer adds auth, project-ownership checks for labels,
audit logging on mutations, and thread offloading (podman runs can
block for minutes on first image pull).

PodmanError maps to 400 (user-fixable: bad input, podman not installed,
machine stopped) — never 500.
"""
from __future__ import annotations

import logging
from typing import Any, Dict, List, Optional
from uuid import UUID

import anyio
from fastapi import APIRouter, Depends, HTTPException, Request, status
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from watchtower import podman_runtime as rt
from watchtower.api import audit as audit_log
from watchtower.api import util
from watchtower.database import Project, get_db

router = APIRouter(prefix="/api/podman", tags=["Podman"])
logger = logging.getLogger(__name__)


def _bad_request(exc: rt.PodmanError) -> HTTPException:
    return HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc))


async def _call(fn, *args, **kwargs):
    """Run a blocking podman call off the event loop, mapping PodmanError → 400."""
    try:
        return await anyio.to_thread.run_sync(lambda: fn(*args, **kwargs))
    except rt.PodmanError as exc:
        raise _bad_request(exc)


def _resolve_project(db: Session, current_user: dict, project_id: Optional[str]) -> tuple[Optional[str], Optional[str]]:
    """Validate an optional project link: must be the caller's project.
    Returns (project_id, project_name) for labelling, or (None, None)."""
    if not project_id:
        return None, None
    try:
        pid = UUID(str(project_id))
    except (TypeError, ValueError):
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Invalid project_id.")
    project = (
        db.query(Project)
        .filter(Project.id == pid, Project.owner_id == util.canonical_user_id(db, current_user))
        .first()
    )
    if not project:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Project not found.")
    return str(project.id), project.name


# ── Status / machine ─────────────────────────────────────────────────────────


@router.get("/status")
async def podman_status(_user: dict = Depends(util.get_current_user)) -> Dict[str, Any]:
    return await anyio.to_thread.run_sync(rt.runtime_status)


@router.post("/machine/start")
async def start_machine(
    request: Request,
    current_user: dict = Depends(util.get_current_user),
    db: Session = Depends(get_db),
) -> Dict[str, Any]:
    result = await _call(rt.machine_start)
    audit_log.record_for_user(
        db, current_user, action="podman.machine_start", entity_type="podman", request=request
    )
    db.commit()
    return result


# ── Containers ───────────────────────────────────────────────────────────────


class PortMapping(BaseModel):
    host: int
    container: int


class VolumeMapping(BaseModel):
    host: str
    container: str


class ContainerCreate(BaseModel):
    name: str
    image: str
    ports: List[PortMapping] = Field(default_factory=list)
    env: Dict[str, str] = Field(default_factory=dict)
    volumes: List[VolumeMapping] = Field(default_factory=list)
    pod: Optional[str] = None
    restart_policy: str = "unless-stopped"
    project_id: Optional[str] = None


class ActionRequest(BaseModel):
    action: str  # start | stop | restart | remove


@router.get("/containers")
async def list_containers(_user: dict = Depends(util.get_current_user)) -> List[Dict[str, Any]]:
    return await _call(rt.list_containers)


@router.post("/containers")
async def create_container(
    req: ContainerCreate,
    request: Request,
    current_user: dict = Depends(util.get_current_user),
    db: Session = Depends(get_db),
) -> Dict[str, Any]:
    project_id, project_name = _resolve_project(db, current_user, req.project_id)
    result = await _call(
        rt.create_container,
        name=req.name,
        image=req.image,
        ports=[p.model_dump() for p in req.ports],
        env=req.env,
        volumes=[v.model_dump() for v in req.volumes],
        pod=req.pod,
        restart_policy=req.restart_policy,
        project_id=project_id,
        project_name=project_name,
    )
    audit_log.record_for_user(
        db, current_user,
        action="podman.container_create",
        entity_type="container",
        request=request,
        extra={"name": req.name, "image": req.image, "pod": req.pod, "project_id": project_id},
    )
    db.commit()
    return result


@router.post("/containers/{name}/action")
async def container_action(
    name: str,
    req: ActionRequest,
    request: Request,
    current_user: dict = Depends(util.get_current_user),
    db: Session = Depends(get_db),
) -> Dict[str, Any]:
    await _call(rt.container_action, name, req.action)
    audit_log.record_for_user(
        db, current_user,
        action=f"podman.container_{req.action}",
        entity_type="container",
        request=request,
        extra={"name": name},
    )
    db.commit()
    return {"ok": True, "name": name, "action": req.action}


@router.get("/containers/{name}/logs")
async def container_logs(
    name: str,
    tail: int = 200,
    _user: dict = Depends(util.get_current_user),
) -> Dict[str, Any]:
    logs = await _call(rt.container_logs, name, tail)
    return {"name": name, "logs": logs}


@router.get("/containers/{name}/logs/stream")
async def container_logs_stream(
    name: str,
    tail: int = 200,
    _user: dict = Depends(util.get_current_user),
):
    """Live-follow a container's logs as Server-Sent Events.

    Each line arrives as a `data:` frame. The one-shot `/logs` endpoint above
    stays for a quick snapshot; this is what the UI opens to watch a deploy or
    a crash scroll in real time. Errors (podman down, bad name) come through as
    a single `event: error` frame rather than an HTTP status, since the stream
    has already begun by the time podman is invoked.
    """

    async def event_stream():
        # Bridge the blocking, following generator onto the event loop by
        # draining it in a worker thread and handing lines back through a
        # memory stream — same "don't block the loop" discipline as _call.
        send, receive = anyio.create_memory_object_stream(max_buffer_size=256)

        async def pump():
            try:
                gen = rt.stream_container_logs(name, tail)
                async for line in _aiter(gen):
                    await send.send(("line", line))
            except rt.PodmanError as exc:
                await send.send(("error", str(exc)))
            except Exception:  # noqa: BLE001 — surface as a clean stream error
                logger.exception("log stream failed for %s", name)
                await send.send(("error", "Log stream failed unexpectedly."))
            finally:
                await send.aclose()

        async with anyio.create_task_group() as tg:
            tg.start_soon(pump)
            async with receive:
                async for kind, payload in receive:
                    if kind == "error":
                        yield f"event: error\ndata: {payload}\n\n"
                    else:
                        yield f"data: {payload}\n\n"

    return StreamingResponse(
        event_stream(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


async def _aiter(gen):
    """Iterate a blocking generator without stalling the event loop.

    Each ``next()`` is offloaded to a worker thread; StopIteration ends it.
    """
    sentinel = object()

    def _next(it):
        try:
            return next(it)
        except StopIteration:
            return sentinel

    it = iter(gen)
    while True:
        item = await anyio.to_thread.run_sync(_next, it)
        if item is sentinel:
            return
        yield item


# ── Pods ─────────────────────────────────────────────────────────────────────


class PodCreate(BaseModel):
    name: str
    ports: List[PortMapping] = Field(default_factory=list)
    project_id: Optional[str] = None


@router.get("/pods")
async def list_pods(_user: dict = Depends(util.get_current_user)) -> List[Dict[str, Any]]:
    return await _call(rt.list_pods)


@router.post("/pods")
async def create_pod(
    req: PodCreate,
    request: Request,
    current_user: dict = Depends(util.get_current_user),
    db: Session = Depends(get_db),
) -> Dict[str, Any]:
    project_id, project_name = _resolve_project(db, current_user, req.project_id)
    result = await _call(
        rt.create_pod,
        name=req.name,
        ports=[p.model_dump() for p in req.ports],
        project_id=project_id,
        project_name=project_name,
    )
    audit_log.record_for_user(
        db, current_user,
        action="podman.pod_create",
        entity_type="pod",
        request=request,
        extra={"name": req.name, "project_id": project_id},
    )
    db.commit()
    return result


@router.post("/pods/{name}/action")
async def pod_action(
    name: str,
    req: ActionRequest,
    request: Request,
    current_user: dict = Depends(util.get_current_user),
    db: Session = Depends(get_db),
) -> Dict[str, Any]:
    await _call(rt.pod_action, name, req.action)
    audit_log.record_for_user(
        db, current_user,
        action=f"podman.pod_{req.action}",
        entity_type="pod",
        request=request,
        extra={"name": name},
    )
    db.commit()
    return {"ok": True, "name": name, "action": req.action}
