"""add system_settings + healing_actions

Revision ID: e5b31c8d9f47
Revises: d8a14e9b7235
Create Date: 2026-06-12

Self-heal / autonomy groundwork:
  * ``system_settings`` — instance-wide key-value store for operator
    settings editable from the UI (LLM connection, autonomy switch).
    Secret rows are Fernet-encrypted application-side.
  * ``healing_actions`` — one row per failed deployment recording the
    diagnosis, optional LLM analysis, and the resolution (auto-applied,
    approved, dismissed). PENDING rows form the human-intervention queue.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = 'e5b31c8d9f47'
down_revision: Union[str, None] = 'd8a14e9b7235'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        'system_settings',
        sa.Column('key', sa.String(length=100), nullable=False),
        sa.Column('value', sa.Text(), nullable=True),
        sa.Column('is_secret', sa.Boolean(), nullable=False, server_default=sa.text('0')),
        sa.Column('updated_by_user_id', sa.Uuid(), nullable=True),
        sa.Column('updated_at', sa.DateTime(), nullable=True),
        sa.ForeignKeyConstraint(
            ['updated_by_user_id'], ['users.id'],
            name='fk_system_settings_updated_by_user_id_users',
        ),
        sa.PrimaryKeyConstraint('key'),
    )

    op.create_table(
        'healing_actions',
        sa.Column('id', sa.Uuid(), nullable=False),
        sa.Column('org_id', sa.Uuid(), nullable=True),
        sa.Column('project_id', sa.Uuid(), nullable=False),
        sa.Column('deployment_id', sa.Uuid(), nullable=False),
        sa.Column('failure_kind', sa.String(length=50), nullable=False),
        sa.Column('cause', sa.Text(), nullable=True),
        sa.Column('fix_description', sa.Text(), nullable=True),
        sa.Column('auto_applicable', sa.Boolean(), nullable=False, server_default=sa.text('0')),
        sa.Column('llm_analysis', sa.Text(), nullable=True),
        sa.Column(
            'status',
            sa.Enum('PENDING', 'AUTO_APPLIED', 'APPROVED', 'DISMISSED', 'FAILED',
                    name='healingactionstatus'),
            nullable=False,
        ),
        sa.Column('result_deployment_id', sa.Uuid(), nullable=True),
        sa.Column('error', sa.Text(), nullable=True),
        sa.Column('created_at', sa.DateTime(), nullable=True),
        sa.Column('resolved_at', sa.DateTime(), nullable=True),
        sa.Column('resolved_by_user_id', sa.Uuid(), nullable=True),
        sa.ForeignKeyConstraint(
            ['org_id'], ['organizations.id'],
            name='fk_healing_actions_org_id_organizations',
        ),
        sa.ForeignKeyConstraint(
            ['project_id'], ['projects.id'],
            name='fk_healing_actions_project_id_projects',
        ),
        sa.ForeignKeyConstraint(
            ['deployment_id'], ['deployments.id'],
            name='fk_healing_actions_deployment_id_deployments',
        ),
        sa.ForeignKeyConstraint(
            ['resolved_by_user_id'], ['users.id'],
            name='fk_healing_actions_resolved_by_user_id_users',
        ),
        sa.PrimaryKeyConstraint('id'),
        sa.UniqueConstraint('deployment_id', name='uq_healing_actions_deployment_id'),
    )
    with op.batch_alter_table('healing_actions', schema=None) as batch_op:
        batch_op.create_index('ix_healing_actions_org_id', ['org_id'], unique=False)
        batch_op.create_index('ix_healing_actions_project_id', ['project_id'], unique=False)


def downgrade() -> None:
    with op.batch_alter_table('healing_actions', schema=None) as batch_op:
        batch_op.drop_index('ix_healing_actions_project_id')
        batch_op.drop_index('ix_healing_actions_org_id')
    op.drop_table('healing_actions')
    op.drop_table('system_settings')
