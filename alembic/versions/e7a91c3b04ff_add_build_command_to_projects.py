"""add build_command to projects

Revision ID: e7a91c3b04ff
Revises: 4183fe5d8e83
Create Date: 2026-05-07 10:00:00.000000

Stores the user's build/install command override per project. NULL means
"let the runner pick a default": the runner inspects the cloned repo's
lockfile (npm/pnpm/yarn/bun) and picks the matching install command,
avoiding the `npm ci` help-text dump that triggers when a project has
no package-lock.json.

Nullable because:
  - Pre-existing projects had no column, so all rows back-fill to NULL
    and inherit the auto-detect default
  - The empty-string case ("user cleared the override") is normalised
    to NULL by the projects update handler so the auto-detect path is
    the single canonical "no override" representation
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = 'e7a91c3b04ff'
down_revision: Union[str, None] = '4183fe5d8e83'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    with op.batch_alter_table('projects', schema=None) as batch_op:
        batch_op.add_column(sa.Column('build_command', sa.String(), nullable=True))


def downgrade() -> None:
    with op.batch_alter_table('projects', schema=None) as batch_op:
        batch_op.drop_column('build_command')
