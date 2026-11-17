"""Indexes for refunds: per-payment lookups (refundable-amount check, payment detail) and recovery's scan of
stuck refunds by status/age. Without them both are sequential scans as the table grows.

Revision ID: 0003
"""
from alembic import op

revision = "0003"
down_revision = "0002"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("CREATE INDEX IF NOT EXISTS ix_refunds_payment ON refunds (payment_id)")
    op.execute("CREATE INDEX IF NOT EXISTS ix_refunds_status_updated ON refunds (status, updated_at)")


def downgrade() -> None:
    op.execute("DROP INDEX IF EXISTS ix_refunds_status_updated")
    op.execute("DROP INDEX IF EXISTS ix_refunds_payment")
