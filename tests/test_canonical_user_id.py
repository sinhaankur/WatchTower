"""Regression tests for util.canonical_user_id.

Background — the bug this guards against:

The static-token auth path derives ``current_user["user_id"]`` deterministically
from the API token via UUID5. When the operator rotates ``WATCHTOWER_API_TOKEN``
(or Electron generates a fresh per-launch token) the synthetic id diverges from
any User row already in the DB, but the email stays the same. Read-path filters
that compared ``Project.owner_id`` to the synthetic id silently matched nothing
and the user's projects vanished from the UI even though they were saved.

These tests lock both branches of the resolver so the bug can't quietly come
back if someone "simplifies" it.
"""
from __future__ import annotations

import uuid

from watchtower.api import util
from watchtower.database import User


def _new_user(db, *, email: str, name: str = "Tester", uid: uuid.UUID | None = None) -> User:
    user = User(
        id=uid or uuid.uuid4(),
        email=email,
        name=name,
        is_active=True,
    )
    db.add(user)
    db.commit()
    db.refresh(user)
    return user


def test_canonical_user_id_returns_directly_when_synthetic_matches_user_row(db_session):
    """Path 1: synthetic id is already canonical (the User.id) — return as-is.

    Without this branch, someone "simplifies" the resolver to email-only and
    breaks session tokens that already carry the canonical id.
    """
    syn_id = uuid.uuid4()
    user = _new_user(db_session, email="alice@example.com", uid=syn_id)

    resolved = util.canonical_user_id(
        db_session,
        {"user_id": str(syn_id), "email": "alice@example.com"},
    )

    assert resolved == user.id == syn_id


def test_canonical_user_id_falls_back_to_email_when_synthetic_misses(db_session):
    """Path 2: synthetic id has no User row, email matches — return canonical.

    This is the actual production bug: token rotates, synthetic UUID5
    changes, but the email is stable. Resolver must find the canonical user.
    """
    canonical = _new_user(db_session, email="alice@example.com")
    other_synthetic = uuid.uuid4()  # not in DB
    assert other_synthetic != canonical.id

    resolved = util.canonical_user_id(
        db_session,
        {"user_id": str(other_synthetic), "email": "alice@example.com"},
    )

    assert resolved == canonical.id


def test_canonical_user_id_email_lookup_is_case_insensitive(db_session):
    """The DB stores ``alice@example.com`` (lowercase). A session token can
    legitimately carry ``Alice@Example.COM`` (per RFC the local part is case-
    sensitive but most providers lowercase). Match anyway — otherwise the
    fallback silently returns the synthetic id and looks like the bug.
    """
    canonical = _new_user(db_session, email="alice@example.com")

    resolved = util.canonical_user_id(
        db_session,
        {"user_id": str(uuid.uuid4()), "email": "Alice@Example.COM"},
    )

    assert resolved == canonical.id


def test_canonical_user_id_returns_synthetic_when_no_user_row_exists(db_session):
    """Genuinely-new caller — no DB row yet. Return the synthetic id so
    ``_ensure_user_org_member`` can use it as the seed for the new User row
    (its create-on-first-use path needs a stable id from the auth layer).

    DO NOT change this to raise — that breaks first-time onboarding.
    """
    syn_id = uuid.uuid4()
    resolved = util.canonical_user_id(
        db_session,
        {"user_id": str(syn_id), "email": "brand-new@example.com"},
    )
    assert resolved == syn_id


def test_canonical_user_id_returns_synthetic_when_no_email_supplied(db_session):
    """Defensive: if a session token somehow lacks an email field, the
    resolver shouldn't crash on .lower() or query with None. Same fallback
    as the no-user-row case.
    """
    syn_id = uuid.uuid4()
    resolved = util.canonical_user_id(
        db_session,
        {"user_id": str(syn_id)},  # no email key
    )
    assert resolved == syn_id


def test_project_create_then_list_round_trip_via_api(client, db_session):
    """End-to-end guard: with the static test token whose synthetic UUID5
    doesn't match the DB-canonical user (which the existing fixtures provide
    via ``_ensure_user_org_member``), creating a project must make it visible
    in the list. This is the user-facing symptom of the bug — projects
    silently vanishing from the dashboard.
    """
    payload = {
        "name": "canonical-id-roundtrip",
        "use_case": "docker_platform",
        "source_type": "github",
        "repo_url": "https://github.com/example/repo",
        "repo_branch": "main",
    }
    create_resp = client.post("/api/projects", json=payload)
    assert create_resp.status_code == 201, create_resp.text
    project_id = create_resp.json()["id"]

    list_resp = client.get("/api/projects")
    assert list_resp.status_code == 200
    project_ids = [p["id"] for p in list_resp.json()]
    assert project_id in project_ids, (
        f"created project {project_id} not in list {project_ids} — "
        "this is the symptom of the synthetic-vs-canonical user-id bug"
    )

    get_resp = client.get(f"/api/projects/{project_id}")
    assert get_resp.status_code == 200
    assert get_resp.json()["id"] == project_id
