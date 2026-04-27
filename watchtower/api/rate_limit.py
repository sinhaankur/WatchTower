"""Rate-limiting policy for WatchTower endpoints.

Single-operator installs typically don't sit behind a CDN/WAF, so the
auth and webhook endpoints are exposed directly to the internet. Without
rate limiting, a brute force on the GitHub OAuth state, the device-flow
poll, or the webhook HMAC has no slowdown. This module provides a single
``slowapi`` Limiter that endpoints decorate with explicit per-route
budgets.

Keying:
  - Default key is the remote address (works for unauthenticated traffic).
  - For agent chat (where cost is per-user-per-call), we key by the
    authenticated user_id so one runaway user can't burn another user's
    budget — falls back to remote address if auth hasn't run yet.

Skip rules:
  - ``/health`` and ``/api/health`` are explicitly skipped because load
    balancers, healthchecks, and the Electron launcher poll them
    aggressively during startup.

Storage:
  - Default in-memory storage. For multi-process deployments
    (gunicorn -w N), set ``WATCHTOWER_RATELIMIT_STORAGE_URL`` to a
    Redis URL so workers share the same buckets. Without it, each
    worker enforces the limit independently — the effective limit
    becomes ``limit * worker_count``.
"""
from __future__ import annotations

import os
from typing import Optional

from fastapi import Request
from slowapi import Limiter
from slowapi.errors import RateLimitExceeded
from slowapi.util import get_remote_address
from starlette.requests import Request as StarletteRequest
from starlette.responses import JSONResponse


def _key_remote(request: StarletteRequest) -> str:
    """Default key — remote IP, with X-Forwarded-For trust if behind a proxy.

    slowapi's ``get_remote_address`` already handles ``request.client.host``;
    we override only when an operator opts in to trust forwarded headers.
    """
    if os.getenv("WATCHTOWER_TRUST_FORWARDED_FOR", "false").lower() == "true":
        fwd = request.headers.get("x-forwarded-for")
        if fwd:
            # Take the first hop (the original client).
            return fwd.split(",")[0].strip() or get_remote_address(request)
    return get_remote_address(request)


def _key_user_then_remote(request: StarletteRequest) -> str:
    """Key by authenticated user_id when present, else by remote IP.

    Auth runs before the rate-limit decorator, so by the time we're
    computing the key, ``request.state.user_id`` should already be set
    if the route depends on get_current_user. We don't enforce that —
    falling back to remote IP is fine for routes that don't auth first.
    """
    user_id = getattr(request.state, "user_id", None)
    if user_id:
        return f"user:{user_id}"
    return _key_remote(request)


_HEALTH_PATHS = {"/health", "/api/health"}


def _skip_health(request: StarletteRequest) -> bool:
    """slowapi exempt callable — return True to skip rate limiting."""
    return request.url.path in _HEALTH_PATHS


# Single shared limiter — endpoints import this and decorate routes.
# headers_enabled=False because turning it on requires every rate-limited
# endpoint to also accept a `response: Response` parameter so slowapi can
# inject X-RateLimit-* headers into it. That's a lot of churn for marginal
# value — clients still get a 429 + Retry-After from the exception handler
# when over budget. If we ever want the headers, we can flip this on AND
# add `response: Response` everywhere.
limiter = Limiter(
    key_func=_key_remote,
    default_limits=[os.getenv("WATCHTOWER_RATELIMIT_DEFAULT", "1000/hour")],
    storage_uri=os.getenv("WATCHTOWER_RATELIMIT_STORAGE_URL", "memory://"),
    headers_enabled=False,
)


def rate_limit_exceeded_handler(request: Request, exc: RateLimitExceeded) -> JSONResponse:
    """Friendlier 429 than slowapi's default plain-text body.

    Returns ``{"detail": "Rate limit exceeded: <slowapi format>"}`` —
    the SPA's apiClient already handles 4xx ``detail`` strings, so this
    flows into existing error UIs without special-casing. slowapi adds
    a ``Retry-After`` header at the middleware layer.
    """
    return JSONResponse(
        status_code=429,
        content={"detail": f"Rate limit exceeded: {exc.detail}"},
    )


__all__ = [
    "limiter",
    "rate_limit_exceeded_handler",
    "_key_remote",
    "_key_user_then_remote",
    "_skip_health",
]
