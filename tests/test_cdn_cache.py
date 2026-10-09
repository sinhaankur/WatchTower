"""CDN feature: cache-purge helper + trusted-proxy client-IP resolution.

Covers the two pieces the CDN feature adds outside the DNS-sync path:
  * ``cloudflare_dns.purge_cache`` — full-zone vs by-URL purge, 404 tolerance.
  * ``rate_limit.client_ip`` — CF-Connecting-IP / X-Forwarded-For precedence,
    gated on WATCHTOWER_TRUST_FORWARDED_FOR so headers aren't spoofable when
    WatchTower is directly exposed.
"""
from __future__ import annotations

from types import SimpleNamespace
from unittest.mock import patch

import pytest

from watchtower import cloudflare_dns
from watchtower.api.rate_limit import client_ip


# ── purge_cache ──────────────────────────────────────────────────────────────


def test_purge_cache_full_zone_by_default():
    with patch.object(cloudflare_dns, "_cf_post", return_value={"success": True}) as mock_post:
        cloudflare_dns.purge_cache("tok", "zone-1")
    path = mock_post.call_args.args[1]
    body = mock_post.call_args.args[2]
    assert path == "/zones/zone-1/purge_cache"
    assert body == {"purge_everything": True}


def test_purge_cache_by_url_when_files_given():
    urls = ["https://x.example.com/app.js", "https://x.example.com/style.css"]
    with patch.object(cloudflare_dns, "_cf_post", return_value={"success": True}) as mock_post:
        cloudflare_dns.purge_cache("tok", "zone-1", files=urls)
    assert mock_post.call_args.args[2] == {"files": urls}


def test_purge_cache_404_is_success():
    """A missing zone has no cache to purge — treat 404 as done, not error."""
    with patch.object(
        cloudflare_dns, "_cf_post",
        side_effect=cloudflare_dns.CloudflareDnsError(404, "zone gone"),
    ):
        # Must not raise.
        cloudflare_dns.purge_cache("tok", "zone-gone")


def test_purge_cache_reraises_non_404():
    with patch.object(
        cloudflare_dns, "_cf_post",
        side_effect=cloudflare_dns.CloudflareDnsError(403, "bad token"),
    ):
        with pytest.raises(cloudflare_dns.CloudflareDnsError):
            cloudflare_dns.purge_cache("tok", "zone-1")


# ── client_ip ────────────────────────────────────────────────────────────────


def _req(headers: dict, peer: str = "10.0.0.1"):
    return SimpleNamespace(
        headers={k.lower(): v for k, v in headers.items()},
        client=SimpleNamespace(host=peer),
    )


def test_client_ip_ignores_headers_without_trust_flag(monkeypatch):
    """Without the trust flag, forwarded headers are attacker-controllable —
    fall back to the socket peer, never the header."""
    monkeypatch.delenv("WATCHTOWER_TRUST_FORWARDED_FOR", raising=False)
    req = _req({"CF-Connecting-IP": "1.2.3.4", "X-Forwarded-For": "5.6.7.8"}, peer="10.0.0.1")
    assert client_ip(req) == "10.0.0.1"


def test_client_ip_prefers_cf_connecting_ip_when_trusted(monkeypatch):
    monkeypatch.setenv("WATCHTOWER_TRUST_FORWARDED_FOR", "true")
    req = _req({"CF-Connecting-IP": "1.2.3.4", "X-Forwarded-For": "5.6.7.8, 9.9.9.9"})
    assert client_ip(req) == "1.2.3.4"


def test_client_ip_falls_back_to_xff_first_hop(monkeypatch):
    monkeypatch.setenv("WATCHTOWER_TRUST_FORWARDED_FOR", "true")
    req = _req({"X-Forwarded-For": "5.6.7.8, 9.9.9.9"})
    assert client_ip(req) == "5.6.7.8"


def test_client_ip_socket_peer_when_no_headers(monkeypatch):
    monkeypatch.setenv("WATCHTOWER_TRUST_FORWARDED_FOR", "true")
    req = _req({}, peer="10.0.0.5")
    assert client_ip(req) == "10.0.0.5"


# ── zone_analytics ───────────────────────────────────────────────────────────


class _FakeResp:
    def __init__(self, status_code, payload):
        self.status_code = status_code
        self._payload = payload
        self.text = str(payload)

    def json(self):
        return self._payload


def test_zone_analytics_sums_daily_groups():
    payload = {
        "data": {"viewer": {"zones": [{"httpRequests1dGroups": [
            {"sum": {"requests": 600, "cachedRequests": 570, "bytes": 6_000_000, "cachedBytes": 5_600_000}},
            {"sum": {"requests": 400, "cachedRequests": 370, "bytes": 4_000_000, "cachedBytes": 3_700_000}},
        ]}]}},
        "errors": None,
    }
    with patch.object(cloudflare_dns.requests, "post", return_value=_FakeResp(200, payload)):
        stats = cloudflare_dns.zone_analytics("tok", "zone-1", days=7)
    assert stats.total_requests == 1000
    assert stats.cached_requests == 940
    assert stats.bytes_saved == 9_300_000
    assert round(stats.cache_hit_ratio, 2) == 0.94


def test_zone_analytics_zero_traffic_is_not_an_error():
    payload = {"data": {"viewer": {"zones": [{"httpRequests1dGroups": []}]}}, "errors": None}
    with patch.object(cloudflare_dns.requests, "post", return_value=_FakeResp(200, payload)):
        stats = cloudflare_dns.zone_analytics("tok", "zone-empty")
    assert stats.total_requests == 0
    assert stats.cache_hit_ratio == 0.0  # no divide-by-zero


def test_zone_analytics_graphql_errors_raise():
    payload = {"data": None, "errors": [{"message": "not authorized"}]}
    with patch.object(cloudflare_dns.requests, "post", return_value=_FakeResp(200, payload)):
        with pytest.raises(cloudflare_dns.CloudflareDnsError):
            cloudflare_dns.zone_analytics("tok", "zone-1")


def test_zone_analytics_403_maps_to_actionable_error():
    with patch.object(cloudflare_dns.requests, "post", return_value=_FakeResp(403, {})):
        with pytest.raises(cloudflare_dns.CloudflareDnsError) as ei:
            cloudflare_dns.zone_analytics("tok", "zone-1")
    assert ei.value.status == 403
    assert "Analytics: Read" in ei.value.detail
