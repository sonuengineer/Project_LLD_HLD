"""Ledger balances per currency; payment_events append-only (review fixes).

1. ledger_check_balanced summed ALL entries of a transaction. A transaction mixing currencies
   (+1000 INR, -1000 USD) summed to 0 and was accepted although it moves value out of thin air.
   Now every currency inside a transaction must balance on its own.
2. payment_events (the audit trail of every transition) was append-only by convention only.

Revision ID: 0002
"""
from alembic import op

revision = "0002"
down_revision = "0001"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("""CREATE OR REPLACE FUNCTION ledger_check_balanced() RETURNS trigger LANGUAGE plpgsql AS $$
    DECLARE bad record;
    BEGIN
      SELECT a.currency, sum(e.amount) AS total INTO bad
        FROM ledger_entries e JOIN ledger_accounts a ON a.id = e.account_id
       WHERE e.transaction_id = NEW.transaction_id
       GROUP BY a.currency HAVING sum(e.amount) <> 0 LIMIT 1;
      IF FOUND THEN
        RAISE EXCEPTION 'ledger transaction % is unbalanced in % (sum = %)', NEW.transaction_id, bad.currency, bad.total;
      END IF;
      RETURN NULL;
    END $$""")
    op.execute("""CREATE FUNCTION payment_events_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN RAISE EXCEPTION 'payment_events is append-only'; END $$""")
    op.execute("CREATE TRIGGER payment_events_no_update BEFORE UPDATE OR DELETE ON payment_events "
               "FOR EACH ROW EXECUTE FUNCTION payment_events_immutable()")


def downgrade() -> None:
    op.execute("DROP TRIGGER IF EXISTS payment_events_no_update ON payment_events")
    op.execute("DROP FUNCTION IF EXISTS payment_events_immutable")
    op.execute("""CREATE OR REPLACE FUNCTION ledger_check_balanced() RETURNS trigger LANGUAGE plpgsql AS $$
    DECLARE s bigint;
    BEGIN
      SELECT coalesce(sum(amount), 0) INTO s FROM ledger_entries WHERE transaction_id = NEW.transaction_id;
      IF s <> 0 THEN
        RAISE EXCEPTION 'ledger transaction % is unbalanced (sum = %)', NEW.transaction_id, s;
      END IF;
      RETURN NULL;
    END $$""")
