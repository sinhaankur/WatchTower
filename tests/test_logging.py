"""Tests for watchtower.log_config — JSON formatter, request-ID middleware,
idempotent setup, contextvar isolation across requests."""
from __future__ import annotations

import json
import logging
import uuid

import pytest
from fastapi.testclient import TestClient

from watchtower.log_config import (
    _JsonFormatter,
    _RequestIdFilter,
    bind_request_id,
    get_request_id,
    reset_for_tests,
    reset_request_id,
    setup_logging,
)


# ── Formatter unit tests ─────────────────────────────────────────────────────

def _make_record(msg: str = "hello", **extra) -> logging.LogRecord:
    rec = logging.LogRecord(
        name="watchtower.test",
        level=logging.INFO,
        pathname=__file__,
        lineno=1,
        msg=msg,
        args=None,
        exc_info=None,
    )
    for k, v in extra.items():
        setattr(rec, k, v)
    _RequestIdFilter().filter(rec)
    return rec


def test_json_formatter_basic_shape():
    rec = _make_record("login failed", user="alice")
    out = _JsonFormatter().format(rec)
    payload = json.loads(out)
    assert payload["level"] == "INFO"
    assert payload["logger"] == "watchtower.test"
    assert payload["message"] == "login failed"
    assert "ts" in payload
    assert payload["request_id"] == "-"  # no request context set
    # `extra=` keys are surfaced
    assert payload["user"] == "alice"


def test_json_formatter_includes_request_id_when_bound():
    token = bind_request_id("rid-abcd1234")
    try:
        rec = _make_record("inside request")
        payload = json.loads(_JsonFormatter().format(rec))
        assert payload["request_id"] == "rid-abcd1234"
    finally:
        reset_request_id(token)


def test_json_formatter_handles_non_serialisable_extras():
    """A non-JSON-serialisable extra (e.g. a datetime) shouldn't crash logging."""
    class NotJsonable:
        def __repr__(self) -> str:
            return "<not-jsonable>"
    rec = _make_record("oops", weird=NotJsonable())
    payload = json.loads(_JsonFormatter().format(rec))
    assert payload["weird"] == "<not-jsonable>"


def test_json_formatter_includes_exception():
    try:
        raise ValueError("boom")
    except ValueError:
        import sys
        rec = logging.LogRecord(
            name="x", level=logging.ERROR, pathname=__file__, lineno=1,
            msg="caught", args=None, exc_info=sys.exc_info(),
        )
        _RequestIdFilter().filter(rec)
    payload = json.loads(_JsonFormatter().format(rec))
    assert "exception" in payload
    assert "ValueError: boom" in payload["exception"]


# ── setup_logging idempotency ────────────────────────────────────────────────

def test_setup_logging_is_idempotent(monkeypatch):
    """Calling setup_logging twice should not stack handlers."""
    reset_for_tests()
    setup_logging("text")
    handlers_after_first = list(logging.getLogger().handlers)
    setup_logging("text")
    handlers_after_second = list(logging.getLogger().handlers)
    assert handlers_after_first == handlers_after_second


def test_setup_logging_replaces_existing_handlers(monkeypatch):
    """If something else (e.g. uvicorn) already added a handler, we replace it
    instead of stacking — otherwise every log line would print twice."""
    reset_for_tests()
    root = logging.getLogger()
    sentinel = logging.NullHandler()
    sentinel._wt_marker = "should-be-gone"  # type: ignore[attr-defined]
    root.addHandler(sentinel)

    setup_logging("text")
    assert sentinel not in root.handlers


# ── Middleware: request-ID flow ──────────────────────────────────────────────

def test_request_id_response_header_present(client: TestClient):
    """Every response must carry X-Request-ID — even from /health."""
    r = client.get("/health")
    rid = r.headers.get("X-Request-ID")
    assert rid, "X-Request-ID header is missing"
    # Default-generated IDs are uuid4 hex (32 chars).
    assert len(rid) == 32 and all(c in "0123456789abcdef" for c in rid)


def test_request_id_passthrough_when_client_supplies_one(client: TestClient):
    """If the caller (or upstream proxy) sends X-Request-ID, we MUST reuse it
    — that's the whole point: trace IDs flow through end-to-end."""
    custom = "trace-" + uuid.uuid4().hex[:12]
    r = client.get("/health", headers={"X-Request-ID": custom})
    assert r.headers.get("X-Request-ID") == custom


def test_request_ids_are_isolated_across_concurrent_requests(client: TestClient):
    """Two requests in quick succession must each get their own ID."""
    r1 = client.get("/health")
    r2 = client.get("/health")
    assert r1.headers["X-Request-ID"] != r2.headers["X-Request-ID"]


def test_get_request_id_is_empty_outside_a_request():
    """Sanity: outside any HTTP request the contextvar default applies."""
    # No bind_request_id() call → empty.
    assert get_request_id() == ""
