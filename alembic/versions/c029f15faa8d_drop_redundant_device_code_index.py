"""drop redundant device_code index

The original ``b0b51b0d29e3`` migration created both a
``UNIQUE (device_code)`` table constraint AND a separate non-unique
``ix_github_device_connect_sessions_device_code`` index on the same
column. The unique constraint already provides an implicit index
(SQLite autoindex / Postgres unique-index), so the secondary index
is dead weight on every INSERT. This migration drops it; the model
in ``watchtower.database`` was simultaneously updated to declare
``device_code`` with ``unique=True`` only (no ``index=True``) so
autogenerate stays clean going forward.

Revision ID: c029f15faa8d
Revises: bcf7346cbb81
Create Date: 2026-05-03 14:56:19.780794

"""
from typing import Sequence, Union

from alembic import op


# revision identifiers, used by Alembic.
revision: str = 'c029f15faa8d'
down_revision: Union[str, None] = 'bcf7346cbb81'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    with op.batch_alter_table('github_device_connect_sessions', schema=None) as batch_op:
        batch_op.drop_index('ix_github_device_connect_sessions_device_code')


def downgrade() -> None:
    with op.batch_alter_table('github_device_connect_sessions', schema=None) as batch_op:
        batch_op.create_index('ix_github_device_connect_sessions_device_code', ['device_code'], unique=False)
