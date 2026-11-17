"""payments, state machine audit trail, idempotency keys, double-entry ledger (DB-enforced), refunds,
provider events, reconciliation, saga, and the mock provider's own schema.

Revision ID: 0001
Revises:
"""
from alembic import op

revision = "0001"
down_revision = None
branch_labels = None
depends_on = None

STATUSES = ("created", "authorizing", "authorized", "declined", "capturing", "captured", "voiding", "voided",
            "partially_refunded", "refunded", "failed", "requires_reconciliation")

STATEMENTS = [
    "CREATE EXTENSION IF NOT EXISTS pgcrypto",
    """CREATE TABLE merchants (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      name text NOT NULL,
      api_key_hash text NOT NULL UNIQUE,
      fee_bps int NOT NULL DEFAULT 290 CHECK (fee_bps BETWEEN 0 AND 10000),   -- 2.90%
      fee_fixed bigint NOT NULL DEFAULT 30 CHECK (fee_fixed >= 0),             -- + 30 minor units
      created_at timestamptz NOT NULL DEFAULT now())""",
    f"""CREATE TABLE payments (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      merchant_id uuid NOT NULL REFERENCES merchants(id),
      merchant_reference text NOT NULL,          -- e.g. order id
      amount bigint NOT NULL CHECK (amount > 0), -- minor units (paise/cents): never floats for money
      currency char(3) NOT NULL,
      amount_authorized bigint NOT NULL DEFAULT 0,
      amount_captured bigint NOT NULL DEFAULT 0,
      amount_refunded bigint NOT NULL DEFAULT 0,
      fee bigint NOT NULL DEFAULT 0,
      status text NOT NULL CHECK (status IN {STATUSES!r}),
      payment_method text NOT NULL,
      provider text NOT NULL,
      provider_payment_id text,
      decline_code text,
      last_error text,
      description text NOT NULL DEFAULT '',
      version int NOT NULL DEFAULT 0,            -- bumped on every transition (optimistic concurrency)
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT captured_le_authorized CHECK (amount_captured <= amount_authorized),
      CONSTRAINT refunded_le_captured CHECK (amount_refunded <= amount_captured),
      CONSTRAINT authorized_le_amount CHECK (amount_authorized <= amount))""",
    # One live payment per order: a retry after "declined"/"failed"/"voided" is allowed, a double charge is not.
    "CREATE UNIQUE INDEX uq_payment_reference_live ON payments (merchant_id, merchant_reference) "
    "WHERE status NOT IN ('declined', 'failed', 'voided')",
    "CREATE INDEX ix_payments_status_updated ON payments (status, updated_at)",
    "CREATE UNIQUE INDEX uq_payments_provider_id ON payments (provider_payment_id) WHERE provider_payment_id IS NOT NULL",
    """CREATE TABLE payment_events (                 -- append-only audit trail of every transition
      id bigserial PRIMARY KEY,
      payment_id uuid NOT NULL REFERENCES payments(id),
      from_status text,
      to_status text NOT NULL,
      reason text NOT NULL,
      data jsonb NOT NULL DEFAULT '{}',
      created_at timestamptz NOT NULL DEFAULT now())""",
    "CREATE INDEX ix_payment_events_payment ON payment_events (payment_id, id)",
    """CREATE TABLE refunds (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      payment_id uuid NOT NULL REFERENCES payments(id),
      amount bigint NOT NULL CHECK (amount > 0),
      status text NOT NULL CHECK (status IN ('pending', 'succeeded', 'failed', 'requires_reconciliation')),
      reason text NOT NULL DEFAULT '',
      provider_refund_id text,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now())""",
    """CREATE TABLE idempotency_keys (
      merchant_id uuid NOT NULL REFERENCES merchants(id),
      key text NOT NULL,
      request_method text NOT NULL,
      request_path text NOT NULL,
      request_hash text NOT NULL,
      state text NOT NULL CHECK (state IN ('in_progress', 'completed')),
      response_status int,
      response_body jsonb,
      locked_until timestamptz,
      created_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (merchant_id, key))""",
    # ---- double-entry ledger ------------------------------------------------------------------------
    """CREATE TABLE ledger_accounts (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      code text NOT NULL,                   -- provider_receivable | merchant_payable | platform_fee_revenue
      merchant_id uuid REFERENCES merchants(id),
      currency char(3) NOT NULL,
      UNIQUE (code, merchant_id, currency))""",
    """CREATE TABLE ledger_transactions (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      payment_id uuid REFERENCES payments(id),
      kind text NOT NULL,                   -- capture | refund | adjustment
      idempotency_ref text NOT NULL UNIQUE, -- the same business event can't be booked twice
      created_at timestamptz NOT NULL DEFAULT now())""",
    """CREATE TABLE ledger_entries (
      id bigserial PRIMARY KEY,
      transaction_id uuid NOT NULL REFERENCES ledger_transactions(id),
      account_id uuid NOT NULL REFERENCES ledger_accounts(id),
      amount bigint NOT NULL CHECK (amount <> 0),   -- debit > 0, credit < 0
      created_at timestamptz NOT NULL DEFAULT now())""",
    "CREATE INDEX ix_ledger_entries_account ON ledger_entries (account_id)",
    "CREATE INDEX ix_ledger_entries_tx ON ledger_entries (transaction_id)",
    # Invariant: every ledger transaction balances (sum of entries = 0). Checked at COMMIT (deferred), so a
    # transaction can insert its entries one by one and is validated as a whole.
    """CREATE FUNCTION ledger_check_balanced() RETURNS trigger LANGUAGE plpgsql AS $$
    DECLARE s bigint;
    BEGIN
      SELECT coalesce(sum(amount), 0) INTO s FROM ledger_entries WHERE transaction_id = NEW.transaction_id;
      IF s <> 0 THEN
        RAISE EXCEPTION 'ledger transaction % is unbalanced (sum = %)', NEW.transaction_id, s;
      END IF;
      RETURN NULL;
    END $$""",
    """CREATE CONSTRAINT TRIGGER ledger_balanced AFTER INSERT ON ledger_entries
       DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION ledger_check_balanced()""",
    # Ledger entries are immutable: corrections are new (reversing) transactions, never edits.
    """CREATE FUNCTION ledger_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN RAISE EXCEPTION 'ledger entries are append-only'; END $$""",
    "CREATE TRIGGER ledger_no_update BEFORE UPDATE OR DELETE ON ledger_entries FOR EACH ROW EXECUTE FUNCTION ledger_immutable()",
    """CREATE TABLE provider_events (               -- webhooks from the provider, deduplicated by event id
      id text PRIMARY KEY,
      type text NOT NULL,
      payload jsonb NOT NULL,
      processed_at timestamptz NOT NULL DEFAULT now(),
      outcome text NOT NULL)""",
    """CREATE TABLE reconciliation_runs (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      settlement_date date NOT NULL,
      started_at timestamptz NOT NULL DEFAULT now(),
      finished_at timestamptz,
      summary jsonb NOT NULL DEFAULT '{}')""",
    """CREATE TABLE reconciliation_items (
      id bigserial PRIMARY KEY,
      run_id uuid NOT NULL REFERENCES reconciliation_runs(id) ON DELETE CASCADE,
      kind text NOT NULL,          -- matched | missing_internally | missing_at_provider | amount_mismatch | status_mismatch
      payment_id uuid,
      provider_payment_id text,
      ours jsonb,
      theirs jsonb,
      resolution text)""",
    # ---- saga (checkout) ----------------------------------------------------------------------------
    """CREATE TABLE inventory (sku text PRIMARY KEY, available int NOT NULL CHECK (available >= 0))""",
    """CREATE TABLE reservations (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      order_id text NOT NULL, sku text NOT NULL REFERENCES inventory(sku), qty int NOT NULL CHECK (qty > 0),
      status text NOT NULL CHECK (status IN ('held', 'released', 'consumed')),
      UNIQUE (order_id, sku))""",
    """CREATE TABLE sagas (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      kind text NOT NULL,
      order_id text NOT NULL UNIQUE,
      status text NOT NULL CHECK (status IN ('running', 'completed', 'compensating', 'compensated', 'failed')),
      context jsonb NOT NULL DEFAULT '{}',
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now())""",
    """CREATE TABLE saga_steps (
      saga_id uuid NOT NULL REFERENCES sagas(id) ON DELETE CASCADE,
      step text NOT NULL,
      status text NOT NULL CHECK (status IN ('done', 'compensated', 'failed')),
      detail jsonb NOT NULL DEFAULT '{}',
      at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (saga_id, step))""",
    # ---- mock provider's OWN schema (stands in for a third party; the app never reads it directly) --------
    "CREATE SCHEMA provider",
    """CREATE TABLE provider.authorizations (
      id text PRIMARY KEY,
      reference text NOT NULL,
      idempotency_key text NOT NULL UNIQUE,
      amount bigint NOT NULL, currency char(3) NOT NULL,
      captured bigint NOT NULL DEFAULT 0, refunded bigint NOT NULL DEFAULT 0,
      status text NOT NULL, token text NOT NULL, fee bigint NOT NULL DEFAULT 0,
      created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now())""",
    "CREATE INDEX ix_prov_auth_reference ON provider.authorizations (reference)",
    """CREATE TABLE provider.operations (           -- idempotency for capture/void/refund calls
      idempotency_key text PRIMARY KEY, response jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now())""",
    """CREATE TABLE provider.flaky (token_ref text PRIMARY KEY)""",
]


def upgrade() -> None:
    for s in STATEMENTS:
        op.execute(s)


def downgrade() -> None:
    op.execute("DROP SCHEMA provider CASCADE")
    op.execute("DROP TABLE IF EXISTS saga_steps, sagas, reservations, inventory, reconciliation_items, reconciliation_runs, "
                "provider_events, ledger_entries, ledger_transactions, ledger_accounts, idempotency_keys, refunds, "
                "payment_events, payments, merchants CASCADE")
    op.execute("DROP FUNCTION IF EXISTS ledger_check_balanced, ledger_immutable")
