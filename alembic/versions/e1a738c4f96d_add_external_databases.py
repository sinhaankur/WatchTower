"""add external_databases table

Revision ID: e1a738c4f96d
Revises: d8f4a91c3e57
Create Date: 2026-05-20

Counterpart to managed_databases: tracks user-supplied connections
to DBs WatchTower does NOT manage (RDS, Supabase, a NAS, another PC).
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = 'e1a738c4f96d'
down_revision: Union[str, None] = 'd8f4a91c3e57'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        'external_databases',
        sa.Column('id', sa.Uuid(as_uuid=True), primary_key=True, nullable=False),
        sa.Column('org_id', sa.Uuid(as_uuid=True), sa.ForeignKey('organizations.id'), nullable=True),
        sa.Column('name', sa.String(), nullable=False),
        sa.Column('engine', sa.String(), nullable=False),
        sa.Column('host', sa.String(), nullable=False),
        sa.Column('port', sa.Integer(), nullable=False),
        sa.Column('database_name', sa.String(), nullable=False, server_default=''),
        sa.Column('username', sa.String(), nullable=False, server_default=''),
        sa.Column('password_encrypted', sa.Text(), nullable=False, server_default=''),
        sa.Column('use_tls', sa.Boolean(), nullable=False, server_default=sa.text('1')),
        sa.Column('notes', sa.String(), nullable=True),
        sa.Column('created_by_user_id', sa.Uuid(as_uuid=True), sa.ForeignKey('users.id'), nullable=True),
        sa.Column('created_at', sa.DateTime(), nullable=True),
        sa.Column('updated_at', sa.DateTime(), nullable=True),
    )
    op.create_index('ix_external_databases_name', 'external_databases', ['name'])
    op.create_index('ix_external_databases_org_id', 'external_databases', ['org_id'])


def downgrade() -> None:
    op.drop_index('ix_external_databases_org_id', table_name='external_databases')
    op.drop_index('ix_external_databases_name', table_name='external_databases')
    op.drop_table('external_databases')
