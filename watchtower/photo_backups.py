"""Storage layer for the per-user photo backup vault.

Bytes live on the host disk (photos are arbitrarily large and streaming
them through the ORM is nobody's workflow); metadata lives in the
``photo_backups`` table. This module owns the on-disk layout, hashing,
and dedup — the API router in ``watchtower/api/photos.py`` owns auth,
DB rows, and HTTP.

Mirrors the conventions in ``watchtower/managed_db_backup.py`` (storage
root under ``$WATCHTOWER_DATA_DIR``, microsecond-stamped filenames).
"""

import hashlib
import logging
import os
from datetime import datetime, timezone
from pathlib import Path
from typing import BinaryIO, Optional

logger = logging.getLogger(__name__)

# A generous per-file ceiling so a single upload can't fill the disk in
# one request. 2 GiB covers phone photos and short videos; raise via env
# if someone backs up long 4K clips.
MAX_UPLOAD_BYTES = int(os.getenv("WATCHTOWER_PHOTO_MAX_BYTES", str(2 * 1024 * 1024 * 1024)))


class PhotoBackupError(Exception):
    """User-facing photo-backup failure (bad input, disk error, too large)."""


def _vault_root() -> Path:
    """Root dir for all photo vaults.

    ``$WATCHTOWER_DATA_DIR/photo_backups`` (default ``~/.watchtower/...``),
    matching where secret.key / watchtower.db / managed_db_backups live.
    """
    base = Path(
        os.getenv("WATCHTOWER_DATA_DIR")
        or os.path.join(os.path.expanduser("~"), ".watchtower")
    ) / "photo_backups"
    base.mkdir(parents=True, exist_ok=True)
    return base


def user_vault(user_id: str) -> Path:
    """The directory holding one user's photos. Created on demand."""
    d = _vault_root() / str(user_id)
    d.mkdir(parents=True, exist_ok=True)
    return d


def _safe_slug(name: Optional[str]) -> str:
    """Reduce a client filename to a safe, bounded slug for the on-disk name.

    We keep only alnum / dash / underscore / dot so nothing can contain a
    path separator or a leading dash. The real identity is the DB row +
    sha256; this is purely to make the file recognisable on disk.
    """
    if not name:
        return ""
    # Strip any directory component the client may have sent.
    name = os.path.basename(name)
    cleaned = "".join(c for c in name if c.isalnum() or c in "-_.")
    cleaned = cleaned.lstrip(".-")  # no hidden / option-looking files
    return cleaned[:64]


def stored_path_for(user_id: str, sha256_hex: str, original_filename: Optional[str]) -> Path:
    """Compute the absolute path a photo's bytes will be written to.

    ``<vault>/<user_id>/<YYYYMMDDTHHMMSS_us>-<sha8>-<slug>``. The sha8
    prefix keeps names unique even if two files share a timestamp and
    slug; the full sha256 is the dedup key in the DB.
    """
    ts = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S_%f")
    slug = _safe_slug(original_filename)
    tail = f"-{slug}" if slug else ""
    return user_vault(user_id) / f"{ts}-{sha256_hex[:8]}{tail}"


def write_stream(src: BinaryIO, dest: Path) -> tuple[int, str]:
    """Stream ``src`` to ``dest``, returning ``(size_bytes, sha256_hex)``.

    Hashes while writing (single pass, no re-read) and enforces
    ``MAX_UPLOAD_BYTES``. On any failure the partial file is removed so a
    failed upload never leaves a half-written photo behind.
    """
    hasher = hashlib.sha256()
    size = 0
    dest.parent.mkdir(parents=True, exist_ok=True)
    try:
        with open(dest, "wb") as out:
            while True:
                chunk = src.read(1024 * 1024)
                if not chunk:
                    break
                size += len(chunk)
                if size > MAX_UPLOAD_BYTES:
                    raise PhotoBackupError(
                        f"upload exceeds max size ({MAX_UPLOAD_BYTES} bytes)"
                    )
                hasher.update(chunk)
                out.write(chunk)
    except PhotoBackupError:
        dest.unlink(missing_ok=True)
        raise
    except OSError as exc:
        dest.unlink(missing_ok=True)
        raise PhotoBackupError(f"failed to write photo: {exc}") from exc

    if size == 0:
        dest.unlink(missing_ok=True)
        raise PhotoBackupError("empty upload")

    return size, hasher.hexdigest()


def delete_file(file_path: str) -> None:
    """Remove a stored photo's bytes. Missing file is not an error."""
    try:
        Path(file_path).unlink(missing_ok=True)
    except OSError:
        logger.warning("photo-backup: could not delete %s", file_path, exc_info=True)


def path_is_inside_vault(user_id: str, candidate: str) -> bool:
    """Guard: confirm ``candidate`` resolves inside the user's own vault.

    Defence-in-depth for the download route so a tampered ``file_path``
    row can never stream bytes from outside the caller's vault.
    """
    try:
        base = user_vault(user_id).resolve()
        target = Path(candidate).resolve()
        return base == target or base in target.parents
    except OSError:
        return False
