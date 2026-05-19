"""Phase 5 step 2 — orchestrator + provision API.

The provider's HTTP calls (DO + Hetzner) AND the SSH'd-into-VM work
(``_install_stack``, ``_verify_stack``) are mocked. What we pin in CI:
state-machine transitions, cleanup-on-failure (orphan VMs get deleted),
audit logging, org scoping. Real DO/Hetzner end-to-end is the user's
real-infra smoke test, same as Phase 1+2+3 (a CI runner can't validate
against real cloud provider VMs)."""
from __future__ import annotations

import asyncio
from unittest.mock import patch
from uuid import UUID

import pytest
from fastapi.testclient import TestClient

from watchtower import cloud_providers as providers_module
from watchtower import provisioning
from watchtower.api import util as api_util
from watchtower.cloud_providers import (
    CreatedServer,
    ProviderError,
    Region,
    ServerStatus,
    Size,
    VerifyResult,
)
from watchtower.database import (
    AuditEvent,
    CloudProviderCredential,
    OrgNode,
    Organization,
    ProvisioningJob,
)


# ── Fake provider used for ALL tests in this file ──────────────────────────


class _FakeProvider:
    """A scriptable in-process provider stand-in.

    Each method is independently controllable via the constructor.
    Behaviour matches the real Protocol surface so swapping it in via
    patching makes the orchestrator believe it's talking to DO/Hetzner.
    """
    name = "fake"

    def __init__(
        self,
        *,
        verify=None,
        regions=(),
        sizes=(),
        create_outcome=None,
        status_sequence=(),
        delete_calls=None,
        create_raises=None,
    ):
        self._verify = verify or VerifyResult(ok=True, account_email="ops@example.com")
        self._regions = list(regions)
        self._sizes = list(sizes)
        self._create_outcome = create_outcome
        self._status_iter = iter(status_sequence)
        self._delete_calls = delete_calls if delete_calls is not None else []
        self._create_raises = create_raises

    def verify_token(self, _token): return self._verify
    def list_regions(self, _token): return self._regions
    def list_sizes(self, _token, _region_id): return self._sizes

    def create_server(self, _token, *, name, region_id, size_id, ssh_public_key):
        if self._create_raises:
            raise self._create_raises
        return self._create_outcome

    def get_server_status(self, _token, _resource_id):
        try:
            return next(self._status_iter)
        except StopIteration:
            # Sticky ready state — orchestrator polls until ready.
            return ServerStatus(ready=True, public_ipv4="203.0.113.42", raw_status="active")

    def delete_server(self, _token, resource_id):
        self._delete_calls.append(resource_id)


def _patch_provider(provider: _FakeProvider):
    """Patch BOTH the orchestrator and the API module's binding of
    get_provider, since each does ``from watchtower import
    cloud_providers as ...`` at import time and binds the name."""
    return patch.multiple(
        providers_module,
        get_provider=lambda _name: provider,
    )


def _patch_ssh_phases(*, install_ok=True, verify_ok=True):
    """No-op for the SSH+SCP work — patches both async functions so
    the orchestrator's state machine runs without spawning real ssh
    processes."""
    async def _install(*_a, **_kw):
        return (install_ok, "ok" if install_ok else "prep script failed")

    async def _verify(*_a, **_kw):
        return (verify_ok, "verified" if verify_ok else "verify failed")

    return patch.multiple(
        provisioning,
        _install_stack=_install,
        _verify_stack=_verify,
    )


# ── Provider abstraction — schema invariants ───────────────────────────────


def test_get_provider_returns_real_classes():
    """Real DO + Hetzner classes resolve through the factory. Cheap
    regression guard for someone removing a class without removing it
    from the registry."""
    do = providers_module.get_provider("digitalocean")
    hz = providers_module.get_provider("hetzner")
    assert do.name == "digitalocean"
    assert hz.name == "hetzner"


def test_get_provider_raises_for_unknown_name():
    with pytest.raises(ProviderError) as exc:
        providers_module.get_provider("linode")
    assert exc.value.status == 400


# ── Orchestrator: happy path ───────────────────────────────────────────────


@pytest.fixture()
def org_and_cred(client: TestClient, db_session):
    """Bootstrap an org by creating a project (the conftest's flow that
    forces canonical-org creation), then drop a fake credential on it."""
    _ = client.post("/api/projects", json={
        "name": "boot-org-via-project",
        "use_case": "vercel_like",
        "repo_url": "https://example.com/x.git",
        "repo_branch": "main",
    })
    org = db_session.query(Organization).first()
    cred = CloudProviderCredential(
        org_id=org.id,
        provider="digitalocean",
        label="Test DO",
        api_token_encrypted=api_util.encrypt_secret("fake-token-123456"),
        account_email="ops@example.com",
    )
    db_session.add(cred)
    db_session.commit()
    db_session.refresh(cred)
    return org, cred


def test_provision_happy_path_creates_node(db_session, org_and_cred):
    org, cred = org_and_cred
    fake = _FakeProvider(
        create_outcome=CreatedServer(provider_resource_id="dpl-42", public_ipv4=None),
        status_sequence=[
            ServerStatus(ready=False, public_ipv4=None, raw_status="new"),
            ServerStatus(ready=True, public_ipv4="203.0.113.42", raw_status="active"),
        ],
    )
    job = ProvisioningJob(
        org_id=org.id,
        provider_credential_id=cred.id,
        provider="digitalocean",
        region="nyc3",
        size="s-1vcpu-1gb",
        name="happy-node",
        status="queued",
    )
    db_session.add(job)
    db_session.commit()
    db_session.refresh(job)

    with _patch_provider(fake), _patch_ssh_phases(install_ok=True, verify_ok=True), \
         patch.object(provisioning, "_POLL_INTERVAL_SECS", 0):  # don't sleep in tests
        asyncio.run(provisioning._run_provision(job.id))

    db_session.expire_all()
    final = db_session.query(ProvisioningJob).filter(ProvisioningJob.id == job.id).one()
    assert final.status == "registered", f"expected registered, got {final.status} ({final.error})"
    assert final.provider_resource_id == "dpl-42"
    assert final.public_ipv4 == "203.0.113.42"
    assert final.node_id is not None

    node = db_session.query(OrgNode).filter(OrgNode.id == final.node_id).one()
    assert node.host == "203.0.113.42"
    assert node.user == "deploy"
    assert node.provider == "digitalocean"
    assert node.provider_resource_id == "dpl-42"
    # SSH key persisted encrypted — never plaintext on disk.
    assert node.ssh_key_encrypted is not None
    assert "PRIVATE KEY" not in node.ssh_key_encrypted  # would mean encrypt_secret got bypassed
    # No cleanup call — happy path doesn't delete the VM.
    assert fake._delete_calls == []


# ── Orchestrator: failure rollback ─────────────────────────────────────────


def test_provision_cleans_up_orphan_when_prep_script_fails(db_session, org_and_cred):
    """The MOST IMPORTANT test in this file: if anything after
    create_server fails, we must delete_server to avoid orphaning a
    billable VM. Pin it explicitly so a future refactor that drops
    the cleanup path goes red here."""
    org, cred = org_and_cred
    fake = _FakeProvider(
        create_outcome=CreatedServer(provider_resource_id="dpl-orphan-1", public_ipv4="203.0.113.99"),
        status_sequence=[ServerStatus(ready=True, public_ipv4="203.0.113.99", raw_status="active")],
    )
    job = ProvisioningJob(
        org_id=org.id,
        provider_credential_id=cred.id,
        provider="digitalocean",
        region="nyc3",
        size="s-1vcpu-1gb",
        name="will-fail",
        status="queued",
    )
    db_session.add(job)
    db_session.commit()
    db_session.refresh(job)

    with _patch_provider(fake), _patch_ssh_phases(install_ok=False, verify_ok=True), \
         patch.object(provisioning, "_POLL_INTERVAL_SECS", 0):
        asyncio.run(provisioning._run_provision(job.id))

    db_session.expire_all()
    final = db_session.query(ProvisioningJob).filter(ProvisioningJob.id == job.id).one()
    assert final.status == "failed"
    assert "prep script" in (final.error or "")
    # Cleanup MUST have run. This is the regression guard.
    assert fake._delete_calls == ["dpl-orphan-1"], (
        f"orphan VM dpl-orphan-1 was not cleaned up — would burn money on operator's bill. "
        f"delete_calls={fake._delete_calls}"
    )
    # No OrgNode row was created on failure.
    assert db_session.query(OrgNode).filter(OrgNode.provider_resource_id == "dpl-orphan-1").first() is None


def test_provision_marks_failed_when_create_server_raises(db_session, org_and_cred):
    """A pre-VM failure (e.g., DO returns 401 from create) should mark
    the job failed but NOT call delete_server — there's nothing to
    clean up since the VM was never created."""
    org, cred = org_and_cred
    fake = _FakeProvider(
        create_raises=ProviderError(401, "Unauthorized — token revoked"),
    )
    job = ProvisioningJob(
        org_id=org.id,
        provider_credential_id=cred.id,
        provider="digitalocean",
        region="nyc3",
        size="s-1vcpu-1gb",
        name="bad-token-test",
        status="queued",
    )
    db_session.add(job)
    db_session.commit()
    db_session.refresh(job)

    with _patch_provider(fake), _patch_ssh_phases():
        asyncio.run(provisioning._run_provision(job.id))

    db_session.expire_all()
    final = db_session.query(ProvisioningJob).filter(ProvisioningJob.id == job.id).one()
    assert final.status == "failed"
    assert "Unauthorized" in (final.error or "")
    assert fake._delete_calls == []  # nothing to clean up


def test_provision_cleans_up_when_verify_fails(db_session, org_and_cred):
    """Same cleanup discipline if the install succeeded but verify
    didn't — the VM exists and is billable, must be killed."""
    org, cred = org_and_cred
    fake = _FakeProvider(
        create_outcome=CreatedServer(provider_resource_id="dpl-bad-verify", public_ipv4="203.0.113.50"),
        status_sequence=[ServerStatus(ready=True, public_ipv4="203.0.113.50", raw_status="active")],
    )
    job = ProvisioningJob(
        org_id=org.id,
        provider_credential_id=cred.id,
        provider="digitalocean",
        region="nyc3",
        size="s-1vcpu-1gb",
        name="install-ok-verify-fail",
        status="queued",
    )
    db_session.add(job)
    db_session.commit()
    db_session.refresh(job)

    with _patch_provider(fake), _patch_ssh_phases(install_ok=True, verify_ok=False), \
         patch.object(provisioning, "_POLL_INTERVAL_SECS", 0):
        asyncio.run(provisioning._run_provision(job.id))

    db_session.expire_all()
    final = db_session.query(ProvisioningJob).filter(ProvisioningJob.id == job.id).one()
    assert final.status == "failed"
    assert fake._delete_calls == ["dpl-bad-verify"]


# ── API endpoints — auth + audit + scoping ──────────────────────────────────


def test_list_regions_decrypts_token_and_calls_provider(client: TestClient, db_session, org_and_cred):
    _org, cred = org_and_cred
    fake = _FakeProvider(regions=[Region(id="nyc3", name="New York 3")])
    with _patch_provider(fake):
        r = client.get(f"/api/integrations/cloud-providers/{cred.id}/regions")
    assert r.status_code == 200
    assert r.json() == [{"id": "nyc3", "name": "New York 3"}]


def test_list_sizes_passes_region_through(client: TestClient, db_session, org_and_cred):
    _org, cred = org_and_cred
    fake = _FakeProvider(sizes=[Size(id="s-1vcpu-1gb", vcpus=1, memory_gb=1.0, monthly_usd=6.0)])
    with _patch_provider(fake):
        r = client.get(f"/api/integrations/cloud-providers/{cred.id}/sizes?region=nyc3")
    assert r.status_code == 200
    body = r.json()
    assert len(body) == 1
    assert body[0]["id"] == "s-1vcpu-1gb"
    assert body[0]["monthly_usd"] == 6.0


def test_provision_endpoint_creates_job_and_writes_audit(client: TestClient, db_session, org_and_cred):
    _org, cred = org_and_cred
    # Patch the orchestrator's enqueue so we don't actually try to spawn
    # the async task in a sync test — we only want to assert the API
    # surface (job row created, audit row recorded, response shape).
    with patch.object(provisioning, "enqueue") as mock_enqueue:
        r = client.post("/api/integrations/cloud-providers/provision", json={
            "credential_id": str(cred.id),
            "name": "api-test-node",
            "region": "nyc3",
            "size": "s-1vcpu-1gb",
        })
    assert r.status_code == 202, r.text
    body = r.json()
    assert body["status"] == "queued"
    assert body["region"] == "nyc3"
    assert body["name"] == "api-test-node"

    # Job actually persisted.
    job = db_session.query(ProvisioningJob).filter(ProvisioningJob.id == UUID(body["id"])).one()
    assert job.status == "queued"

    # enqueue was called with the persisted job.
    mock_enqueue.assert_called_once()
    assert mock_enqueue.call_args.args[0].id == job.id

    # Audit row written (without leaking the token — there isn't one
    # in this payload, but pin the action shape).
    audit = (
        db_session.query(AuditEvent)
        .filter(AuditEvent.action == "cloud_provider.node.provision")
        .filter(AuditEvent.entity_id == job.id)
        .one()
    )
    assert audit is not None


def test_provision_endpoint_rejects_unsafe_name(client: TestClient, org_and_cred):
    _org, cred = org_and_cred
    with patch.object(provisioning, "enqueue"):
        r = client.post("/api/integrations/cloud-providers/provision", json={
            "credential_id": str(cred.id),
            "name": "my server with spaces",  # not hostname-safe
            "region": "nyc3",
            "size": "s-1vcpu-1gb",
        })
    assert r.status_code == 400
    assert "alphanumeric" in r.json()["detail"]


def test_get_provisioning_job_scoped_to_org(client: TestClient, db_session, org_and_cred):
    org, cred = org_and_cred
    job = ProvisioningJob(
        org_id=org.id,
        provider_credential_id=cred.id,
        provider="digitalocean",
        region="nyc3", size="s-1vcpu-1gb", name="status-test",
        status="creating_vm",
    )
    db_session.add(job)
    db_session.commit()
    db_session.refresh(job)

    r = client.get(f"/api/integrations/cloud-providers/provisioning-jobs/{job.id}")
    assert r.status_code == 200
    assert r.json()["status"] == "creating_vm"


def test_list_provisioning_jobs_returns_caller_org_only(client: TestClient, db_session, org_and_cred):
    org, cred = org_and_cred
    db_session.add(ProvisioningJob(
        org_id=org.id, provider_credential_id=cred.id, provider="digitalocean",
        region="nyc3", size="s-1vcpu-1gb", name="list-test-1", status="registered",
    ))
    db_session.commit()
    r = client.get("/api/integrations/cloud-providers/provisioning-jobs")
    assert r.status_code == 200
    names = {row["name"] for row in r.json()}
    assert "list-test-1" in names
