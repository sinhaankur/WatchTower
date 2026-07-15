"""Runtime-configurable SMTP / outbound-email settings.

Single source of truth for "which mail server does this install send team
invitations through". Values live in the ``system_settings`` table so the
operator can configure everything from Settings → Email in the SPA; the
``WATCHTOWER_SMTP_*`` env vars remain a fallback so headless/compose installs
that already set them keep working unchanged.

Precedence per field: database value → env var → default. The SMTP password
is stored Fernet-encrypted via ``util.encrypt_secret`` and is never echoed
back to the SPA — config reads only report whether one is set.

This mirrors :mod:`watchtower.llm_settings` deliberately: same
``get_setting``/``set_setting`` helpers, same DB-first-env-fallback shape, so
there is one pattern for every runtime-configurable knob.
"""
from __future__ import annotations

import logging
import os
from dataclasses import dataclass
from typing import Optional

from sqlalchemy.orm import Session

from watchtower.llm_settings import get_setting, set_setting

logger = logging.getLogger(__name__)

# Setting keys. ``email.*`` namespace to sit alongside ``llm.*`` / ``healing.*``.
KEY_SMTP_HOST = "email.smtp_host"
KEY_SMTP_PORT = "email.smtp_port"
KEY_SMTP_USER = "email.smtp_user"
KEY_SMTP_PASSWORD = "email.smtp_password"  # encrypted
KEY_SMTP_FROM = "email.smtp_from"
KEY_SMTP_USE_TLS = "email.smtp_use_tls"

DEFAULT_PORT = 587
DEFAULT_FROM = "noreply@watchtower.local"


@dataclass
class SMTPConfig:
    host: Optional[str]
    port: int
    user: Optional[str]
    password: Optional[str]
    from_addr: str
    use_tls: bool
    source: Optional[str]  # "database" | "env" | None when unconfigured

    @property
    def configured(self) -> bool:
        """True when there is enough config to attempt a send. A host is the
        only hard requirement — local relays (port 25, no auth) are valid."""
        return bool(self.host)


def _env_int(name: str, default: int) -> int:
    raw = os.getenv(name)
    if not raw:
        return default
    try:
        return int(raw)
    except ValueError:
        logger.warning("%s=%r is not an integer — using %d", name, raw, default)
        return default


def _as_bool(value: Optional[str], default: bool) -> bool:
    if value is None:
        return default
    return value.strip().lower() in {"1", "true", "yes", "on"}


def resolve_smtp_config(db: Session) -> SMTPConfig:
    """DB-first, env-fallback resolution of the outbound SMTP connection.

    A DB-stored host switches the whole record to the ``database`` source so
    the operator's UI config wins as a unit; if no host is stored in the DB we
    fall back to the ``WATCHTOWER_SMTP_*`` env vars (``env`` source), and
    finally to an unconfigured record (send is skipped, caller shares the
    invite link manually)."""
    db_host = get_setting(db, KEY_SMTP_HOST)
    if db_host:
        port_raw = get_setting(db, KEY_SMTP_PORT)
        try:
            port = int(port_raw) if port_raw else DEFAULT_PORT
        except ValueError:
            port = DEFAULT_PORT
        return SMTPConfig(
            host=db_host,
            port=port,
            user=get_setting(db, KEY_SMTP_USER) or None,
            password=get_setting(db, KEY_SMTP_PASSWORD) or None,
            from_addr=get_setting(db, KEY_SMTP_FROM) or DEFAULT_FROM,
            # Port 25 relays typically don't do STARTTLS; default TLS off there,
            # on everywhere else — but an explicit DB setting always wins.
            use_tls=_as_bool(get_setting(db, KEY_SMTP_USE_TLS), port != 25),
            source="database",
        )

    env_host = os.getenv("WATCHTOWER_SMTP_HOST")
    if env_host:
        port = _env_int("WATCHTOWER_SMTP_PORT", DEFAULT_PORT)
        return SMTPConfig(
            host=env_host,
            port=port,
            user=os.getenv("WATCHTOWER_SMTP_USER") or None,
            password=os.getenv("WATCHTOWER_SMTP_PASSWORD") or None,
            from_addr=os.getenv("WATCHTOWER_SMTP_FROM", DEFAULT_FROM),
            use_tls=_as_bool(os.getenv("WATCHTOWER_SMTP_USE_TLS"), port != 25),
            source="env",
        )

    return SMTPConfig(
        host=None,
        port=DEFAULT_PORT,
        user=None,
        password=None,
        from_addr=os.getenv("WATCHTOWER_SMTP_FROM", DEFAULT_FROM),
        use_tls=True,
        source=None,
    )


def update_smtp_config(
    db: Session,
    *,
    host: Optional[str] = None,
    port: Optional[int] = None,
    user: Optional[str] = None,
    password: Optional[str] = None,
    from_addr: Optional[str] = None,
    use_tls: Optional[bool] = None,
    user_id=None,
) -> None:
    """Upsert the SMTP settings. Any field left as ``None`` is untouched;
    passing an empty string for a field clears it (falls back to env). The
    caller is responsible for the surrounding ``db.commit()``.

    Fields are handled positionally by the caller via sentinel values — the
    route layer converts "field present in request but empty" into ``""`` and
    "field absent from request" into ``None`` before calling us, matching the
    llm_settings convention.
    """
    if host is not None:
        set_setting(db, KEY_SMTP_HOST, host.strip() or None, user_id=user_id)
    if port is not None:
        set_setting(db, KEY_SMTP_PORT, str(port) if port else None, user_id=user_id)
    if user is not None:
        set_setting(db, KEY_SMTP_USER, user.strip() or None, user_id=user_id)
    if password is not None:
        set_setting(
            db, KEY_SMTP_PASSWORD, password or None, secret=True, user_id=user_id
        )
    if from_addr is not None:
        set_setting(db, KEY_SMTP_FROM, from_addr.strip() or None, user_id=user_id)
    if use_tls is not None:
        set_setting(db, KEY_SMTP_USE_TLS, "true" if use_tls else "false", user_id=user_id)
