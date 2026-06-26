"""add managed-DB backup schedule + is_scheduled flag

Revision ID: d8a14e9b7235
Revises: b7e29f4a813c
Create Date: 2026-05-22

Cron-driven scheduled backups for managed databases:
  * ``managed_databases.schedule_cron`` — 5-field cron string or NULL.
  * ``managed_databases.schedule_retention_count`` — cap on scheduled
    backups kept on disk (manual ones unaffected).
  * ``managed_databases.last_scheduled_backup_at`` — most-recent
    scheduler-fired backup, for UI display + due-detection.
  * ``managed_database_backups.is_scheduled`` — distinguishes scheduler
    rows from on-demand ones; retention prune only touches scheduled.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = 'd8a14e9b7235'
down_revision: Union[str, None] = 'b7e29f4a813c'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    with op.batch_alter_table('managed_databases', schema=None) as batch_op:
        batch_op.add_column(sa.Column('schedule_cron', sa.String(), nullable=True))
        batch_op.add_column(sa.Column(
            'schedule_retention_count',
            sa.Integer(),
            nullable=False,
            server_default=sa.text('7'),
        ))
        batch_op.add_column(sa.Column('last_scheduled_backup_at', sa.DateTime(), nullable=True))

    with op.batch_alter_table('managed_database_backups', schema=None) as batch_op:
        batch_op.add_column(sa.Column(
            'is_scheduled',
            sa.Boolean(),
            nullable=False,
            server_default=sa.false(),
        ))


def downgrade() -> None:
    with op.batch_alter_table('managed_database_backups', schema=None) as batch_op:
        batch_op.drop_column('is_scheduled')
    with op.batch_alter_table('managed_databases', schema=None) as batch_op:
        batch_op.drop_column('last_scheduled_backup_at')
        batch_op.drop_column('schedule_retention_count')
        batch_op.drop_column('schedule_cron')
