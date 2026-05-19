"""provisioning_jobs table + provider tracking columns on org_nodes

Revision ID: b1a937e5c2f4
Revises: c8d4e2f17b3a
Create Date: 2026-05-18 18:30:00.000000

Phase 5 step 2: the orchestrator that creates VMs on a cloud provider
and registers them as OrgNodes needs two things this migration adds:

  1. Tracking columns on org_nodes so a node we provisioned remembers
     which provider+resource it came from. Critical for the "destroy
     this node" path — without provider_resource_id we'd leave an
     orphaned (still-billable) VM on the operator's account.

  2. A provisioning_jobs table for surfacing progress to the UI and
     for crash-recovery: an API process restart mid-provision must be
     able to find in-flight jobs and either resume them or mark them
     failed. Status is a String, not an Enum, so we can add new
     transitional states without a schema migration.

Backwards-compatible — every new column is nullable, so existing
manually-registered org_nodes survive untouched.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = 'b1a937e5c2f4'
down_revision: Union[str, None] = 'c8d4e2f17b3a'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # ── org_nodes: tracking columns for provider-provisioned nodes ──────
    with op.batch_alter_table('org_nodes', schema=None) as batch_op:
        batch_op.add_column(sa.Column('provider', sa.String(length=32), nullable=True))
        batch_op.add_column(sa.Column('provider_resource_id', sa.String(length=255), nullable=True))
        batch_op.add_column(sa.Column(
            'provider_credential_id', sa.Uuid(as_uuid=True), nullable=True,
        ))
        batch_op.add_column(sa.Column('provisioned_at', sa.DateTime(), nullable=True))
        batch_op.create_foreign_key(
            'fk_org_nodes_provider_credential_id',
            'cloud_provider_credentials',
            ['provider_credential_id'], ['id'],
        )

    # ── provisioning_jobs: in-flight + historical provision attempts ────
    op.create_table(
        'provisioning_jobs',
        sa.Column('id', sa.Uuid(as_uuid=True), nullable=False),
        sa.Column('org_id', sa.Uuid(as_uuid=True), nullable=False),
        sa.Column('provider_credential_id', sa.Uuid(as_uuid=True), nullable=False),
        sa.Column('provider', sa.String(length=32), nullable=False),
        sa.Column('region', sa.String(length=64), nullable=False),
        sa.Column('size', sa.String(length=64), nullable=False),
        sa.Column('name', sa.String(length=255), nullable=False),
        # State machine: 'queued' → 'creating_vm' → 'waiting_for_ready' →
        # 'installing_stack' → 'verifying' → 'registered' (or 'failed' /
        # 'cancelled' at any step). String not Enum so new transitional
        # states don't need a migration.
        sa.Column('status', sa.String(length=32), nullable=False, server_default='queued'),
        sa.Column('error', sa.Text(), nullable=True),
        # Populated once create_server returns — needed for cleanup even
        # before the node row is registered, so an interrupted job can
        # still call delete_server on the orphan.
        sa.Column('provider_resource_id', sa.String(length=255), nullable=True),
        sa.Column('public_ipv4', sa.String(length=64), nullable=True),
        # Populated once the OrgNode is finally created.
        sa.Column('node_id', sa.Uuid(as_uuid=True), nullable=True),
        sa.Column('created_by_user_id', sa.Uuid(as_uuid=True), nullable=True),
        sa.Column('created_at', sa.DateTime(), nullable=False, server_default=sa.func.now()),
        sa.Column('updated_at', sa.DateTime(), nullable=False, server_default=sa.func.now()),
        sa.ForeignKeyConstraint(['org_id'], ['organizations.id'], name='fk_provisioning_jobs_org_id'),
        sa.ForeignKeyConstraint(['provider_credential_id'], ['cloud_provider_credentials.id'], name='fk_provisioning_jobs_credential_id'),
        sa.ForeignKeyConstraint(['node_id'], ['org_nodes.id'], name='fk_provisioning_jobs_node_id'),
        sa.ForeignKeyConstraint(['created_by_user_id'], ['users.id'], name='fk_provisioning_jobs_created_by_user_id'),
        sa.PrimaryKeyConstraint('id'),
    )
    op.create_index('ix_provisioning_jobs_org_id', 'provisioning_jobs', ['org_id'])
    op.create_index('ix_provisioning_jobs_status', 'provisioning_jobs', ['status'])


def downgrade() -> None:
    op.drop_index('ix_provisioning_jobs_status', table_name='provisioning_jobs')
    op.drop_index('ix_provisioning_jobs_org_id', table_name='provisioning_jobs')
    op.drop_table('provisioning_jobs')
    with op.batch_alter_table('org_nodes', schema=None) as batch_op:
        batch_op.drop_constraint('fk_org_nodes_provider_credential_id', type_='foreignkey')
        batch_op.drop_column('provisioned_at')
        batch_op.drop_column('provider_credential_id')
        batch_op.drop_column('provider_resource_id')
        batch_op.drop_column('provider')
