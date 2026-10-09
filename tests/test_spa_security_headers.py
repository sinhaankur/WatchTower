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


def test_robots_txt_disallows_crawling(anon_client: TestClient):
    """The control-plane SPA is authenticated app UI, not public content —
    robots.txt must tell crawlers not to index it. (The marketing site is a
    separate origin with its own crawl-allowing robots.txt.)"""
    if not _spa_built():
        return
    r = anon_client.get("/robots.txt")
    assert r.status_code == 200
    body = r.text
    assert "User-agent: *" in body
    assert "Disallow: /" in body


def test_hashed_assets_are_immutable(anon_client: TestClient):
    """Content-hashed /assets bundles must be cacheable for a year + immutable.

    Vite hashes every filename, so the bytes for a given URL never change —
    the browser (and any CDN in front) can cache indefinitely and skip the
    per-chunk 304 revalidation round-trip. Regressing this back to
    StaticFiles' default (no max-age) silently reintroduces that cost and
    breaks the CDN caching contract (docs/CDN_STRATEGY.md).
    """
    assets_dir = Path(__file__).resolve().parents[1] / "web" / "dist" / "assets"
    if not assets_dir.is_dir():
        return  # SPA not built in this CI variant
    hashed = next((p for p in assets_dir.glob("*.js")), None)
    if hashed is None:
        return
    r = anon_client.get(f"/assets/{hashed.name}")
    assert r.status_code == 200
    cc = r.headers.get("cache-control") or ""
    assert "max-age=31536000" in cc
    assert "immutable" in cc
