"""Tests for the per-user photo backup vault (watchtower/api/photos.py).

Covers device registration + token issuance, upload (session and device
auth), content-hash dedup, list/get/download/delete, stats, and the
device-revocation path. Uses the shared ``client`` fixture (static API
token) from conftest; the vault writes under the test ``WATCHTOWER_DATA_DIR``.
"""

import io


PNG_BYTES = b"\x89PNG\r\n\x1a\n" + b"fake-image-data-0123456789" * 4
PNG_BYTES_2 = b"\x89PNG\r\n\x1a\n" + b"a-different-photo-payload!" * 4


def _upload(client, data: bytes, filename="photo.jpg", content_type="image/jpeg", headers=None):
    return client.post(
        "/api/photos/upload",
        files={"file": (filename, io.BytesIO(data), content_type)},
        headers=headers,
    )


# ── Device registration ──────────────────────────────────────────────────────


def test_register_device_returns_token_once(client):
    resp = client.post("/api/photos/devices", json={"label": "My Phone"})
    assert resp.status_code == 201, resp.text
    body = resp.json()
    assert body["label"] == "My Phone"
    assert body["token"].startswith("whphoto_")

    # The token is never returned again on list.
    listed = client.get("/api/photos/devices").json()
    assert len(listed) == 1
    assert "token" not in listed[0]
    assert listed[0]["id"] == body["id"]


def test_register_device_requires_label(client):
    resp = client.post("/api/photos/devices", json={"label": "   "})
    assert resp.status_code == 400


# ── Upload (session auth) + dedup ────────────────────────────────────────────


def test_upload_creates_photo(client):
    resp = _upload(client, PNG_BYTES, filename="beach.jpg")
    assert resp.status_code == 201, resp.text
    body = resp.json()
    assert body["deduplicated"] is False
    assert body["size_bytes"] == len(PNG_BYTES)
    assert body["original_filename"] == "beach.jpg"
    assert body["content_type"] == "image/jpeg"
    assert body["source"] == "device"
    assert body["status"] == "ready"
    assert len(body["sha256"]) == 64

    photos = client.get("/api/photos").json()
    assert len(photos) == 1


def test_upload_same_bytes_deduplicates(client):
    first = _upload(client, PNG_BYTES).json()
    second = _upload(client, PNG_BYTES, filename="renamed.jpg").json()

    assert second["deduplicated"] is True
    assert second["id"] == first["id"]          # same row returned
    assert len(client.get("/api/photos").json()) == 1  # not duplicated


def test_upload_different_bytes_are_separate(client):
    _upload(client, PNG_BYTES)
    _upload(client, PNG_BYTES_2)
    assert len(client.get("/api/photos").json()) == 2


def test_empty_upload_rejected(client):
    resp = _upload(client, b"")
    assert resp.status_code == 400


def test_upload_requires_auth(anon_client):
    resp = _upload(anon_client, PNG_BYTES)
    assert resp.status_code == 401


# ── Download / delete ────────────────────────────────────────────────────────


def test_download_returns_original_bytes(client):
    photo = _upload(client, PNG_BYTES).json()
    resp = client.get(f"/api/photos/{photo['id']}/content")
    assert resp.status_code == 200
    assert resp.content == PNG_BYTES


def test_get_and_delete_photo(client):
    photo = _upload(client, PNG_BYTES).json()
    pid = photo["id"]

    assert client.get(f"/api/photos/{pid}").status_code == 200

    assert client.delete(f"/api/photos/{pid}").status_code == 204
    assert client.get(f"/api/photos/{pid}").status_code == 404
    # Bytes are gone too — download 404s.
    assert client.get(f"/api/photos/{pid}/content").status_code == 404


def test_delete_after_delete_lets_reupload_recreate(client):
    photo = _upload(client, PNG_BYTES).json()
    client.delete(f"/api/photos/{photo['id']}")
    # Same bytes can be re-uploaded fresh once the row is gone (dedup was
    # per-existing-row, not a permanent tombstone).
    again = _upload(client, PNG_BYTES).json()
    assert again["deduplicated"] is False


# ── Stats ────────────────────────────────────────────────────────────────────


def test_stats_reflects_vault(client):
    assert client.get("/api/photos/stats").json() == {"photo_count": 0, "total_bytes": 0}
    _upload(client, PNG_BYTES)
    _upload(client, PNG_BYTES_2)
    stats = client.get("/api/photos/stats").json()
    assert stats["photo_count"] == 2
    assert stats["total_bytes"] == len(PNG_BYTES) + len(PNG_BYTES_2)


# ── Device-token upload path ─────────────────────────────────────────────────


def test_upload_via_device_token(anon_client, client):
    # Register a device with the authed client, then upload with ONLY the
    # device token (no Bearer) — the phone's real flow.
    token = client.post("/api/photos/devices", json={"label": "Pixel"}).json()["token"]
    resp = _upload(anon_client, PNG_BYTES, headers={"X-Photo-Device-Token": token})
    assert resp.status_code == 201, resp.text
    body = resp.json()
    assert body["device_id"] is not None

    # The photo lands in the SAME user's vault (visible to the session client).
    assert len(client.get("/api/photos").json()) == 1


def test_cross_user_isolation(client, db_session):
    """The defining vault property: user A can never see/fetch/delete user B's
    photos. Insert a row owned by a *different* user directly, then confirm
    the authed client (user A) is blind to it on every read/mutate path.
    """
    import uuid as _uuid

    from watchtower.database import PhotoBackup, PhotoBackupStatus, User

    other_id = _uuid.uuid4()
    db_session.add(
        User(id=other_id, email="stranger@example.com", name="Stranger", is_active=True)
    )
    other_photo = PhotoBackup(
        user_id=other_id,
        file_path="/nonexistent/stranger.jpg",
        sha256="ab" * 32,
        size_bytes=123,
        source="device",
        status=PhotoBackupStatus.READY,
    )
    db_session.add(other_photo)
    db_session.commit()
    pid = str(other_photo.id)

    # Not in user A's listing…
    assert all(p["id"] != pid for p in client.get("/api/photos").json())
    # …and every direct path 404s (not 403 — we don't even confirm existence).
    assert client.get(f"/api/photos/{pid}").status_code == 404
    assert client.get(f"/api/photos/{pid}/content").status_code == 404
    assert client.delete(f"/api/photos/{pid}").status_code == 404
    # Stats only count user A's (zero) photos, not the stranger's.
    assert client.get("/api/photos/stats").json()["photo_count"] == 0


def test_bad_device_token_rejected(anon_client):
    resp = _upload(anon_client, PNG_BYTES, headers={"X-Photo-Device-Token": "whphoto_nope"})
    assert resp.status_code == 401


def test_revoked_device_token_rejected(anon_client, client):
    created = client.post("/api/photos/devices", json={"label": "Old Phone"}).json()
    token = created["token"]
    # Works before revocation.
    assert _upload(anon_client, PNG_BYTES, headers={"X-Photo-Device-Token": token}).status_code == 201
    # Revoke, then the same token is rejected.
    assert client.delete(f"/api/photos/devices/{created['id']}").status_code == 204
    assert _upload(anon_client, PNG_BYTES_2, headers={"X-Photo-Device-Token": token}).status_code == 401
