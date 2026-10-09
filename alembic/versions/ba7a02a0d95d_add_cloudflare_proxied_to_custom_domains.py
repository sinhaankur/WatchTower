"""add cloudflare_proxied to custom_domains

Revision ID: ba7a02a0d95d
Revises: df983087a51a
Create Date: 2026-09-26 01:08:10.171377

Scope: this migration adds ONLY the ``cloudflare_proxied`` boolean to
``custom_domains``. Autogenerate also proposed unrelated tables/columns
(photo_backups, password_entries, managed_database_replicas.*) — those are
owned by their own migrations and were flagged only because the local dev
DB used for autogenerate was behind on them. They are intentionally NOT
included here; scoping a migration to the one model change it's named for
keeps the history reviewable and avoids double-creating tables on DBs that
already have them.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = 'ba7a02a0d95d'
down_revision: Union[str, None] = 'df983087a51a'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    with op.batch_alter_table('custom_domains', schema=None) as batch_op:
        batch_op.add_column(
            sa.Column(
                'cloudflare_proxied',
                sa.Boolean(),
                server_default='0',
                nullable=False,
            )
        )


def downgrade() -> None:
    with op.batch_alter_table('custom_domains', schema=None) as batch_op:
        batch_op.drop_column('cloudflare_proxied')
