"""SPA responses must ship CSP + content-type lockdown headers.

The desktop static server already enforces these (desktop/main.js:
startStaticServer); when the desktop client points directly at the
backend (the new default in fix/desktop-direct-backend), the backend
needs to ship the same posture so the security stance is identical
regardless of entrypoint.
"""
from __future__ import annotations

from pathlib import Path

from fastapi.testclient import TestClient


def _spa_built() -> bool:
    return (Path(__file__).resolve().parents[1] / "web" / "dist" / "index.html").is_file()


def test_root_serves_csp_when_spa_is_built(anon_client: TestClient):
    """When web/dist is present, GET / serves the SPA with CSP locked down."""
    if not _spa_built():
        return  # Skip silently in environments where the SPA isn't built (CI build matrix variants)
    r = anon_client.get("/")
    assert r.status_code == 200
    csp = r.headers.get("content-security-policy", "")
    assert "default-src 'self'" in csp
    assert "frame-ancestors 'none'" in csp
    assert r.headers.get("x-content-type-options") == "nosniff"
    assert r.headers.get("x-frame-options") == "DENY"
    # Index must not be cached (post-deploy stale-bundle fix from PR #20)
    assert "no-cache" in (r.headers.get("cache-control") or "")


def test_spa_fallback_serves_csp_for_react_routes(anon_client: TestClient):
    """A request for an unknown path (React Router route) returns index.html
    with the same security headers, not a bare 404."""
    if not _spa_built():
        return
    r = anon_client.get("/some-random-react-route")
    assert r.status_code == 200
    csp = r.headers.get("content-security-policy", "")
    assert "default-src 'self'" in csp


def test_health_endpoint_unaffected(anon_client: TestClient):
    """JSON API endpoints should not be saddled with SPA-specific headers."""
    r = anon_client.get("/health")
    assert r.status_code == 200
    # Health endpoint is public JSON; no need for SPA-only no-cache marker.
    assert "no-cache, no-store" not in (r.headers.get("cache-control") or "")
