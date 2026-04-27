"""Build job queue — durable scheduling for the deployment build pipeline.

Two execution modes, transparently selected at submit time:

  * **RQ on Redis** (production / compose). When ``REDIS_URL`` is set and the
    broker is reachable, builds are enqueued onto a Redis-backed RQ queue
    that one or more ``python -m watchtower.worker`` processes drain. This
    is the durable path: an API restart mid-build no longer loses the
    deployment because the worker holds a separate process.

  * **FastAPI BackgroundTasks** (dev / desktop / single-process). When
    Redis is unreachable, fall back to the existing in-process scheduler
    so ``./run.sh`` and the desktop launcher keep working without extra
    infrastructure. This preserves the "build runs after the HTTP response
    is sent" semantics that the route handlers rely on.

Both paths take ``str(deployment.id)`` and dispatch to the same builder.
The route handler does not need to know which path is active.
"""
from __future__ import annotations

import logging
import os
from typing import Any, Optional

from fastapi import BackgroundTasks

logger = logging.getLogger(__name__)

# Cached singletons. Re-evaluating Redis reachability on every enqueue would
# add an RTT to every webhook / deploy trigger; one warm probe per process is
# enough since a Redis flap will surface either way (job dies, worker logs).
_redis_client: Any | None = None
_queue: Any | None = None
_probe_failed: bool = False


def _get_queue() -> Optional[Any]:
    """Return a memoised RQ Queue if Redis is reachable, else ``None``.

    Falls back silently when the broker is missing or unreachable — the
    caller decides what to do with that.
    """
    global _redis_client, _queue, _probe_failed

    if _queue is not None:
        return _queue
    if _probe_failed:
        return None

    redis_url = os.getenv("REDIS_URL")
    if not redis_url:
        _probe_failed = True
        return None

    try:
        from redis import Redis
        from rq import Queue
        client = Redis.from_url(redis_url, socket_connect_timeout=2, socket_timeout=2)
        client.ping()
        _redis_client = client
        _queue = Queue("watchtower-builds", connection=client)
        logger.info("Build queue connected to Redis at %s", redis_url)
        return _queue
    except Exception as exc:  # noqa: BLE001 — broker reachability covers many error types
        logger.warning(
            "Redis broker unavailable (%s); builds will run in-process via "
            "FastAPI BackgroundTasks. Set REDIS_URL and run "
            "'python -m watchtower.worker' for durable scheduling.",
            exc,
        )
        _probe_failed = True
        return None


def enqueue_build(deployment_id: str, background_tasks: BackgroundTasks) -> str:
    """Submit a build for execution.

    Returns ``"queue"`` if dispatched to RQ, ``"inprocess"`` if dispatched
    via BackgroundTasks. The route handler doesn't need to act on the
    return value, but it's useful for logs and tests.

    The string form ``"watchtower.builder.run_build_sync"`` defers the
    builder import until the worker actually pops the job, which keeps the
    queue module's import graph small.
    """
    queue = _get_queue()
    if queue is not None:
        queue.enqueue(
            "watchtower.builder.run_build_sync",
            deployment_id,
            job_timeout=int(os.getenv("WATCHTOWER_BUILD_TIMEOUT_SECONDS", "1800")),
            result_ttl=86400,  # keep result for 24 h for debugging
        )
        return "queue"

    # In-process fallback. Importing here avoids loading the builder
    # (and its sqlalchemy model imports) on cold-start unless someone
    # actually triggers a build.
    from watchtower import builder as build_runner
    background_tasks.add_task(build_runner.run_build_async, deployment_id)
    return "inprocess"


def reset_for_tests() -> None:
    """Clear the cached queue / probe state.

    Tests may set REDIS_URL before / after import; without this, the first
    probe sticks for the whole test session.
    """
    global _redis_client, _queue, _probe_failed
    _redis_client = None
    _queue = None
    _probe_failed = False
