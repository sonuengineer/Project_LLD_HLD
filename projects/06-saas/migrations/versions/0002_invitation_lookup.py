"""SECURITY DEFINER lookup for invitation acceptance

Revision ID: 0002
Revises: 0001
"""
from alembic import op

revision = "0002"
down_revision = "0001"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("""
    CREATE FUNCTION accept_invitation_lookup(p_hash text)
    RETURNS TABLE (id uuid, tenant_id uuid, email text, role text)
    LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
      SELECT id, tenant_id, email, role FROM invitations
       WHERE token_hash = p_hash AND accepted_at IS NULL AND expires_at > now()
    $$
    """)
    op.execute("REVOKE ALL ON FUNCTION accept_invitation_lookup(text) FROM PUBLIC")
    op.execute("GRANT EXECUTE ON FUNCTION accept_invitation_lookup(text) TO saas_app")


def downgrade() -> None:
    op.execute("DROP FUNCTION IF EXISTS accept_invitation_lookup(text)")
