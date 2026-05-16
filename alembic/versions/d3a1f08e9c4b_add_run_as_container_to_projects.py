"""add run_as_container to projects

Revision ID: d3a1f08e9c4b
Revises: a4f9c2b1d7e3
Create Date: 2026-05-16 04:25:00.000000

Phase 1 of the autonomous global-deploy plan: lets a project opt in to
running the deployed artifact as a Podman container on the remote node
(static-site nginx for v1; framework-detect SSR comes later) instead of
just rsync-ing files and relying on a pre-existing nginx/systemd unit.

Default ``False`` so every existing project keeps the rsync+reload path
unchanged.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = 'd3a1f08e9c4b'
down_revision: Union[str, None] = 'a4f9c2b1d7e3'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    with op.batch_alter_table('projects', schema=None) as batch_op:
        # server_default '0' is what makes the column safe to add against
        # an existing populated table — Postgres + SQLite both honour it
        # for back-fill. Once the column exists we don't need the default
        # at the DB level anymore (the ORM supplies it on insert), but
        # leaving it costs nothing.
        batch_op.add_column(sa.Column(
            'run_as_container',
            sa.Boolean(),
            nullable=False,
            server_default=sa.text('0'),
        ))


def downgrade() -> None:
    with op.batch_alter_table('projects', schema=None) as batch_op:
        batch_op.drop_column('run_as_container')
