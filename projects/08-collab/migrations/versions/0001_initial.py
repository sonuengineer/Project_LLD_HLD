"""users, documents, permissions, operations log, snapshots

Revision ID: 0001
Revises:
"""
from alembic import op

revision = "0001"
down_revision = None
branch_labels = None
depends_on = None

STATEMENTS = [
    "CREATE EXTENSION IF NOT EXISTS pgcrypto",
    """CREATE TABLE users (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      name text NOT NULL,
      token_hash text NOT NULL UNIQUE,
      created_at timestamptz NOT NULL DEFAULT now())""",
    """CREATE TABLE documents (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      title text NOT NULL,
      owner_id uuid NOT NULL REFERENCES users(id),
      content text NOT NULL DEFAULT '',
      rev bigint NOT NULL DEFAULT 0,          -- the sequencer's counter; row lock = per-document total order
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now())""",
    """CREATE TABLE document_permissions (
      document_id uuid NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
      user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      role text NOT NULL CHECK (role IN ('owner', 'editor', 'viewer')),
      PRIMARY KEY (document_id, user_id))""",
    """CREATE TABLE operations (
      document_id uuid NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
      rev bigint NOT NULL,                    -- the revision this op PRODUCED (1, 2, 3 ...)
      op jsonb NOT NULL,                      -- already transformed: applies to the doc at rev - 1
      user_id uuid NOT NULL,
      client_id text NOT NULL,
      client_seq bigint NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (document_id, rev),
      -- A client resending after a lost ack can't apply the same edit twice.
      UNIQUE (document_id, client_id, client_seq))""",
    """CREATE TABLE snapshots (
      document_id uuid NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
      rev bigint NOT NULL,
      content text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (document_id, rev))""",
]


def upgrade() -> None:
    for s in STATEMENTS:
        op.execute(s)


def downgrade() -> None:
    op.execute("DROP TABLE IF EXISTS snapshots, operations, document_permissions, documents, users CASCADE")
