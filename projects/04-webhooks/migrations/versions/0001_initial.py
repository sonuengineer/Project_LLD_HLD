"""endpoints, events, deliveries (outbox + queue), delivery_attempts

Revision ID: 0001
Revises:
"""
import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql as pg

revision = "0001"
down_revision = None
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "endpoints",
        sa.Column("id", sa.String(40), primary_key=True),
        sa.Column("url", sa.String(2048), nullable=False),
        sa.Column("description", sa.String(500), nullable=False, server_default=""),
        sa.Column("event_types", pg.ARRAY(sa.String(100)), nullable=False),
        sa.Column("secret", sa.String(100), nullable=False),
        sa.Column("previous_secret", sa.String(100)),
        sa.Column("previous_secret_expires_at", sa.DateTime(timezone=True)),
        sa.Column("enabled", sa.Boolean, nullable=False, server_default=sa.true()),
        sa.Column("disabled_reason", sa.String(200)),
        sa.Column("rate_limit_per_second", sa.Float, nullable=False),
        sa.Column("consecutive_failures", sa.Integer, nullable=False, server_default="0"),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
    )
    op.create_table(
        "events",
        sa.Column("id", sa.String(40), primary_key=True),
        sa.Column("type", sa.String(100), nullable=False, index=True),
        sa.Column("payload", pg.JSONB, nullable=False),
        sa.Column("idempotency_key", sa.String(200), unique=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
    )
    op.create_table(
        "deliveries",
        sa.Column("id", sa.BigInteger, primary_key=True, autoincrement=True),
        sa.Column("event_id", sa.String(40), sa.ForeignKey("events.id", ondelete="CASCADE"), nullable=False),
        sa.Column("endpoint_id", sa.String(40), sa.ForeignKey("endpoints.id", ondelete="CASCADE"), nullable=False,
                  index=True),
        sa.Column("status", sa.String(20), nullable=False, server_default="pending"),
        sa.Column("attempts", sa.Integer, nullable=False, server_default="0"),
        sa.Column("next_attempt_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("locked_until", sa.DateTime(timezone=True)),
        sa.Column("locked_by", sa.String(100)),
        sa.Column("last_status_code", sa.Integer),
        sa.Column("last_error", sa.Text),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("delivered_at", sa.DateTime(timezone=True)),
        sa.UniqueConstraint("event_id", "endpoint_id", name="uq_delivery_event_endpoint"),
    )
    op.create_index("ix_deliveries_due", "deliveries", ["next_attempt_at"],
                    postgresql_where=sa.text("status IN ('pending', 'in_flight')"))
    op.create_table(
        "delivery_attempts",
        sa.Column("id", sa.BigInteger, primary_key=True, autoincrement=True),
        sa.Column("delivery_id", sa.BigInteger, sa.ForeignKey("deliveries.id", ondelete="CASCADE"), nullable=False,
                  index=True),
        sa.Column("attempt", sa.Integer, nullable=False),
        sa.Column("started_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("duration_ms", sa.Integer, nullable=False),
        sa.Column("status_code", sa.Integer),
        sa.Column("outcome", sa.String(30), nullable=False),
        sa.Column("error", sa.Text),
        sa.Column("response_snippet", sa.Text),
    )


def downgrade() -> None:
    op.drop_table("delivery_attempts")
    op.drop_index("ix_deliveries_due", table_name="deliveries")
    op.drop_table("deliveries")
    op.drop_table("events")
    op.drop_table("endpoints")
