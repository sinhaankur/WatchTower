"""CORS allowlist resolution + the wildcard-with-credentials guard.

A '*' origin combined with allow_credentials=True is a credential-leak
footgun the CORS spec forbids. The backend resolves CORS_ORIGINS through
_resolve_cors_origins(), which must strip any wildcard while keeping the
explicit origins, so a misconfigured deployment fails safe (no wildcard)
rather than leaking credentials cross-origin or breaking silently.
"""
from __future__ import annotations

from watchtower.api import _resolve_cors_origins, _DEFAULT_CORS_ORIGINS


def test_default_when_unset():
    """A None env yields the built-in localhost/dev allowlist, no wildcard."""
    origins = _resolve_cors_origins(None)
    assert origins == [o for o in _DEFAULT_CORS_ORIGINS.split(",") if o]
    assert "*" not in origins


def test_explicit_origins_parsed_and_trimmed():
    origins = _resolve_cors_origins(" https://a.example , https://b.example ")
    assert origins == ["https://a.example", "https://b.example"]


def test_wildcard_alone_is_stripped_to_empty():
    """'*' on its own must not survive — empty allowlist is the safe result."""
    assert _resolve_cors_origins("*") == []


def test_wildcard_stripped_but_explicit_origins_kept():
    """A mixed list keeps the real origins and drops only the wildcard."""
    origins = _resolve_cors_origins("https://app.example, *, https://admin.example")
    assert origins == ["https://app.example", "https://admin.example"]
    assert "*" not in origins


def test_blank_entries_ignored():
    assert _resolve_cors_origins("https://a.example,,  ,https://b.example") == [
        "https://a.example",
        "https://b.example",
    ]


def test_wildcard_logs_warning():
    """The strip must be loud — operators need a signal, not silent breakage.

    setup_logging() swaps the root handlers at import time, which makes
    pytest's caplog (a root handler) unreliable here. Attach a capture
    handler directly to the watchtower.api logger instead so the assertion
    is deterministic regardless of root-logger configuration.
    """
    import logging

    records: list[logging.LogRecord] = []

    class _Capture(logging.Handler):
        def emit(self, record: logging.LogRecord) -> None:
            records.append(record)

    logger = logging.getLogger("watchtower.api")
    handler = _Capture(level=logging.WARNING)
    logger.addHandler(handler)
    try:
        _resolve_cors_origins("*")
    finally:
        logger.removeHandler(handler)

    assert any("CORS_ORIGINS contained '*'" in r.getMessage() for r in records)
