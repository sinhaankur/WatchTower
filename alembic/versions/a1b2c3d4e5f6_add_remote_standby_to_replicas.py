"""add remote standby fields to managed_database_replicas

Revision ID: a1b2c3d4e5f6
Revises: f5b29c4a17d8
Create Date: 2026-06-26 00:00:00.000000

Adds three columns that enable v2 remote standby replication over Tailscale:
  - is_remote: distinguishes same-host standbys (v1) from remote ones (v2)
  - node_tailscale_ip: the Tailscale IP of the remote peer running the standby
  - replication_password_enc: Fernet-encrypted replication password, stored so
    we can regenerate the standby compose file on demand
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = 'a1b2c3d4e5f6'
down_revision: Union[str, None] = '86eb92ce0a55'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    with op.batch_alter_table('managed_database_replicas', schema=None) as batch_op:
        batch_op.add_column(sa.Column(
            'is_remote',
            sa.Boolean(),
            nullable=False,
            server_default=sa.false(),
        ))
        batch_op.add_column(sa.Column(
            'node_tailscale_ip',
            sa.String(),
            nullable=True,
        ))
        batch_op.add_column(sa.Column(
            'replication_password_enc',
            sa.Text(),
            nullable=True,
        ))


def downgrade() -> None:
    with op.batch_alter_table('managed_database_replicas', schema=None) as batch_op:
        batch_op.drop_column('replication_password_enc')
        batch_op.drop_column('node_tailscale_ip')
        batch_op.drop_column('is_remote')
