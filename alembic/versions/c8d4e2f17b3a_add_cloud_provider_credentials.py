"""add cloud_provider_credentials

Revision ID: c8d4e2f17b3a
Revises: f5b29c4a17d8
Create Date: 2026-05-18 17:00:00.000000

Phase 5 foundation: stores an org-scoped, Fernet-encrypted API token
for an external cloud provider (DigitalOcean or Hetzner for v1). The
later auto-provisioning flow (Phase 5 step 2) decrypts the token at
use-time to call the provider's REST API, creating a VM and
registering it as an OrgNode.

Same pattern as cloudflare_credentials — separate table because a
WatchTower org may carry credentials for multiple providers
simultaneously, and storing them with the OrgNode would conflate
"server I provisioned" with "API token that *can* provision."
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = 'c8d4e2f17b3a'
down_revision: Union[str, None] = 'f5b29c4a17d8'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        'cloud_provider_credentials',
        sa.Column('id', sa.Uuid(as_uuid=True), nullable=False),
        sa.Column('org_id', sa.Uuid(as_uuid=True), nullable=False),
        # 'digitalocean' | 'hetzner' — kept as a String (not Enum) so a
        # third provider can land without a schema migration; the API
        # layer validates against the supported set.
        sa.Column('provider', sa.String(length=32), nullable=False),
        sa.Column('label', sa.String(length=255), nullable=True),
        # Fernet-encrypted via util.encrypt_secret. Plaintext is never
        # logged or persisted; surfaced only at use time.
        sa.Column('api_token_encrypted', sa.Text(), nullable=False),
        # Surfaced from a successful verify call so the UI can show
        # "you're connected as foo@bar.com" without decrypting the token
        # on every list request.
        sa.Column('account_email', sa.String(length=255), nullable=True),
        sa.Column('last_verified_at', sa.DateTime(), nullable=True),
        sa.Column('created_by_user_id', sa.Uuid(as_uuid=True), nullable=True),
        sa.Column('created_at', sa.DateTime(), nullable=False, server_default=sa.func.now()),
        sa.Column('updated_at', sa.DateTime(), nullable=False, server_default=sa.func.now()),
        sa.ForeignKeyConstraint(['org_id'], ['organizations.id'], name='fk_cloud_provider_credentials_org_id'),
        sa.ForeignKeyConstraint(['created_by_user_id'], ['users.id'], name='fk_cloud_provider_credentials_created_by_user_id'),
        sa.PrimaryKeyConstraint('id'),
    )
    op.create_index(
        'ix_cloud_provider_credentials_org_id',
        'cloud_provider_credentials',
        ['org_id'],
    )


def downgrade() -> None:
    op.drop_index('ix_cloud_provider_credentials_org_id', table_name='cloud_provider_credentials')
    op.drop_table('cloud_provider_credentials')
