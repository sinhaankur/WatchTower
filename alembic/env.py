"""Alembic migration runtime for WatchTower.

Pulls ``target_metadata`` from ``watchtower.database.Base`` and the connection
URL from ``DATABASE_URL`` (same env var the runtime engine uses), so a single
source of truth covers production, dev, and tests.
"""
from __future__ import annotations

import os
import sys
from logging.config import fileConfig
from pathlib import Path

from sqlalchemy import engine_from_config, pool

from alembic import context

# Make the project package importable when alembic is invoked from the repo root.
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from watchtower.database import Base  # noqa: E402  (after sys.path tweak)


config = context.config

# Override the static sqlalchemy.url in alembic.ini with the runtime
# DATABASE_URL so dev (sqlite), test (sqlite tmp), and prod (postgres)
# all flow through the same migration scripts.
_db_url = os.getenv("DATABASE_URL")
if _db_url:
    config.set_main_option("sqlalchemy.url", _db_url)

if config.config_file_name is not None:
    fileConfig(config.config_file_name)


target_metadata = Base.metadata


def run_migrations_offline() -> None:
    """Run migrations without a live DB connection (emit SQL only)."""
    context.configure(
        url=config.get_main_option("sqlalchemy.url"),
        target_metadata=target_metadata,
        literal_binds=True,
        dialect_opts={"paramstyle": "named"},
        # Render Postgres-flavored types when generating SQL even from sqlite,
        # so a captured offline upgrade is portable.
        compare_type=True,
    )
    with context.begin_transaction():
        context.run_migrations()


def run_migrations_online() -> None:
    """Run migrations against a live DB connection."""
    connectable = engine_from_config(
        config.get_section(config.config_ini_section, {}),
        prefix="sqlalchemy.",
        poolclass=pool.NullPool,
    )
    with connectable.connect() as connection:
        context.configure(
            connection=connection,
            target_metadata=target_metadata,
            compare_type=True,
            # SQLite has limited ALTER TABLE; use batch ops so column drops/
            # type changes work portably across sqlite + postgres.
            render_as_batch=connection.dialect.name == "sqlite",
        )
        with context.begin_transaction():
            context.run_migrations()


if context.is_offline_mode():
    run_migrations_offline()
else:
    run_migrations_online()
