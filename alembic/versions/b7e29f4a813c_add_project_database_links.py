"""add project_database_links table

Revision ID: b7e29f4a813c
Revises: c3f8e519a72b
Create Date: 2026-05-21

Lets a project bind to a managed-DB or external-DB; the builder
auto-injects the connection string as an env var at deploy time.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = 'b7e29f4a813c'
down_revision: Union[str, None] = 'c3f8e519a72b'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        'project_database_links',
        sa.Column('id', sa.Uuid(as_uuid=True), primary_key=True, nullable=False),
        sa.Column('project_id', sa.Uuid(as_uuid=True), sa.ForeignKey('projects.id'), nullable=False),
        sa.Column('managed_database_id', sa.Uuid(as_uuid=True), sa.ForeignKey('managed_databases.id'), nullable=True),
        sa.Column('external_database_id', sa.Uuid(as_uuid=True), sa.ForeignKey('external_databases.id'), nullable=True),
        sa.Column('env_var_name', sa.String(), nullable=False, server_default='DATABASE_URL'),
        sa.Column('is_active', sa.Boolean(), nullable=False, server_default=sa.text('1')),
        sa.Column('notes', sa.String(), nullable=True),
        sa.Column('created_by_user_id', sa.Uuid(as_uuid=True), sa.ForeignKey('users.id'), nullable=True),
        sa.Column('created_at', sa.DateTime(), nullable=True),
        sa.Column('updated_at', sa.DateTime(), nullable=True),
        sa.UniqueConstraint('project_id', 'env_var_name',
                            name='uq_project_db_links_project_env_var'),
    )
    op.create_index(
        'ix_project_database_links_project_id',
        'project_database_links',
        ['project_id'],
    )


def downgrade() -> None:
    op.drop_index('ix_project_database_links_project_id', table_name='project_database_links')
    op.drop_table('project_database_links')
