"""
Utility functions for API routes
"""

import hmac
import os
import secrets
import uuid
from fastapi import Header, HTTPException, status

try:
    from cryptography.fernet import Fernet
except Exception:  # pragma: no cover - dependency check at runtime
    Fernet = None


def generate_webhook_secret() -> str:
    """Generate a secure webhook secret"""
    return secrets.token_urlsafe(32)


def encrypt_secret(value: str) -> str:
    """Encrypt sensitive values using WATCHTOWER_SECRET_KEY (Fernet)."""
    key = os.getenv("WATCHTOWER_SECRET_KEY")
    if not key:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Secret encryption key is not configured"
        )

    if Fernet is None:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Encryption backend is unavailable"
        )

    try:
        fernet = Fernet(key.encode("utf-8"))
        return fernet.encrypt(value.encode("utf-8")).decode("utf-8")
    except Exception as exc:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Invalid secret encryption key configuration"
        ) from exc


def get_current_user(
    authorization: str = Header(None)
):
    """
    Get current user from API key or token.
    In self-hosted mode, this can be simplified.
    TODO: Implement proper authentication
    """
    expected_token = os.getenv("WATCHTOWER_API_TOKEN")
    allow_insecure_dev = os.getenv(
        "WATCHTOWER_ALLOW_INSECURE_DEV_AUTH", "false"
    ).lower() == "true"

    if not authorization:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Not authenticated"
        )

    if not authorization.startswith("Bearer "):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid authorization format"
        )

    provided_token = authorization.split(" ", 1)[1].strip()

    if expected_token:
        if not hmac.compare_digest(provided_token, expected_token):
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail="Invalid authentication token"
            )
    elif not allow_insecure_dev:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Authentication is not configured"
        )

    user_id = str(uuid.uuid5(uuid.NAMESPACE_URL, f"watchtower:{provided_token}"))
    return {
        "user_id": user_id,
        "email": os.getenv("WATCHTOWER_DEFAULT_USER_EMAIL", "developer@watchtower.local"),
        "name": os.getenv("WATCHTOWER_DEFAULT_USER_NAME", "WatchTower Developer"),
    }
