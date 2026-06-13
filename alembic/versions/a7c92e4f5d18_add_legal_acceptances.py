"""add legal_acceptances

Revision ID: a7c92e4f5d18
Revises: e5b31c8d9f47
Create Date: 2026-06-12

Append-only click-through record: which user accepted which version of
the legal documents (watchtower/legal_docs.py), when, and from which IP.
Backs the login acceptance gate.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = 'a7c92e4f5d18'
down_revision: Union[str, None] = 'e5b31c8d9f47'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        'legal_acceptances',
        sa.Column('id', sa.Uuid(), nullable=False),
        sa.Column('user_id', sa.Uuid(), nullable=False),
        sa.Column('user_email', sa.String(), nullable=True),
        sa.Column('terms_version', sa.String(length=20), nullable=False),
        sa.Column('ip_address', sa.String(length=64), nullable=True),
        sa.Column('accepted_at', sa.DateTime(), nullable=False),
        sa.ForeignKeyConstraint(
            ['user_id'], ['users.id'],
            name='fk_legal_acceptances_user_id_users',
        ),
        sa.PrimaryKeyConstraint('id'),
    )
    with op.batch_alter_table('legal_acceptances', schema=None) as batch_op:
        batch_op.create_index('ix_legal_acceptances_user_id', ['user_id'], unique=False)


def downgrade() -> None:
    with op.batch_alter_table('legal_acceptances', schema=None) as batch_op:
        batch_op.drop_index('ix_legal_acceptances_user_id')
    op.drop_table('legal_acceptances')
