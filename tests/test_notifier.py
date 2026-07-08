"""Central notification dispatcher (watchtower/notifier.py).

Fires a project's (or org's) Slack/Discord webhooks on events. We mock the HTTP
POST (_post) so no network is touched, and assert: active-only filtering, the
correct per-provider payload shape, and best-effort behaviour (one bad hook
doesn't stop the rest; nothing raises).
"""
from __future__ import annotations

import uuid

import pytest

from watchtower import notifier
from watchtower.database import (
    NotificationWebhook,
    Project,
    ProjectSourceType,
    UseCaseType,
)


@pytest.fixture
def project(db_session):
    p = Project(
        id=uuid.uuid4(),
        name="notify-proj",
        use_case=UseCaseType.DOCKER_PLATFORM,
        source_type=ProjectSourceType.GITHUB.value,
        repo_url="https://github.com/example/repo",
        repo_branch="main",
        webhook_secret="s",
        org_id=uuid.uuid4(),
        owner_id=uuid.uuid4(),
    )
    db_session.add(p)
    db_session.commit()
    db_session.refresh(p)
    return p


def _add_hook(db, project_id, provider, url, active=True, org_id=None):
    h = NotificationWebhook(
        id=uuid.uuid4(), project_id=project_id, org_id=org_id,
        provider=provider, url=url, label="t", is_active=active,
    )
    db.add(h)
    db.commit()
    return h


# ── payload shape ─────────────────────────────────────────────────────────────


def test_slack_payload_uses_text_and_single_star():
    p = notifier._payload_for("slack", "hello **bold**")
    assert p == {"text": "hello *bold*"}


def test_discord_payload_uses_content_and_double_star():
    p = notifier._payload_for("discord", "hello **bold**")
    assert p == {"content": "hello **bold**"}


# ── notify_project ────────────────────────────────────────────────────────────


def test_notify_project_posts_to_active_hooks(project, db_session, monkeypatch):
    _add_hook(db_session, project.id, "slack", "https://hooks.slack.com/services/x")
    _add_hook(db_session, project.id, "discord", "https://discord.com/api/webhooks/y")
    posted = []
    monkeypatch.setattr(notifier, "_post", lambda url, payload, timeout=10.0: posted.append((url, payload)))

    sent = notifier.notify_project(db_session, project.id, "deploy **done**")
    assert sent == 2
    urls = {u for u, _ in posted}
    assert urls == {"https://hooks.slack.com/services/x", "https://discord.com/api/webhooks/y"}
    # Slack got {text} with single star, Discord got {content} with double.
    by_url = dict(posted)
    assert by_url["https://hooks.slack.com/services/x"] == {"text": "deploy *done*"}
    assert by_url["https://discord.com/api/webhooks/y"] == {"content": "deploy **done**"}


def test_notify_project_skips_inactive_hooks(project, db_session, monkeypatch):
    _add_hook(db_session, project.id, "slack", "https://hooks.slack.com/services/active")
    _add_hook(db_session, project.id, "slack", "https://hooks.slack.com/services/off", active=False)
    posted = []
    monkeypatch.setattr(notifier, "_post", lambda url, payload, timeout=10.0: posted.append(url))
    sent = notifier.notify_project(db_session, project.id, "hi")
    assert sent == 1
    assert posted == ["https://hooks.slack.com/services/active"]


def test_notify_project_best_effort_on_failure(project, db_session, monkeypatch):
    """One failing webhook must not stop the others, and must not raise."""
    _add_hook(db_session, project.id, "slack", "https://hooks.slack.com/services/bad")
    _add_hook(db_session, project.id, "slack", "https://hooks.slack.com/services/good")

    def flaky(url, payload, timeout=10.0):
        if "bad" in url:
            raise OSError("connection refused")

    monkeypatch.setattr(notifier, "_post", flaky)
    sent = notifier.notify_project(db_session, project.id, "hi")  # must not raise
    assert sent == 1  # only the good one counted


def test_notify_project_no_hooks_returns_zero(project, db_session):
    assert notifier.notify_project(db_session, project.id, "hi") == 0


def test_notify_project_bad_id_returns_zero(db_session):
    assert notifier.notify_project(db_session, "not-a-uuid", "hi") == 0


# ── notify_org ────────────────────────────────────────────────────────────────


def test_notify_org_only_org_scoped_hooks(project, db_session, monkeypatch):
    org_id = uuid.uuid4()
    # org-scoped (project_id NULL) — should fire
    _add_hook(db_session, None, "slack", "https://hooks.slack.com/services/org", org_id=org_id)
    # project-scoped in same org — should NOT fire via notify_org
    _add_hook(db_session, project.id, "slack", "https://hooks.slack.com/services/proj", org_id=org_id)
    posted = []
    monkeypatch.setattr(notifier, "_post", lambda url, payload, timeout=10.0: posted.append(url))
    sent = notifier.notify_org(db_session, org_id, "control plane event")
    assert sent == 1
    assert posted == ["https://hooks.slack.com/services/org"]
