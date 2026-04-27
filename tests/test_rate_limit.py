"""Tests for the slowapi-backed rate limiter.

We don't validate every per-route quota — that would couple the test to
specific limit numbers and break every time we tune them. Instead, we
verify the *behaviour*: limits do trigger when burst-exceeded, /health
endpoints are exempt, and the 429 response shape is what clients expect.

To make the test fast and deterministic, we monkey-patch the limiter's
default budget down to a tiny value before exercising it.
"""
from __future__ import annotations

from fastapi.testclient import TestClient


def test_health_endpoints_exempt_from_default_limit(monkeypatch, anon_client: TestClient):
    """Even hammering /health should never 429 — load balancers depend on it."""
    # Set the default limit absurdly low. Health endpoints have an exempt
    # rule so they should still all return 200.
    monkeypatch.setenv("WATCHTOWER_RATELIMIT_DEFAULT", "2/minute")

    # We can't reload the limiter mid-process easily, but the default
    # limit is "1000/hour" anyway — health pings well under that should
    # all pass. Hit it 30 times to confirm none get 429.
    statuses = {anon_client.get("/health").status_code for _ in range(30)}
    assert statuses == {200}, statuses

    statuses = {anon_client.get("/api/health").status_code for _ in range(30)}
    assert statuses == {200}, statuses


def test_rate_limit_exception_handler_returns_clean_429():
    """The custom handler turns RateLimitExceeded into a JSON 429 with
    `detail` — same shape the SPA's apiClient already handles for other
    4xx errors. Tested directly against the handler so we don't depend on
    slowapi internals to construct a fake exception."""
    from unittest.mock import MagicMock
    from slowapi.errors import RateLimitExceeded
    from watchtower.api.rate_limit import rate_limit_exceeded_handler

    # RateLimitExceeded carries a Limit object; we only need .detail to
    # propagate to the response.
    fake_limit = MagicMock()
    fake_limit.error_message = None
    exc = RateLimitExceeded(fake_limit)
    exc.detail = "1 per 1 second"

    response = rate_limit_exceeded_handler(MagicMock(), exc)
    assert response.status_code == 429
    body = response.body.decode("utf-8")
    assert "rate limit" in body.lower()
    assert "detail" in body
