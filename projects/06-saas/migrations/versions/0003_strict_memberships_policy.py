"""Strict tenant-only RLS on memberships; cross-tenant 'my workspaces' via SECURITY DEFINER.

Bug fixed (found by test_tenant_isolation_over_http): the memberships policy allowed
`OR user_id = app.user_id`, so `SELECT role FROM memberships WHERE user_id = :me` inside tenant A
returned the caller's role from tenant B -> a non-member was treated as an owner of tenant A.
An OR in a policy breaks the invariant "an unfiltered query is still tenant-safe".

Revision ID: 0003
Revises: 0002
"""
from alembic import op

revision = "0003"
down_revision = "0002"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("DROP POLICY tenant_isolation ON memberships")
    op.execute("""
    CREATE POLICY tenant_isolation ON memberships
      USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
      WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
    """)
    op.execute("""
    CREATE FUNCTION user_tenants(p_user uuid)
    RETURNS TABLE (id uuid, slug text, name text, plan text, status text, role text)
    LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
      SELECT t.id, t.slug, t.name, t.plan, t.status, m.role
        FROM memberships m JOIN tenants t ON t.id = m.tenant_id
       WHERE m.user_id = p_user ORDER BY t.created_at
    $$
    """)
    op.execute("REVOKE ALL ON FUNCTION user_tenants(uuid) FROM PUBLIC")
    op.execute("GRANT EXECUTE ON FUNCTION user_tenants(uuid) TO saas_app")


def downgrade() -> None:
    op.execute("DROP FUNCTION IF EXISTS user_tenants(uuid)")
    op.execute("DROP POLICY tenant_isolation ON memberships")
    op.execute("""
    CREATE POLICY tenant_isolation ON memberships
      USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
             OR user_id = nullif(current_setting('app.user_id', true), '')::uuid)
      WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
    """)
