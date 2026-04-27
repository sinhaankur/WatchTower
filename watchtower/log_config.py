"""Structured logging for WatchTower.

Two modes, selectable via ``WATCHTOWER_LOG_FORMAT``:

  * ``text`` (default) — the human-readable line format we've always used.
    Best for local dev and tail-following ``/tmp/watchtower-api.log``.
  * ``json`` — one JSON object per line, with stable field names. Best for
    ingestion into log aggregators (Loki, Datadog, ELK, CloudWatch). Every
    record carries the request_id when emitted from inside a request handler.

Centralising the setup here also fixes the silent double-init the audit
flagged: ``api/__init__.py`` and ``deploy_server.py`` previously both called
``logging.basicConfig`` at module load — whichever ran first won, the
second was ignored. Both now call ``setup_logging()`` which is idempotent.

Request ID flow:
  request_id_middleware()  →  contextvar `_request_id_ctx`  →  formatter
  ┌────────────┐                ┌──────────────┐                ┌───────────┐
  │ HTTP enter │ ─uuid4()────▶ │ ContextVar   │ ─.get()──────▶ │ JSON line │
  │ middleware │                │ (per task)   │                │           │
  └────────────┘                └──────────────┘                └───────────┘
"""
from __future__ import annotations

import contextvars
import json
import logging
import os
import sys
import uuid
from typing import Any, Callable, Optional

# ── Request ID context ───────────────────────────────────────────────────────
# contextvars are async-safe — each task gets its own value, so concurrent
# requests don't see each other's IDs. The default empty string keeps the
# JSON formatter from breaking when logging fires outside any request.
_request_id_ctx: contextvars.ContextVar[str] = contextvars.ContextVar(
    "watchtower_request_id", default=""
)


def get_request_id() -> str:
    """Current request ID, or '' if not inside a request handler."""
    return _request_id_ctx.get()


def bind_request_id(request_id: str) -> contextvars.Token:
    """Set the current request ID; returns a token the caller MUST reset()."""
    return _request_id_ctx.set(request_id)


def reset_request_id(token: contextvars.Token) -> None:
    _request_id_ctx.reset(token)


# ── Formatters ───────────────────────────────────────────────────────────────

class _RequestIdFilter(logging.Filter):
    """Always populate ``record.request_id`` so format strings never KeyError."""
    def filter(self, record: logging.LogRecord) -> bool:
        record.request_id = get_request_id() or "-"
        return True


class _JsonFormatter(logging.Formatter):
    """Stable, sorted-key JSON formatter.

    Reserved field set:
      - ``ts``       ISO 8601 UTC
      - ``level``    log level name
      - ``logger``   logger name (e.g. watchtower.api.webhooks)
      - ``message``  the formatted log message
      - ``request_id``   the contextvar — '-' if outside a request
      - ``exception``    formatted traceback when an exception was raised
    """

    _RESERVED = {
        "args", "asctime", "created", "exc_info", "exc_text", "filename",
        "funcName", "levelname", "levelno", "lineno", "message", "module",
        "msecs", "msg", "name", "pathname", "process", "processName",
        "relativeCreated", "stack_info", "thread", "threadName",
        "request_id",  # we surface this explicitly
    }

    def format(self, record: logging.LogRecord) -> str:
        from datetime import datetime, timezone
        payload: dict[str, Any] = {
            "ts": datetime.fromtimestamp(record.created, tz=timezone.utc).isoformat(),
            "level": record.levelname,
            "logger": record.name,
            "message": record.getMessage(),
            "request_id": getattr(record, "request_id", "-"),
        }
        # Surface anything passed via logger.info("...", extra={...}).
        for key, value in record.__dict__.items():
            if key in self._RESERVED or key.startswith("_"):
                continue
            try:
                json.dumps(value)  # only include JSON-serialisable extras
                payload[key] = value
            except TypeError:
                payload[key] = repr(value)
        if record.exc_info:
            payload["exception"] = self.formatException(record.exc_info)
        return json.dumps(payload, sort_keys=True)


# ── Setup ─────────────────────────────────────────────────────────────────────

_LOGGING_INITIALIZED = False


def setup_logging(format_override: Optional[str] = None) -> None:
    """Configure root logging once per process.

    Idempotent — calling this multiple times (e.g. from both
    ``api/__init__.py`` and a worker entrypoint) is safe and a no-op
    after the first call. If callers want to reconfigure, they have to
    reset ``_LOGGING_INITIALIZED`` themselves (used by tests).

    Reads:
      - ``WATCHTOWER_LOG_FORMAT``   ``"text"`` (default) or ``"json"``
      - ``LOG_LEVEL``               ``DEBUG``/``INFO``/``WARNING``/``ERROR``
                                    (default ``INFO``)
    """
    global _LOGGING_INITIALIZED
    if _LOGGING_INITIALIZED:
        return

    fmt = (format_override or os.getenv("WATCHTOWER_LOG_FORMAT", "text")).lower()
    level = os.getenv("LOG_LEVEL", "INFO").upper()

    handler = logging.StreamHandler(sys.stderr)
    handler.addFilter(_RequestIdFilter())
    if fmt == "json":
        handler.setFormatter(_JsonFormatter())
    else:
        # Text format — request_id is last so it doesn't dominate the line
        # for the common case (no request context = "-").
        handler.setFormatter(logging.Formatter(
            "%(asctime)s %(levelname)-7s %(name)s [req=%(request_id)s] %(message)s",
        ))

    root = logging.getLogger()
    # Replace existing handlers so we don't get duplicate lines when callers
    # invoked logging.basicConfig before us.
    for h in list(root.handlers):
        root.removeHandler(h)
    root.addHandler(handler)
    root.setLevel(level)

    _LOGGING_INITIALIZED = True


def reset_for_tests() -> None:
    """Allow tests to reconfigure logging by clearing the init flag."""
    global _LOGGING_INITIALIZED
    _LOGGING_INITIALIZED = False


# ── FastAPI middleware ───────────────────────────────────────────────────────

async def request_id_middleware(request, call_next: Callable):
    """Generate or propagate ``X-Request-ID`` on every request.

    If the client supplies an ``X-Request-ID`` header (e.g. an upstream
    proxy did), reuse it — this is essential for end-to-end tracing.
    Otherwise generate a fresh UUID4. Both go into the contextvar (so log
    records pick them up) and onto the response (so clients can correlate).
    """
    incoming = request.headers.get("x-request-id") or ""
    request_id = incoming.strip() or uuid.uuid4().hex
    token = bind_request_id(request_id)
    try:
        response = await call_next(request)
    finally:
        reset_request_id(token)
    response.headers["X-Request-ID"] = request_id
    return response
