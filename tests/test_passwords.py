"""Tests for the per-user password/secrets vault (watchtower/api/passwords.py).

The security invariants get first-class coverage: the plaintext secret is
returned ONLY by /reveal, never by list/get; the audit log records the
name but never the value; entries are strictly per-user.
"""


def _create(client, name="GitHub", secret="hunter2", **extra):
    return client.post("/api/passwords", json={"name": name, "secret": secret, **extra})


def test_create_returns_metadata_without_secret(client):
    resp = _create(client, name="GitHub", secret="s3cr3t", username="octocat", url="https://github.com")
    assert resp.status_code == 201, resp.text
    body = resp.json()
    assert body["name"] == "GitHub"
    assert body["username"] == "octocat"
    assert body["url"] == "https://github.com"
    # The secret must NOT ride along on the create response.
    assert "secret" not in body
    assert "secret_encrypted" not in body


def test_create_requires_name_and_secret(client):
    assert _create(client, name="   ", secret="x").status_code == 400
    assert client.post("/api/passwords", json={"name": "X", "secret": ""}).status_code == 400


def test_list_and_get_never_expose_secret(client):
    _create(client, name="WiFi", secret="pw-wifi")
    listing = client.get("/api/passwords").json()
    assert len(listing) == 1
    assert "secret" not in listing[0] and "secret_encrypted" not in listing[0]

    entry_id = listing[0]["id"]
    got = client.get(f"/api/passwords/{entry_id}").json()
    assert "secret" not in got and "secret_encrypted" not in got


def test_reveal_returns_plaintext(client):
    entry = _create(client, name="DB", secret="p@ss-word-123").json()
    resp = client.get(f"/api/passwords/{entry['id']}/reveal")
    assert resp.status_code == 200
    assert resp.json()["secret"] == "p@ss-word-123"


def test_secret_is_encrypted_at_rest(client, db_session):
    """The stored column must be Fernet ciphertext, not the plaintext."""
    from watchtower.database import PasswordEntry

    _create(client, name="Router", secret="plaintext-should-not-persist")
    row = db_session.query(PasswordEntry).filter(PasswordEntry.name == "Router").first()
    assert row is not None
    assert "plaintext-should-not-persist" not in row.secret_encrypted


def test_reveal_is_audited_without_the_secret(client, db_session):
    from watchtower.database import AuditEvent

    entry = _create(client, name="Email", secret="top-secret-value").json()
    client.get(f"/api/passwords/{entry['id']}/reveal")

    events = (
        db_session.query(AuditEvent)
        .filter(AuditEvent.action == "password.reveal")
        .all()
    )
    assert len(events) == 1
    # The audit trail records the name but must never store the secret value.
    import json

    raw = events[0].extra_json or ""
    assert "top-secret-value" not in raw.lower()
    assert json.loads(raw).get("name") == "Email"


def test_update_changes_fields_and_secret(client):
    entry = _create(client, name="Old", secret="old-secret").json()
    eid = entry["id"]

    resp = client.put(f"/api/passwords/{eid}", json={"name": "New", "secret": "new-secret"})
    assert resp.status_code == 200
    assert resp.json()["name"] == "New"
    assert client.get(f"/api/passwords/{eid}/reveal").json()["secret"] == "new-secret"


def test_update_without_secret_keeps_old_secret(client):
    entry = _create(client, name="Keep", secret="keep-me").json()
    eid = entry["id"]
    # Update only metadata; omit secret → stored secret unchanged.
    client.put(f"/api/passwords/{eid}", json={"username": "someone"})
    assert client.get(f"/api/passwords/{eid}/reveal").json()["secret"] == "keep-me"


def test_delete_entry(client):
    entry = _create(client, name="Trash", secret="x").json()
    eid = entry["id"]
    assert client.delete(f"/api/passwords/{eid}").status_code == 204
    assert client.get(f"/api/passwords/{eid}").status_code == 404
    assert client.get(f"/api/passwords/{eid}/reveal").status_code == 404


def test_requires_auth(anon_client):
    assert anon_client.get("/api/passwords").status_code == 401
    assert anon_client.post("/api/passwords", json={"name": "x", "secret": "y"}).status_code == 401


def test_cross_user_isolation(client, db_session):
    """User A can never list / get / reveal / delete user B's secrets."""
    import uuid as _uuid

    from watchtower.api import util
    from watchtower.database import PasswordEntry, User

    other_id = _uuid.uuid4()
    db_session.add(
        User(id=other_id, email="stranger2@example.com", name="Stranger", is_active=True)
    )
    entry = PasswordEntry(
        user_id=other_id,
        name="Stranger's bank",
        secret_encrypted=util.encrypt_secret("not-yours"),
    )
    db_session.add(entry)
    db_session.commit()
    eid = str(entry.id)

    assert all(e["id"] != eid for e in client.get("/api/passwords").json())
    assert client.get(f"/api/passwords/{eid}").status_code == 404
    assert client.get(f"/api/passwords/{eid}/reveal").status_code == 404
    assert client.delete(f"/api/passwords/{eid}").status_code == 404
