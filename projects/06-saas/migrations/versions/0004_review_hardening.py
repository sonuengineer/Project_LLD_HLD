"""Hardening from the interview-bank review.

- The app role can no longer DELETE tenants: audit_logs cascade on tenant delete, so an app-level delete
  would erase the "append-only" audit trail. Tenant deletion becomes a platform/owner-DB operation.
- subscriptions.provider_event_at: ignore billing events older than the one already applied (providers
  deliver out of order).

Revision ID: 0004
Revises: 0003
"""
from alembic import op

revision = "0004"
down_revision = "0003"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("REVOKE DELETE ON tenants FROM saas_app")
    op.execute("ALTER TABLE subscriptions ADD COLUMN provider_event_at timestamptz")


def downgrade() -> None:
    op.execute("ALTER TABLE subscriptions DROP COLUMN provider_event_at")
    op.execute("GRANT DELETE ON tenants TO saas_app")
