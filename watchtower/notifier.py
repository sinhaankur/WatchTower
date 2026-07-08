"""Central notification dispatch.

One place to fire a project's configured Slack/Discord/ntfy webhooks. Previously
the webhook POST was inlined in builder._send_notifications (deploy events only)
and duplicated in api/notifications.py's /test endpoint. This module is the
shared sender so new event sources (self-heal, control-plane, …) can notify with
one call instead of re-implementing the payload + POST + error handling.

Slack and Discord take a JSON body; ntfy (https://ntfy.sh) is different — it's a
plain-text POST straight to the topic URL, with the title/priority/tags carried
in HTTP headers. `_send` picks the right wire format per provider so callers
never have to care.

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


# Default title/priority for ntfy pushes. WatchTower events are informational
# (a deploy finished, a self-heal fired), so we keep priority at the ntfy
# default of 3 ("default") — callers stay simple, and users control per-topic
# priority in their ntfy client if they want.
NTFY_DEFAULT_TITLE = "WatchTower"


def _payload_for(provider: str, text: str) -> dict:
    """Slack uses {text} (and `*bold*`); Discord uses {content} (`**bold**`).

    ntfy is NOT JSON — it takes a plain-text body — so this helper is only
    meaningful for the JSON providers. `_send` routes ntfy around it entirely.
    """
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


def _post_ntfy(url: str, text: str, title: str = NTFY_DEFAULT_TITLE, timeout: float = 10.0) -> None:
    """POST to an ntfy topic. Body is the plain message; the title rides in the
    `Title` header (ntfy's convention). We strip Slack/Discord `*`/`**` markdown
    since ntfy renders plain text by default — a stray `**` just looks like
    literal asterisks in the push.
    """
    body = text.replace("**", "").replace("*", "")
    req = urllib.request.Request(
        url,
        data=body.encode("utf-8"),
        headers={
            "Content-Type": "text/plain; charset=utf-8",
            "Title": title.encode("ascii", "ignore").decode("ascii"),  # ntfy headers are ASCII-only
        },
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=timeout):  # noqa: S310 - operator-configured webhook
        pass


def _send(url: str, provider: str, text: str, timeout: float = 10.0) -> None:
    """Provider-aware send. JSON body for slack/discord, plain-text POST for
    ntfy. Raises on failure so the caller's best-effort loop can count/log it.
    """
    if provider == "ntfy":
        _post_ntfy(url, text, timeout=timeout)
    else:
        _post(url, _payload_for(provider, text), timeout=timeout)


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
            _send(hook.url, hook.provider, text)
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
            _send(hook.url, hook.provider, text)
            sent += 1
        except Exception as exc:  # noqa: BLE001
            logger.warning("notify(org): webhook failed (%s): %s", (hook.url or "")[:40], exc)
    return sent
