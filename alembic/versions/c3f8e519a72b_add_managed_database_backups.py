"""add managed_database_backups table

Revision ID: c3f8e519a72b
Revises: a9c47d5e2b18
Create Date: 2026-05-20

On-demand pg_dump backups of managed databases. v0 = local-disk only.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = 'c3f8e519a72b'
down_revision: Union[str, None] = 'a9c47d5e2b18'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        'managed_database_backups',
        sa.Column('id', sa.Uuid(as_uuid=True), primary_key=True, nullable=False),
        sa.Column('primary_db_id', sa.Uuid(as_uuid=True), sa.ForeignKey('managed_databases.id'), nullable=False),
        sa.Column('label', sa.String(), nullable=True),
        sa.Column('file_path', sa.String(), nullable=False),
        sa.Column('size_bytes', sa.Integer(), nullable=True),
        sa.Column('format', sa.String(), nullable=False, server_default='pgcustom'),
        sa.Column(
            'status',
            sa.Enum('running', 'ready', 'failed', name='backupstatus'),
            nullable=False,
            server_default='running',
        ),
        sa.Column('status_message', sa.String(), nullable=True),
        sa.Column('completed_at', sa.DateTime(), nullable=True),
        sa.Column('created_by_user_id', sa.Uuid(as_uuid=True), sa.ForeignKey('users.id'), nullable=True),
        sa.Column('created_at', sa.DateTime(), nullable=True),
    )
    op.create_index(
        'ix_managed_database_backups_primary_db_id',
        'managed_database_backups',
        ['primary_db_id'],
    )


def downgrade() -> None:
    op.drop_index('ix_managed_database_backups_primary_db_id', table_name='managed_database_backups')
    op.drop_table('managed_database_backups')
    sa.Enum(name='backupstatus').drop(op.get_bind(), checkfirst=True)
