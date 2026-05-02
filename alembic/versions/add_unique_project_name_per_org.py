"""Add unique constraint on (org_id, name) for projects table

Revision ID: add_unique_project_name
Revises: d8a512c47b3e
Create Date: 2026-05-02

"""
from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision = "add_unique_project_name"
down_revision = "d8a512c47b3e"
branch_labels = None
depends_on = None


def upgrade() -> None:
    """Add unique constraint to prevent duplicate project names per org"""
    # On SQLite, we need to handle this via a batch_alter_table
    with op.batch_alter_table("projects", schema=None) as batch_op:
        batch_op.create_unique_constraint(
            "uq_projects_org_id_name",
            ["org_id", "name"],
        )


def downgrade() -> None:
    """Remove unique constraint"""
    with op.batch_alter_table("projects", schema=None) as batch_op:
        batch_op.drop_constraint("uq_projects_org_id_name", type_="unique")
