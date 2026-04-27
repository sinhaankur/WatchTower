"""align org_nodes user FKs (fix legacy ALTER drift)

Revision ID: 49942143a987
Revises: 56523bebd8f2
Create Date: 2026-04-27 13:43:37.804665

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = '49942143a987'
down_revision: Union[str, None] = '56523bebd8f2'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Align legacy dev DBs with the model.

    Older installations added these columns via raw ALTER TABLE before
    Alembic existed; SQLite stored them as NUMERIC and they had no FK to
    users.id. Fresh DBs created from the baseline migration already
    have Uuid + FK, so this migration is effectively a no-op there.
    SQLite batch mode requires named constraints — hence the explicit
    ``fk_org_nodes_*_user_id`` names.
    """
    with op.batch_alter_table('org_nodes', schema=None) as batch_op:
        batch_op.alter_column('created_by_user_id',
               existing_type=sa.NUMERIC(),
               type_=sa.Uuid(),
               existing_nullable=True)
        batch_op.alter_column('updated_by_user_id',
               existing_type=sa.NUMERIC(),
               type_=sa.Uuid(),
               existing_nullable=True)
        batch_op.create_foreign_key(
            'fk_org_nodes_created_by_user_id', 'users',
            ['created_by_user_id'], ['id'],
        )
        batch_op.create_foreign_key(
            'fk_org_nodes_updated_by_user_id', 'users',
            ['updated_by_user_id'], ['id'],
        )


def downgrade() -> None:
    with op.batch_alter_table('org_nodes', schema=None) as batch_op:
        batch_op.drop_constraint('fk_org_nodes_updated_by_user_id', type_='foreignkey')
        batch_op.drop_constraint('fk_org_nodes_created_by_user_id', type_='foreignkey')
        batch_op.alter_column('updated_by_user_id',
               existing_type=sa.Uuid(),
               type_=sa.NUMERIC(),
               existing_nullable=True)
        batch_op.alter_column('created_by_user_id',
               existing_type=sa.Uuid(),
               type_=sa.NUMERIC(),
               existing_nullable=True)
