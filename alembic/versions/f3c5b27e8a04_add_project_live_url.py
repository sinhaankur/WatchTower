"""add projects.live_url

Revision ID: f3c5b27e8a04
Revises: e1a738c4f96d
Create Date: 2026-05-20

`live_url` is the public-facing site URL (GitHub Pages, custom domain).
Distinct from `launch_url` which points at the local dev/preview
server. NULL on existing projects — the user fills it in when they
publish.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = 'f3c5b27e8a04'
down_revision: Union[str, None] = 'e1a738c4f96d'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    with op.batch_alter_table('projects', schema=None) as batch_op:
        batch_op.add_column(sa.Column('live_url', sa.String(), nullable=True))


def downgrade() -> None:
    with op.batch_alter_table('projects', schema=None) as batch_op:
        batch_op.drop_column('live_url')
