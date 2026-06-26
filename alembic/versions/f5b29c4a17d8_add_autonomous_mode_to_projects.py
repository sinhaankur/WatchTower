"""add autonomous_mode to projects

Revision ID: f5b29c4a17d8
Revises: d3a1f08e9c4b
Create Date: 2026-05-18 14:00:00.000000

Phase 4 of the autonomous global-deploy plan: a periodic health probe
watches each opted-in project's container, restarts it on failure, and
rolls back to the previous LIVE deployment if restarts don't help.

Off by default — every existing project keeps the manual-only lifecycle.
The toggle only does anything when ``run_as_container=True`` is also set,
because autonomous mode operates on the Phase-1 container; without it
there's no canonical thing to probe and restart.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = 'f5b29c4a17d8'
down_revision: Union[str, None] = 'd3a1f08e9c4b'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    with op.batch_alter_table('projects', schema=None) as batch_op:
        batch_op.add_column(sa.Column(
            'autonomous_mode',
            sa.Boolean(),
            nullable=False,
            server_default=sa.false(),
        ))


def downgrade() -> None:
    with op.batch_alter_table('projects', schema=None) as batch_op:
        batch_op.drop_column('autonomous_mode')
