"""add managed_database_replicas table

Revision ID: a9c47d5e2b18
Revises: f3c5b27e8a04
Create Date: 2026-05-20

Standby members of a ManagedDatabase cluster (v1 = single-PC, Postgres).
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = 'a9c47d5e2b18'
down_revision: Union[str, None] = 'f3c5b27e8a04'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        'managed_database_replicas',
        sa.Column('id', sa.Uuid(as_uuid=True), primary_key=True, nullable=False),
        sa.Column('primary_db_id', sa.Uuid(as_uuid=True), sa.ForeignKey('managed_databases.id'), nullable=False),
        sa.Column('name', sa.String(), nullable=False),
        sa.Column('pod_name', sa.String(), nullable=False),
        sa.Column('container_name', sa.String(), nullable=False),
        sa.Column('volume_name', sa.String(), nullable=False),
        sa.Column('host', sa.String(), nullable=False, server_default='127.0.0.1'),
        sa.Column('port', sa.Integer(), nullable=False),
        sa.Column('replication_slot_name', sa.String(), nullable=False),
        sa.Column(
            'role',
            sa.Enum('standby', 'promoted', name='replicarole'),
            nullable=False,
            server_default='standby',
        ),
        sa.Column(
            'status',
            sa.Enum('initializing', 'streaming', 'failed', 'promoted', name='replicastatus'),
            nullable=False,
            server_default='initializing',
        ),
        sa.Column('status_message', sa.String(), nullable=True),
        sa.Column('last_status_at', sa.DateTime(), nullable=True),
        sa.Column('last_lag_seconds', sa.Integer(), nullable=True),
        sa.Column('last_health_check', sa.DateTime(), nullable=True),
        sa.Column('created_by_user_id', sa.Uuid(as_uuid=True), sa.ForeignKey('users.id'), nullable=True),
        sa.Column('created_at', sa.DateTime(), nullable=True),
        sa.Column('updated_at', sa.DateTime(), nullable=True),
        sa.UniqueConstraint('pod_name', name='uq_managed_database_replicas_pod_name'),
        sa.UniqueConstraint('container_name', name='uq_managed_database_replicas_container_name'),
    )
    op.create_index(
        'ix_managed_database_replicas_primary_db_id',
        'managed_database_replicas',
        ['primary_db_id'],
    )
    op.create_index(
        'ix_managed_database_replicas_name',
        'managed_database_replicas',
        ['name'],
    )


def downgrade() -> None:
    op.drop_index('ix_managed_database_replicas_name', table_name='managed_database_replicas')
    op.drop_index('ix_managed_database_replicas_primary_db_id', table_name='managed_database_replicas')
    op.drop_table('managed_database_replicas')
    sa.Enum(name='replicastatus').drop(op.get_bind(), checkfirst=True)
    sa.Enum(name='replicarole').drop(op.get_bind(), checkfirst=True)
