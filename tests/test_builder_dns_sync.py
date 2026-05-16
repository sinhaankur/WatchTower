"""Phase 3 of autonomous global-deploy: post-deploy Cloudflare DNS sync.

Verifies the contract of ``_sync_dns_for_project`` and
``_pick_dns_target_node`` — what runs, what's skipped, and what happens
when Cloudflare fails. The Cloudflare HTTP module is mocked so no real
API calls happen.
"""

from __future__ import annotations

import asyncio
import uuid
from unittest.mock import patch
import pytest

from watchtower import builder, cloudflare_dns
from watchtower.api import util as api_util
from watchtower.database import (
    CloudflareCredential,
    CustomDomain,
    Organization,
    OrgNode,
    Project,
    SessionLocal,
    UseCaseType,
)


@pytest.fixture()
def db():
    s = SessionLocal()
    yield s
    s.close()


@pytest.fixture()
def org(db):
    o = Organization(id=uuid.uuid4(), name="dns-test-org")
    db.add(o)
    db.commit()
    db.refresh(o)
    return o


@pytest.fixture()
def project(db, org):
    p = Project(
        id=uuid.uuid4(),
        name="dns-target",
        use_case=UseCaseType.NETLIFY_LIKE,
        repo_url="https://github.com/example/site",
        repo_branch="main",
        webhook_secret="secret",
        org_id=org.id,
        recommended_port=8083,
        run_as_container=True,
    )
    db.add(p)
    db.commit()
    db.refresh(p)
    return p


@pytest.fixture()
def credential(db, org):
    """A real CloudflareCredential row with an encrypted token. We don't
    decrypt the token in tests — the cloudflare_dns module is mocked at
    the call site instead — but having a real row means
    ``util.decrypt_secret`` can resolve it and we exercise the actual
    credential-lookup path, not a mocked one."""
    cred = CloudflareCredential(
        id=uuid.uuid4(),
        org_id=org.id,
        label="test-cred",
        api_token_encrypted=api_util.encrypt_secret("fake-cf-token"),
    )
    db.add(cred)
    db.commit()
    db.refresh(cred)
    return cred


def _node(org_id, host, is_primary=False):
    return OrgNode(
        id=uuid.uuid4(),
        org_id=org_id,
        name=f"node-{host}",
        host=host,
        user="deploy",
        port=22,
        remote_path=f"/srv/{host}",
        is_primary=is_primary,
    )


# ---------------------------------------------------------------------------
# _pick_dns_target_node
# ---------------------------------------------------------------------------


def test_pick_dns_target_returns_none_for_empty(org):
    assert builder._pick_dns_target_node([]) is None


def test_pick_dns_target_prefers_is_primary(org):
    a = _node(org.id, "1.1.1.1")
    b = _node(org.id, "2.2.2.2", is_primary=True)
    c = _node(org.id, "3.3.3.3")
    # is_primary wins regardless of ordering — we don't want surprise
    # "first listed" behaviour when an operator explicitly marked a node.
    assert builder._pick_dns_target_node([a, b, c]) is b


def test_pick_dns_target_falls_back_to_first(org):
    a = _node(org.id, "1.1.1.1")
    b = _node(org.id, "2.2.2.2")
    # No primary marked → first node. That mirrors the deploy ordering
    # the operator already sees in the UI.
    assert builder._pick_dns_target_node([a, b]) is a


# ---------------------------------------------------------------------------
# _sync_dns_for_project — short-circuits
# ---------------------------------------------------------------------------


def test_sync_dns_skips_when_no_managed_domains(db, project, org):
    """A domain without ``cloudflare_credential_id`` is left alone —
    operator hasn't opted in. No Cloudflare calls should be made."""
    db.add(CustomDomain(
        id=uuid.uuid4(),
        project_id=project.id,
        domain="unmanaged.example.com",
        cloudflare_credential_id=None,
    ))
    db.commit()
    node = _node(org.id, "1.2.3.4")

    captured: list[str] = []
    with patch.object(cloudflare_dns, "sync_a_record") as mock_sync:
        asyncio.run(builder._sync_dns_for_project(db, project, [node], captured.append))
    mock_sync.assert_not_called()


def test_sync_dns_skips_when_target_node_has_no_host(db, project, org, credential):
    """If the chosen target node has an empty/None host (malformed config),
    surface a clear warning rather than calling Cloudflare with an
    invalid IP — the resulting record would route to nothing."""
    db.add(CustomDomain(
        id=uuid.uuid4(),
        project_id=project.id,
        domain="x.example.com",
        cloudflare_credential_id=credential.id,
    ))
    db.commit()
    node = _node(org.id, "")  # empty host
    captured: list[str] = []
    with patch.object(cloudflare_dns, "sync_a_record") as mock_sync:
        asyncio.run(builder._sync_dns_for_project(db, project, [node], captured.append))
    mock_sync.assert_not_called()
    assert any("no host IP" in line for line in captured)


def test_sync_dns_skips_when_record_already_points_at_target(db, project, org, credential):
    """The Cloudflare API is billed and rate-limited — when the record
    is already pointing where we'd put it, skip the round-trip."""
    db.add(CustomDomain(
        id=uuid.uuid4(),
        project_id=project.id,
        domain="cached.example.com",
        cloudflare_credential_id=credential.id,
        cloudflare_zone_id="zone-abc",
        cloudflare_record_id="rec-xyz",
        cloudflare_target_ip="9.9.9.9",
    ))
    db.commit()
    node = _node(org.id, "9.9.9.9")
    captured: list[str] = []
    with patch.object(cloudflare_dns, "sync_a_record") as mock_sync:
        asyncio.run(builder._sync_dns_for_project(db, project, [node], captured.append))
    mock_sync.assert_not_called()
    assert any("already → 9.9.9.9" in line for line in captured)


# ---------------------------------------------------------------------------
# _sync_dns_for_project — happy paths
# ---------------------------------------------------------------------------


def test_sync_dns_calls_sync_a_record_with_target_ip(db, project, org, credential):
    db.add(CustomDomain(
        id=uuid.uuid4(),
        project_id=project.id,
        domain="fresh.example.com",
        cloudflare_credential_id=credential.id,
    ))
    db.commit()
    node = _node(org.id, "5.5.5.5")

    fake_result = cloudflare_dns.SyncResult(
        record_id="rec-new",
        zone_id="zone-new",
        zone_name="example.com",
        target_ip="5.5.5.5",
    )

    captured: list[str] = []
    with patch.object(cloudflare_dns, "sync_a_record", return_value=fake_result) as mock_sync:
        asyncio.run(builder._sync_dns_for_project(db, project, [node], captured.append))

    mock_sync.assert_called_once()
    args, kwargs = mock_sync.call_args
    # Positional: (token, domain, target_ip)
    assert args[1] == "fresh.example.com"
    assert args[2] == "5.5.5.5"
    # proxied=False is the Phase 3 default — see helper docstring
    assert kwargs.get("proxied") is False

    # The helper mutates rows but relies on the caller to commit
    # (mirrors how _run_build wraps it in the same transaction as the
    # deployment.status flip). Commit + reload to assert the persisted
    # state, the same way an API consumer would see it.
    db.commit()
    db.expire_all()
    domain = db.query(CustomDomain).filter(CustomDomain.domain == "fresh.example.com").first()
    assert domain.cloudflare_zone_id == "zone-new"
    assert domain.cloudflare_record_id == "rec-new"
    assert domain.cloudflare_target_ip == "5.5.5.5"
    assert domain.cloudflare_synced_at is not None


def test_sync_dns_uses_primary_node_when_marked(db, project, org, credential):
    """Multi-node deploy: DNS should point at the primary, not whichever
    node happened to be first in the list."""
    db.add(CustomDomain(
        id=uuid.uuid4(),
        project_id=project.id,
        domain="ha.example.com",
        cloudflare_credential_id=credential.id,
    ))
    db.commit()
    secondary = _node(org.id, "1.1.1.1")
    primary = _node(org.id, "2.2.2.2", is_primary=True)

    fake = cloudflare_dns.SyncResult(record_id="r", zone_id="z", zone_name="example.com", target_ip="2.2.2.2")
    with patch.object(cloudflare_dns, "sync_a_record", return_value=fake) as mock_sync:
        asyncio.run(builder._sync_dns_for_project(db, project, [secondary, primary], lambda _l: None))
    assert mock_sync.call_args.args[2] == "2.2.2.2"


# ---------------------------------------------------------------------------
# _sync_dns_for_project — failure isolation
# ---------------------------------------------------------------------------


def test_sync_dns_failure_does_not_raise(db, project, org, credential):
    """Cloudflare 5xx during sync must not propagate — the deploy is
    already conceptually live and a CF outage shouldn't roll it back."""
    db.add(CustomDomain(
        id=uuid.uuid4(),
        project_id=project.id,
        domain="cf-down.example.com",
        cloudflare_credential_id=credential.id,
    ))
    db.commit()
    node = _node(org.id, "1.2.3.4")

    captured: list[str] = []
    with patch.object(
        cloudflare_dns,
        "sync_a_record",
        side_effect=cloudflare_dns.CloudflareDnsError(status=502, detail="Bad gateway"),
    ):
        # The key assertion is: this does not raise.
        asyncio.run(builder._sync_dns_for_project(db, project, [node], captured.append))

    # Operator needs an actionable message in the build log.
    assert any("cf-down.example.com" in line and "502" in line for line in captured)
    assert any("Retry from the Domains tab" in line for line in captured)


def test_sync_dns_per_domain_failures_are_independent(db, project, org, credential):
    """One domain's CF error must not stop the others — they're each a
    separate Cloudflare API call and there's no transactional coupling."""
    db.add(CustomDomain(
        id=uuid.uuid4(), project_id=project.id,
        domain="ok.example.com", cloudflare_credential_id=credential.id,
    ))
    db.add(CustomDomain(
        id=uuid.uuid4(), project_id=project.id,
        domain="boom.example.com", cloudflare_credential_id=credential.id,
    ))
    db.commit()
    node = _node(org.id, "3.3.3.3")

    def fake_sync(token, domain, target_ip, **_kw):
        if domain == "boom.example.com":
            raise cloudflare_dns.CloudflareDnsError(status=400, detail="zone not found")
        return cloudflare_dns.SyncResult(record_id="r1", zone_id="z1", zone_name="example.com", target_ip=target_ip)

    captured: list[str] = []
    with patch.object(cloudflare_dns, "sync_a_record", side_effect=fake_sync):
        asyncio.run(builder._sync_dns_for_project(db, project, [node], captured.append))

    db.commit()
    db.expire_all()
    ok_dom = db.query(CustomDomain).filter(CustomDomain.domain == "ok.example.com").first()
    boom_dom = db.query(CustomDomain).filter(CustomDomain.domain == "boom.example.com").first()
    # ok.example.com synced; boom.example.com left at its prior state.
    assert ok_dom.cloudflare_target_ip == "3.3.3.3"
    assert boom_dom.cloudflare_target_ip is None
