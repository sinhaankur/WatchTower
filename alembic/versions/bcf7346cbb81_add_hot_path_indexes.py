"""add hot path indexes

Adds indexes on FK columns that drive the per-project listing endpoints
(deployments, builds, env vars, custom domains, etc.) plus two composite
indexes that replace filter+sort with a single index range-scan on the
canonical "latest deployment / build for X" queries.

Revision ID: bcf7346cbb81
Revises: b0b51b0d29e3
Create Date: 2026-05-03 14:41:29.656161

"""
from typing import Sequence, Union

from alembic import op


# revision identifiers, used by Alembic.
revision: str = 'bcf7346cbb81'
down_revision: Union[str, None] = 'b0b51b0d29e3'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    with op.batch_alter_table('builds', schema=None) as batch_op:
        batch_op.create_index(batch_op.f('ix_builds_deployment_id'), ['deployment_id'], unique=False)
        batch_op.create_index('ix_builds_deployment_started', ['deployment_id', 'started_at'], unique=False)

    with op.batch_alter_table('custom_domains', schema=None) as batch_op:
        batch_op.create_index(batch_op.f('ix_custom_domains_project_id'), ['project_id'], unique=False)

    with op.batch_alter_table('deployment_nodes', schema=None) as batch_op:
        batch_op.create_index(batch_op.f('ix_deployment_nodes_deployment_id'), ['deployment_id'], unique=False)

    with op.batch_alter_table('deployments', schema=None) as batch_op:
        batch_op.create_index('ix_deployments_project_created', ['project_id', 'created_at'], unique=False)
        batch_op.create_index(batch_op.f('ix_deployments_project_id'), ['project_id'], unique=False)

    with op.batch_alter_table('environment_variables', schema=None) as batch_op:
        batch_op.create_index(batch_op.f('ix_environment_variables_project_id'), ['project_id'], unique=False)

    with op.batch_alter_table('notification_webhooks', schema=None) as batch_op:
        batch_op.create_index(batch_op.f('ix_notification_webhooks_project_id'), ['project_id'], unique=False)

    with op.batch_alter_table('project_relations', schema=None) as batch_op:
        batch_op.create_index(batch_op.f('ix_project_relations_related_project_id'), ['related_project_id'], unique=False)


def downgrade() -> None:
    with op.batch_alter_table('project_relations', schema=None) as batch_op:
        batch_op.drop_index(batch_op.f('ix_project_relations_related_project_id'))

    with op.batch_alter_table('notification_webhooks', schema=None) as batch_op:
        batch_op.drop_index(batch_op.f('ix_notification_webhooks_project_id'))

    with op.batch_alter_table('environment_variables', schema=None) as batch_op:
        batch_op.drop_index(batch_op.f('ix_environment_variables_project_id'))

    with op.batch_alter_table('deployments', schema=None) as batch_op:
        batch_op.drop_index(batch_op.f('ix_deployments_project_id'))
        batch_op.drop_index('ix_deployments_project_created')

    with op.batch_alter_table('deployment_nodes', schema=None) as batch_op:
        batch_op.drop_index(batch_op.f('ix_deployment_nodes_deployment_id'))

    with op.batch_alter_table('custom_domains', schema=None) as batch_op:
        batch_op.drop_index(batch_op.f('ix_custom_domains_project_id'))

    with op.batch_alter_table('builds', schema=None) as batch_op:
        batch_op.drop_index('ix_builds_deployment_started')
        batch_op.drop_index(batch_op.f('ix_builds_deployment_id'))
