"""Central notification dispatch.

One place to fire a project's configured Slack/Discord webhooks. Previously the
webhook POST was inlined in builder._send_notifications (deploy events only) and
duplicated in api/notifications.py's /test endpoint. This module is the shared
sender so new event sources (self-heal, control-plane, …) can notify with one
call instead of re-implementing the payload + POST + error handling.

All sends are best-effort: a down/slow webhook must never break a deploy, a
self-heal tick, or any caller. Failures are logged, not raised.
"""
from __future__ import annotations

import json
import logging
import urllib.error
import urllib.request
from typing import Optional
from uuid import UUID

from sqlalchemy.orm import Session

logger = logging.getLogger(__name__)


def _payload_for(provider: str, text: str) -> dict:
    """Slack uses {text} (and `*bold*`); Discord uses {content} (`**bold**`)."""
    if provider == "slack":
        return {"text": text.replace("**", "*")}
    return {"content": text}


def _post(url: str, payload: dict, timeout: float = 10.0) -> None:
    data = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(
        url, data=data, headers={"Content-Type": "application/json"}, method="POST"
    )
    with urllib.request.urlopen(req, timeout=timeout):  # noqa: S310 - operator-configured webhook
        pass


def notify_project(db: Session, project_id, text: str) -> int:
    """Send *text* to every active webhook on the project. Returns how many
    sends succeeded. Never raises — a webhook problem can't break the caller.

    Accepts a project_id (UUID or str) rather than a Project so callers don't
    need the ORM object loaded.
    """
    from watchtower.database import NotificationWebhook

    try:
        pid = project_id if isinstance(project_id, UUID) else UUID(str(project_id))
    except (ValueError, TypeError):
        return 0

    try:
        hooks = (
            db.query(NotificationWebhook)
            .filter_by(project_id=pid, is_active=True)
            .all()
        )
    except Exception:  # noqa: BLE001 - table may be absent on very old DBs
        return 0

    sent = 0
    for hook in hooks:
        try:
            _post(hook.url, _payload_for(hook.provider, text))
            sent += 1
        except Exception as exc:  # noqa: BLE001 - one bad hook mustn't stop the rest
            logger.warning("notify: webhook failed (%s): %s", (hook.url or "")[:40], exc)
    return sent


def notify_org(db: Session, org_id, text: str) -> int:
    """Send *text* to org-scoped webhooks (project_id IS NULL) — for
    installation-wide events like control-plane pairing/failover that aren't
    tied to a single project. Best-effort; returns successful-send count."""
    from watchtower.database import NotificationWebhook

    try:
        oid = org_id if isinstance(org_id, UUID) else UUID(str(org_id))
    except (ValueError, TypeError):
        return 0

    try:
        hooks = (
            db.query(NotificationWebhook)
            .filter(
                NotificationWebhook.org_id == oid,
                NotificationWebhook.project_id.is_(None),
                NotificationWebhook.is_active == True,  # noqa: E712
            )
            .all()
        )
    except Exception:  # noqa: BLE001
        return 0

    sent = 0
    for hook in hooks:
        try:
            _post(hook.url, _payload_for(hook.provider, text))
            sent += 1
        except Exception as exc:  # noqa: BLE001
            logger.warning("notify(org): webhook failed (%s): %s", (hook.url or "")[:40], exc)
    return sent
