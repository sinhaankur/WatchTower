"""add avatar_url to users

Revision ID: d8a512c47b3e
Revises: c4e1a3f08217
Create Date: 2026-04-29 19:30:00.000000

GitHub OAuth login was upserting the User row but throwing away
``profile["avatar_url"]`` — the SPA's sidebar identity badge had nothing
to render, falling back to the initial-letter placeholder. Adds the
column so the upsert can persist it and ``GET /api/me`` can surface it.

Nullable because:
  - Pre-existing User rows don't have a value (we don't backfill — the
    next time the user signs in, the upsert refreshes it).
  - Token-auth users (CI, curl) and guest users have no avatar.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = 'd8a512c47b3e'
down_revision: Union[str, None] = 'c4e1a3f08217'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    with op.batch_alter_table('users', schema=None) as batch_op:
        batch_op.add_column(sa.Column('avatar_url', sa.String(), nullable=True))


def downgrade() -> None:
    with op.batch_alter_table('users', schema=None) as batch_op:
        batch_op.drop_column('avatar_url')
