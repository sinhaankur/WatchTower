"""
Utility functions for API routes
"""

import hmac
import os
import secrets
import uuid
import json
import time
import base64
import hashlib
from typing import Optional
from fastapi import Header, HTTPException, status

try:
    from cryptography.fernet import Fernet
except Exception:  # pragma: no cover - dependency check at runtime
    Fernet = None


def generate_webhook_secret() -> str:
    """Generate a secure webhook secret"""
    return secrets.token_urlsafe(32)


def to_uuid(value) -> uuid.UUID:
    """Coerce a value (str | UUID | None) to a uuid.UUID.

    Centralises the ``UUID(str(current_user["user_id"]))`` pattern used by the
    API routers. Raises HTTPException(400) for malformed input so callers
    don't have to wrap in try/except.
    """
    if isinstance(value, uuid.UUID):
        return value
    try:
        return uuid.UUID(str(value))
    except (ValueError, TypeError, AttributeError) as exc:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Invalid identifier",
        ) from exc


def assert_safe_external_url(url: str) -> str:
    """Validate ``url`` for use in server-side outbound HTTP requests.

    Blocks SSRF vectors:
      - Non-http(s) schemes (file://, gopher://, ftp://...).
      - Hostnames that resolve to loopback, link-local, private, or
        reserved address ranges (127/8, 10/8, 172.16/12, 192.168/16,
        169.254/16 incl. cloud metadata 169.254.169.254, ::1, fc00::/7).
      - Empty / malformed URLs.

    Returns the original URL on success; raises HTTPException(400) otherwise.

    Set ``WATCHTOWER_ALLOW_INTERNAL_HTTP=true`` to bypass (only for local
    dev against a self-hosted GHES on localhost).
    """
    import ipaddress
    import socket
    from urllib.parse import urlsplit

    if os.getenv("WATCHTOWER_ALLOW_INTERNAL_HTTP", "false").lower() == "true":
        return url

    try:
        parts = urlsplit(url)
    except (ValueError, AttributeError) as exc:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Invalid URL",
        ) from exc

    if parts.scheme not in ("http", "https") or not parts.hostname:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="URL must be an http(s) URL with a hostname",
        )

    host = parts.hostname
    try:
        infos = socket.getaddrinfo(host, None)
    except socket.gaierror as exc:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Could not resolve hostname",
        ) from exc

    for info in infos:
        ip = info[4][0]
        try:
            addr = ipaddress.ip_address(ip)
        except ValueError:
            continue
        if (
            addr.is_loopback
            or addr.is_private
            or addr.is_link_local
            or addr.is_reserved
            or addr.is_multicast
            or addr.is_unspecified
        ):
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="URL points to a non-routable / internal address",
            )
    return url


def _auth_signing_secret() -> str:
    secret = (
        os.getenv("WATCHTOWER_AUTH_SECRET")
        or os.getenv("WATCHTOWER_API_TOKEN")
    )
    if not secret:
        # In insecure dev mode generate a random per-process secret so sessions
        # are at least valid only for the lifetime of the process.
        if os.getenv("WATCHTOWER_ALLOW_INSECURE_DEV_AUTH", "false").lower() == "true":
            import logging as _logging
            _logging.getLogger(__name__).warning(
                "WATCHTOWER_AUTH_SECRET is not set. "
                "Using a random ephemeral signing key — sessions will not survive restarts."
            )
            secret = secrets.token_hex(32)
            # Cache on the module so all calls in this process use the same key.
            os.environ["WATCHTOWER_AUTH_SECRET"] = secret
        else:
            raise RuntimeError(
                "WATCHTOWER_AUTH_SECRET or WATCHTOWER_API_TOKEN must be set "
                "before running WatchTower."
            )
    return secret


def create_user_session_token(
    *,
    user_id: str,
    email: str,
    name: str,
    github_id: Optional[int] = None,
) -> str:
    """Create a signed user session token for browser login flows."""
    now = int(time.time())
    ttl_hours = int(os.getenv("WATCHTOWER_SESSION_TTL_HOURS", "12"))
    payload = {
        "uid": user_id,
        "email": email,
        "name": name,
        "gid": github_id,
        "iat": now,
        "exp": now + (ttl_hours * 3600),
    }
    raw = json.dumps(payload, separators=(",", ":"), sort_keys=True).encode("utf-8")
    sig = hmac.new(_auth_signing_secret().encode("utf-8"), raw, hashlib.sha256).hexdigest().encode("utf-8")
    return base64.urlsafe_b64encode(raw + b"." + sig).decode("utf-8")


def _parse_user_session_token(token: str):
    try:
        decoded = base64.urlsafe_b64decode(token.encode("utf-8"))
        raw, sig = decoded.rsplit(b".", 1)
    except Exception:
        return None

    expected = hmac.new(_auth_signing_secret().encode("utf-8"), raw, hashlib.sha256).hexdigest().encode("utf-8")
    if not hmac.compare_digest(sig, expected):
        return None

    try:
        payload = json.loads(raw.decode("utf-8"))
    except Exception:
        return None

    exp = int(payload.get("exp", 0))
    if exp <= int(time.time()):
        return None

    user_id = payload.get("uid")
    email = payload.get("email")
    name = payload.get("name")
    if not user_id or not email:
        return None

    return {
        "user_id": user_id,
        "email": email,
        "name": name or "WatchTower User",
        "github_id": payload.get("gid"),
    }


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


def decrypt_secret(value: str) -> str:
    """Decrypt values previously encrypted with encrypt_secret."""
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
        return fernet.decrypt(value.encode("utf-8")).decode("utf-8")
    except Exception as exc:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Failed to decrypt secret — key may have changed"
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

    session_user = _parse_user_session_token(provided_token)
    if session_user:
        return session_user

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
