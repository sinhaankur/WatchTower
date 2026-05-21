"""add managed_databases table

Revision ID: d8f4a91c3e57
Revises: b1a937e5c2f4
Create Date: 2026-05-20

WatchTower-managed database instances (Postgres-in-a-Podman-pod). v0
single-node; future revisions will add a `managed_database_replicas`
table and a `role` column for primary/standby HA.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = 'd8f4a91c3e57'
down_revision: Union[str, None] = 'b1a937e5c2f4'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        'managed_databases',
        sa.Column('id', sa.Uuid(as_uuid=True), primary_key=True, nullable=False),
        sa.Column('org_id', sa.Uuid(as_uuid=True), sa.ForeignKey('organizations.id'), nullable=True),
        sa.Column('name', sa.String(), nullable=False),
        sa.Column('engine', sa.String(), nullable=False, server_default='postgres'),
        sa.Column('version', sa.String(), nullable=False, server_default='16'),
        sa.Column('image', sa.String(), nullable=False),
        sa.Column('pod_name', sa.String(), nullable=False),
        sa.Column('container_name', sa.String(), nullable=False),
        sa.Column('volume_name', sa.String(), nullable=False),
        sa.Column('host', sa.String(), nullable=False, server_default='127.0.0.1'),
        sa.Column('port', sa.Integer(), nullable=False),
        sa.Column('database_name', sa.String(), nullable=False, server_default='appdb'),
        sa.Column('username', sa.String(), nullable=False, server_default='watchtower'),
        sa.Column('password_encrypted', sa.Text(), nullable=False),
        sa.Column(
            'status',
            sa.Enum('creating', 'running', 'stopped', 'failed', 'deleting',
                    name='manageddatabasestatus'),
            nullable=False,
            server_default='creating',
        ),
        sa.Column('status_message', sa.String(), nullable=True),
        sa.Column('last_status_at', sa.DateTime(), nullable=True),
        sa.Column('created_by_user_id', sa.Uuid(as_uuid=True), sa.ForeignKey('users.id'), nullable=True),
        sa.Column('created_at', sa.DateTime(), nullable=True),
        sa.Column('updated_at', sa.DateTime(), nullable=True),
        sa.UniqueConstraint('pod_name', name='uq_managed_databases_pod_name'),
        sa.UniqueConstraint('container_name', name='uq_managed_databases_container_name'),
    )
    op.create_index(
        'ix_managed_databases_name', 'managed_databases', ['name'],
    )
    op.create_index(
        'ix_managed_databases_org_id', 'managed_databases', ['org_id'],
    )


def downgrade() -> None:
    op.drop_index('ix_managed_databases_org_id', table_name='managed_databases')
    op.drop_index('ix_managed_databases_name', table_name='managed_databases')
    op.drop_table('managed_databases')
    # SQLite ignores native enums; Postgres needs the type cleaned up.
    sa.Enum(name='manageddatabasestatus').drop(op.get_bind(), checkfirst=True)
