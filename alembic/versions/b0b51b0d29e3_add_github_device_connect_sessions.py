"""Add persistent github device connect sessions table

Revision ID: b0b51b0d29e3
Revises: add_unique_project_name
Create Date: 2026-05-02

"""
from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision = "b0b51b0d29e3"
down_revision = "add_unique_project_name"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "github_device_connect_sessions",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("device_code", sa.String(), nullable=False),
        sa.Column("user_id", sa.Uuid(), nullable=False),
        sa.Column("org_id", sa.Uuid(), nullable=False),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.Column("expires_at", sa.DateTime(), nullable=False),
        sa.ForeignKeyConstraint(["org_id"], ["organizations.id"]),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"]),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("device_code"),
    )
    op.create_index(
        "ix_github_device_connect_sessions_device_code",
        "github_device_connect_sessions",
        ["device_code"],
        unique=False,
    )
    op.create_index(
        "ix_github_device_connect_sessions_user_id",
        "github_device_connect_sessions",
        ["user_id"],
        unique=False,
    )
    op.create_index(
        "ix_github_device_connect_sessions_org_id",
        "github_device_connect_sessions",
        ["org_id"],
        unique=False,
    )
    op.create_index(
        "ix_github_device_connect_sessions_created_at",
        "github_device_connect_sessions",
        ["created_at"],
        unique=False,
    )
    op.create_index(
        "ix_github_device_connect_sessions_expires_at",
        "github_device_connect_sessions",
        ["expires_at"],
        unique=False,
    )


def downgrade() -> None:
    op.drop_index("ix_github_device_connect_sessions_expires_at", table_name="github_device_connect_sessions")
    op.drop_index("ix_github_device_connect_sessions_created_at", table_name="github_device_connect_sessions")
    op.drop_index("ix_github_device_connect_sessions_org_id", table_name="github_device_connect_sessions")
    op.drop_index("ix_github_device_connect_sessions_user_id", table_name="github_device_connect_sessions")
    op.drop_index("ix_github_device_connect_sessions_device_code", table_name="github_device_connect_sessions")
    op.drop_table("github_device_connect_sessions")
