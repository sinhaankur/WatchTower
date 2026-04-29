"""add recommended_port to projects

Revision ID: c4e1a3f08217
Revises: b6f20a66bcc1
Create Date: 2026-04-29 19:00:00.000000

Stores the port WatchTower picked (or the user accepted) for this project.
Lets the wizard surface a port suggestion at create time and have it
persist across sessions, and gives the local-podman runner a stable
source-of-truth (re-validated at deploy time so a port that's free at
create time but taken at deploy time falls through to a fresh pick).

Nullable because:
  - Pre-existing projects don't have a value
  - The legacy SSH/rsync deploy path (DeploymentModel.SELF_HOSTED) doesn't
    need one — only the local-podman path does
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = 'c4e1a3f08217'
down_revision: Union[str, None] = 'b6f20a66bcc1'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    with op.batch_alter_table('projects', schema=None) as batch_op:
        batch_op.add_column(sa.Column('recommended_port', sa.Integer(), nullable=True))


def downgrade() -> None:
    with op.batch_alter_table('projects', schema=None) as batch_op:
        batch_op.drop_column('recommended_port')
