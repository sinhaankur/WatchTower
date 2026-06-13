"""Legal documents + click-through acceptance gate.

Pins the contract the SPA's LegalGate relies on: documents are served
with a version, status flips only after an explicit accept of the
*current* version, every acceptance is recorded append-only with
actor + version, and a version bump re-gates the user.
"""
from __future__ import annotations

from watchtower import legal_docs
from watchtower.database import LegalAcceptance


def test_documents_endpoint_serves_all_three_docs(client):
    r = client.get("/api/legal/documents")
    assert r.status_code == 200
    body = r.json()
    assert body["terms_version"] == legal_docs.TERMS_VERSION
    ids = [d["id"] for d in body["documents"]]
    assert ids == ["terms", "acceptable-use", "privacy"]
    # The load-bearing protective language is actually present.
    terms = next(d for d in body["documents"] if d["id"] == "terms")["content"]
    assert 'PROVIDED "AS IS"' in terms
    assert "LIMITATION OF LIABILITY" in terms.upper()
    assert "Indemnification" in terms


def test_documents_require_auth(anon_client):
    assert anon_client.get("/api/legal/documents").status_code in (401, 403)
    assert anon_client.get("/api/legal/status").status_code in (401, 403)
    assert anon_client.post(
        "/api/legal/accept", json={"terms_version": legal_docs.TERMS_VERSION}
    ).status_code in (401, 403)


def test_accept_flow_flips_status_and_records_row(client, db_session):
    r = client.get("/api/legal/status")
    assert r.status_code == 200
    assert r.json()["accepted"] is False

    r = client.post("/api/legal/accept", json={"terms_version": legal_docs.TERMS_VERSION})
    assert r.status_code == 200, r.text
    assert r.json()["accepted"] is True

    r = client.get("/api/legal/status")
    assert r.json()["accepted"] is True
    assert r.json()["accepted_at"] is not None

    rows = db_session.query(LegalAcceptance).all()
    assert len(rows) == 1
    assert rows[0].terms_version == legal_docs.TERMS_VERSION
    assert rows[0].accepted_at is not None


def test_accept_rejects_stale_version_echo(client):
    r = client.post("/api/legal/accept", json={"terms_version": "0.0-stale"})
    assert r.status_code == 409
    assert client.get("/api/legal/status").json()["accepted"] is False


def test_version_bump_regates_user(client, monkeypatch):
    client.post("/api/legal/accept", json={"terms_version": legal_docs.TERMS_VERSION})
    assert client.get("/api/legal/status").json()["accepted"] is True

    # Terms change → user must re-accept on next login.
    monkeypatch.setattr(legal_docs, "TERMS_VERSION", "99.0")
    assert client.get("/api/legal/status").json()["accepted"] is False


def test_repeat_acceptance_is_append_only(client, db_session):
    client.post("/api/legal/accept", json={"terms_version": legal_docs.TERMS_VERSION})
    client.post("/api/legal/accept", json={"terms_version": legal_docs.TERMS_VERSION})
    rows = db_session.query(LegalAcceptance).all()
    assert len(rows) == 2  # evidence trail, not an upsert
