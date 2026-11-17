"""workflows, event-sourced history, activity task queue, timers, workers, activity side-effects (examples)

Revision ID: 0001
Revises:
"""
from alembic import op

revision = "0001"
down_revision = None
branch_labels = None
depends_on = None

STATEMENTS = [
    """CREATE TABLE workflows (
      workflow_id text PRIMARY KEY,                 -- business id (e.g. order-123): starting twice is idempotent
      run_id uuid NOT NULL,
      workflow_type text NOT NULL,
      task_queue text NOT NULL,
      status text NOT NULL CHECK (status IN ('running', 'completed', 'failed', 'cancelled')),
      input jsonb NOT NULL,
      result jsonb,
      error text,
      needs_task boolean NOT NULL DEFAULT true,     -- new events arrived -> a workflow task must replay it
      locked_by text,
      lease_until timestamptz,                      -- workflow-task lease (worker crash -> another worker takes over)
      last_event_id bigint NOT NULL DEFAULT 0,
      created_at timestamptz NOT NULL DEFAULT now(),
      closed_at timestamptz)""",
    "CREATE INDEX ix_workflows_pending ON workflows (task_queue, needs_task) WHERE status = 'running'",
    """CREATE TABLE history_events (                  -- append-only, the single source of truth for workflow state
      workflow_id text NOT NULL REFERENCES workflows(workflow_id) ON DELETE CASCADE,
      event_id bigint NOT NULL,
      event_type text NOT NULL,
      attrs jsonb NOT NULL DEFAULT '{}',
      created_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (workflow_id, event_id))""",
    """CREATE TABLE activity_tasks (
      id bigserial PRIMARY KEY,
      workflow_id text NOT NULL REFERENCES workflows(workflow_id) ON DELETE CASCADE,
      seq int NOT NULL,                             -- command sequence number inside the workflow
      activity_type text NOT NULL,
      input jsonb NOT NULL,
      task_queue text NOT NULL,
      status text NOT NULL CHECK (status IN ('scheduled', 'started', 'completed', 'failed', 'cancelled')),
      attempt int NOT NULL DEFAULT 0,
      retry jsonb NOT NULL,
      start_to_close_seconds double precision NOT NULL,
      heartbeat_timeout_seconds double precision,
      visible_at timestamptz NOT NULL DEFAULT now(),   -- retry backoff: not claimable before this
      locked_by text,
      lease_until timestamptz,
      last_heartbeat_at timestamptz,
      heartbeat_details jsonb,
      last_error text,
      UNIQUE (workflow_id, seq))""",
    "CREATE INDEX ix_activity_ready ON activity_tasks (task_queue, visible_at) WHERE status = 'scheduled'",
    "CREATE INDEX ix_activity_started ON activity_tasks (lease_until) WHERE status = 'started'",
    """CREATE TABLE timers (
      workflow_id text NOT NULL REFERENCES workflows(workflow_id) ON DELETE CASCADE,
      seq int NOT NULL,
      fire_at timestamptz NOT NULL,
      fired boolean NOT NULL DEFAULT false,
      PRIMARY KEY (workflow_id, seq))""",
    "CREATE INDEX ix_timers_due ON timers (fire_at) WHERE NOT fired",
    """CREATE TABLE workers (
      worker_id text PRIMARY KEY,
      task_queues text[] NOT NULL,
      workflow_types text[] NOT NULL,
      activity_types text[] NOT NULL,
      started_at timestamptz NOT NULL DEFAULT now(),
      last_heartbeat timestamptz NOT NULL DEFAULT now())""",
    # Example-only table: side effects of the demo activities, keyed by the activity idempotency key,
    # so tests can prove a retried/redelivered activity performs its effect exactly once.
    """CREATE TABLE activity_effects (
      idempotency_key text PRIMARY KEY,
      kind text NOT NULL,
      payload jsonb NOT NULL DEFAULT '{}',
      created_at timestamptz NOT NULL DEFAULT now())""",
]


def upgrade() -> None:
    for s in STATEMENTS:
        op.execute(s)


def downgrade() -> None:
    op.execute("DROP TABLE IF EXISTS activity_effects, workers, timers, activity_tasks, history_events, workflows CASCADE")
