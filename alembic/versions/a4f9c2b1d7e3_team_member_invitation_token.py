"""team_member invitation_token + accepted_at

Revision ID: a4f9c2b1d7e3
Revises: e7a91c3b04ff
Create Date: 2026-05-09 11:00:00.000000

Closes the team-invite gap. Before this column existed, an invited user
was matched to their TeamMember row purely by email — so a typo in the
invite address meant the row stayed orphaned forever, and there was no
way to verify a "yes I accepted" claim.

The token is generated when an admin POSTs /orgs/{id}/team-members and
included in the invitation URL (and email body). The `accept` endpoint
takes the token, requires the caller to be authenticated, and writes
``user_id = current_user.id`` + ``accepted_at = now()``. After accept,
the token is cleared so the link can't be reused.

Both columns are nullable because pre-existing TeamMember rows (e.g.
the auto-created OWNER row for org founders) never had an invitation —
their token is NULL and they're considered already-accepted.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = 'a4f9c2b1d7e3'
down_revision: Union[str, None] = 'e7a91c3b04ff'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    with op.batch_alter_table('team_members', schema=None) as batch_op:
        batch_op.add_column(sa.Column('invitation_token', sa.String(length=64), nullable=True))
        batch_op.add_column(sa.Column('accepted_at', sa.DateTime(), nullable=True))
        batch_op.create_index(
            'ix_team_members_invitation_token',
            ['invitation_token'],
            unique=True,
        )


def downgrade() -> None:
    with op.batch_alter_table('team_members', schema=None) as batch_op:
        batch_op.drop_index('ix_team_members_invitation_token')
        batch_op.drop_column('accepted_at')
        batch_op.drop_column('invitation_token')
