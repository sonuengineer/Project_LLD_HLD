"""schema, app role, row-level security

Revision ID: 0001
Revises:
"""
import os

from alembic import op

revision = "0001"
down_revision = None
branch_labels = None
depends_on = None

def run(sql: str) -> None:
    """asyncpg executes one statement per call (extended protocol), so split on ';' + newline.
    Safe here because no statement body contains that sequence internally."""
    for stmt in (x.strip() for x in sql.split(";\n")):
        if stmt and not all(line.strip().startswith("--") or not line.strip() for line in stmt.splitlines()):
            op.execute(stmt)


TENANT_TABLES = ["memberships", "invitations", "projects", "api_keys", "audit_logs", "usage_counters",
                 "subscriptions", "reports"]


def upgrade() -> None:
    pw = os.getenv("SAAS_APP_DB_PASSWORD", "saas_app_dev").replace("'", "''")
    op.execute(f"""
    DO $$ BEGIN
      IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'saas_app') THEN
        CREATE ROLE saas_app LOGIN PASSWORD '{pw}' NOSUPERUSER NOBYPASSRLS;
      END IF;
    END $$;
    """)
    run("""
    CREATE EXTENSION IF NOT EXISTS pgcrypto;

    CREATE TABLE users (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      email text NOT NULL,
      password_hash text NOT NULL,
      full_name text NOT NULL DEFAULT '',
      is_platform_admin boolean NOT NULL DEFAULT false,
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE UNIQUE INDEX uq_users_email_lower ON users (lower(email));

    CREATE TABLE tenants (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      slug text NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9-]{3,40}$'),
      name text NOT NULL,
      plan text NOT NULL DEFAULT 'free',
      status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended')),
      created_at timestamptz NOT NULL DEFAULT now()
    );

    CREATE TABLE memberships (
      tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      role text NOT NULL CHECK (role IN ('owner', 'admin', 'member', 'viewer')),
      created_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (tenant_id, user_id)
    );
    CREATE INDEX ix_memberships_user ON memberships (user_id);

    CREATE TABLE invitations (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      email text NOT NULL,
      role text NOT NULL CHECK (role IN ('admin', 'member', 'viewer')),
      token_hash text NOT NULL UNIQUE,
      invited_by uuid REFERENCES users(id),
      expires_at timestamptz NOT NULL,
      accepted_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now()
    );

    CREATE TABLE projects (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      name text NOT NULL,
      description text NOT NULL DEFAULT '',
      created_by uuid REFERENCES users(id),
      created_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (tenant_id, name)
    );
    -- Every hot query filters by tenant first: lead composite indexes with tenant_id.
    CREATE INDEX ix_projects_tenant_created ON projects (tenant_id, created_at DESC);

    CREATE TABLE api_keys (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      name text NOT NULL,
      prefix text NOT NULL,
      key_hash text NOT NULL UNIQUE,
      scopes text[] NOT NULL,
      created_by uuid REFERENCES users(id),
      last_used_at timestamptz,
      revoked_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX ix_api_keys_tenant ON api_keys (tenant_id);

    CREATE TABLE audit_logs (
      id bigserial PRIMARY KEY,
      tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      actor_user_id uuid,
      actor_api_key_id uuid,
      action text NOT NULL,
      target_type text,
      target_id text,
      metadata jsonb NOT NULL DEFAULT '{}',
      ip text,
      request_id text,
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX ix_audit_tenant_created ON audit_logs (tenant_id, created_at DESC);

    CREATE TABLE usage_counters (
      tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      metric text NOT NULL,
      period text NOT NULL,          -- 'YYYY-MM'
      value bigint NOT NULL DEFAULT 0,
      PRIMARY KEY (tenant_id, metric, period)
    );

    CREATE TABLE subscriptions (
      tenant_id uuid PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
      plan text NOT NULL,
      status text NOT NULL,
      provider text NOT NULL,
      provider_customer_id text,
      provider_subscription_id text,
      current_period_end timestamptz,
      updated_at timestamptz NOT NULL DEFAULT now()
    );

    CREATE TABLE reports (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      kind text NOT NULL,
      status text NOT NULL DEFAULT 'queued',
      result jsonb,
      created_at timestamptz NOT NULL DEFAULT now(),
      finished_at timestamptz
    );
    CREATE INDEX ix_reports_tenant ON reports (tenant_id, created_at DESC);

    -- Not tenant-scoped: provider events arrive before we know the tenant. Unique id = idempotency.
    CREATE TABLE billing_events (
      id text PRIMARY KEY,
      type text NOT NULL,
      payload jsonb NOT NULL,
      processed_at timestamptz NOT NULL DEFAULT now()
    );

    CREATE TABLE refresh_tokens (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      family_id uuid NOT NULL,
      token_hash text NOT NULL UNIQUE,
      expires_at timestamptz NOT NULL,
      revoked_at timestamptz,
      replaced_by uuid,
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX ix_refresh_family ON refresh_tokens (family_id);
    """)
    # ---- Row-level security -----------------------------------------------------------------
    # current_setting(name, true) returns NULL when unset -> comparison is NULL -> no rows. So a
    # request that forgot to set the tenant sees NOTHING (fail closed), not everything.
    for t in TENANT_TABLES:
        op.execute(f"ALTER TABLE {t} ENABLE ROW LEVEL SECURITY")
        op.execute(f"ALTER TABLE {t} FORCE ROW LEVEL SECURITY")   # applies even to the table owner
    for t in ["invitations", "projects", "api_keys", "audit_logs", "usage_counters", "subscriptions", "reports"]:
        op.execute(f"""
        CREATE POLICY tenant_isolation ON {t}
          USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
          WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
        """)
    # memberships: visible inside the tenant, and a user can see their OWN memberships across tenants
    # (needed for "which workspaces am I in?").
    op.execute("""
    CREATE POLICY tenant_isolation ON memberships
      USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
             OR user_id = nullif(current_setting('app.user_id', true), '')::uuid)
      WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
    """)
    # API key lookup happens BEFORE we know the tenant, so RLS would hide the row. A narrow
    # SECURITY DEFINER function (runs as the owner) returns only what auth needs, by exact hash.
    run("""
    CREATE FUNCTION resolve_api_key(p_hash text)
    RETURNS TABLE (key_id uuid, tenant_id uuid, scopes text[], created_by uuid)
    LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
      SELECT id, tenant_id, scopes, created_by FROM api_keys WHERE key_hash = p_hash AND revoked_at IS NULL
    $$;
    REVOKE ALL ON FUNCTION resolve_api_key(text) FROM PUBLIC;
    """)
    # ---- grants: least privilege for the app role ------------------------------------------
    run("""
    GRANT USAGE ON SCHEMA public TO saas_app;
    GRANT SELECT, INSERT, UPDATE, DELETE ON users, tenants, memberships, invitations, projects, api_keys,
          usage_counters, subscriptions, reports, billing_events, refresh_tokens TO saas_app;
    -- Audit log is append-only for the application: no UPDATE / DELETE, even for a compromised app.
    GRANT SELECT, INSERT ON audit_logs TO saas_app;
    GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO saas_app;
    GRANT EXECUTE ON FUNCTION resolve_api_key(text) TO saas_app;
    """)


def downgrade() -> None:
    run("""
    DROP FUNCTION IF EXISTS resolve_api_key(text);
    DROP TABLE IF EXISTS refresh_tokens, billing_events, reports, subscriptions, usage_counters, audit_logs,
      api_keys, projects, invitations, memberships, tenants, users CASCADE;
    """)
