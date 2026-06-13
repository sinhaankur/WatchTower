"""Runtime-configurable LLM + autonomy settings.

Single source of truth for "which LLM is this install talking to" and
"is autonomous self-heal on". Values live in the ``system_settings``
table so the operator can configure everything from the Settings UI;
the WATCHTOWER_LLM_* env vars remain a fallback so headless/compose
installs that already set them keep working unchanged.

Precedence per field: database value → env var → default. The API key
is stored Fernet-encrypted via util.encrypt_secret and is never echoed
back to the SPA — config reads only report whether one is set.
"""
from __future__ import annotations

import logging
import os
from dataclasses import dataclass
from typing import Optional

from sqlalchemy.orm import Session

from watchtower.database import SystemSetting

logger = logging.getLogger(__name__)

# Setting keys. Dotted to leave room for future namespaces.
KEY_LLM_BASE_URL = "llm.base_url"
KEY_LLM_API_KEY = "llm.api_key"  # encrypted
KEY_LLM_MODEL = "llm.model"
# Optional cheaper/tinier model for the autonomous self-heal loop's
# background log analysis. A 0.5–2B model is enough there (single
# completion, no tool calling) — letting it differ from the main agent
# model means chat can use a big model while self-heal stays fast and
# light on small devices. Unset → falls back to KEY_LLM_MODEL.
KEY_LLM_ANALYSIS_MODEL = "llm.analysis_model"
KEY_AUTONOMOUS_ENABLED = "healing.autonomous_enabled"


def get_setting(db: Session, key: str) -> Optional[str]:
    row = db.query(SystemSetting).filter(SystemSetting.key == key).first()
    if row is None or row.value is None:
        return None
    if row.is_secret:
        from watchtower.api.util import decrypt_secret

        try:
            return decrypt_secret(row.value)
        except Exception:
            logger.exception("Could not decrypt system setting %s — treating as unset", key)
            return None
    return row.value


def set_setting(
    db: Session,
    key: str,
    value: Optional[str],
    *,
    secret: bool = False,
    user_id=None,
) -> None:
    """Upsert one setting. ``value=None`` deletes the row (explicit unset
    falls back to the env var, matching the documented precedence)."""
    row = db.query(SystemSetting).filter(SystemSetting.key == key).first()
    if value is None:
        if row is not None:
            db.delete(row)
        return
    stored = value
    if secret:
        from watchtower.api.util import encrypt_secret

        stored = encrypt_secret(value)
    if row is None:
        row = SystemSetting(key=key, value=stored, is_secret=secret, updated_by_user_id=user_id)
        db.add(row)
    else:
        row.value = stored
        row.is_secret = secret
        row.updated_by_user_id = user_id


@dataclass
class LLMConfig:
    base_url: Optional[str]
    api_key: Optional[str]
    model: str
    source: Optional[str]  # "database" | "env" | None when unconfigured
    # Model for self-heal background analysis. Always populated — falls
    # back to ``model`` when no dedicated tiny model is configured.
    analysis_model: str = ""

    @property
    def configured(self) -> bool:
        return bool(self.base_url)

    @property
    def has_dedicated_analysis_model(self) -> bool:
        return bool(self.analysis_model) and self.analysis_model != self.model


def resolve_llm_config(db: Session) -> LLMConfig:
    """DB-first, env-fallback resolution of the LLM connection."""
    env_model = os.getenv("WATCHTOWER_LLM_MODEL", "gpt-4o-mini")
    env_analysis = os.getenv("WATCHTOWER_LLM_ANALYSIS_MODEL")

    db_base = get_setting(db, KEY_LLM_BASE_URL)
    if db_base:
        model = get_setting(db, KEY_LLM_MODEL) or env_model
        return LLMConfig(
            base_url=db_base,
            api_key=get_setting(db, KEY_LLM_API_KEY),
            model=model,
            source="database",
            analysis_model=get_setting(db, KEY_LLM_ANALYSIS_MODEL) or env_analysis or model,
        )
    env_base = os.getenv("WATCHTOWER_LLM_BASE_URL")
    if env_base:
        return LLMConfig(
            base_url=env_base,
            api_key=os.getenv("WATCHTOWER_LLM_API_KEY"),
            model=env_model,
            source="env",
            analysis_model=env_analysis or env_model,
        )
    return LLMConfig(
        base_url=None, api_key=None, model=env_model, source=None,
        analysis_model=env_analysis or env_model,
    )


def is_autonomous_enabled(db: Session) -> bool:
    """The global autonomy switch. DB setting wins; env var seeds installs
    that predate the UI toggle (or run headless)."""
    val = get_setting(db, KEY_AUTONOMOUS_ENABLED)
    if val is not None:
        return val.lower() == "true"
    return os.getenv("WATCHTOWER_AUTONOMOUS_FIX", "false").lower() == "true"
