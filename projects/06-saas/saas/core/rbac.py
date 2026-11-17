"""RBAC: roles -> permissions. One ABAC rule shows where RBAC alone isn't enough.

RBAC answers "what can this ROLE do?" (an admin can delete projects).
ABAC adds attributes of the user/resource/context ("a member can delete a project THEY created").
"""
from __future__ import annotations

from enum import StrEnum


class P(StrEnum):
    PROJECT_READ = "project:read"
    PROJECT_WRITE = "project:write"
    PROJECT_DELETE = "project:delete"
    MEMBER_READ = "member:read"
    MEMBER_INVITE = "member:invite"
    MEMBER_MANAGE = "member:manage"
    APIKEY_MANAGE = "apikey:manage"
    AUDIT_READ = "audit:read"
    BILLING_MANAGE = "billing:manage"
    TENANT_MANAGE = "tenant:manage"
    REPORT_RUN = "report:run"


_VIEWER = {P.PROJECT_READ, P.MEMBER_READ}
_MEMBER = _VIEWER | {P.PROJECT_WRITE, P.REPORT_RUN}
_ADMIN = _MEMBER | {P.PROJECT_DELETE, P.MEMBER_INVITE, P.MEMBER_MANAGE, P.APIKEY_MANAGE, P.AUDIT_READ}
_OWNER = _ADMIN | {P.BILLING_MANAGE, P.TENANT_MANAGE}

ROLE_PERMISSIONS: dict[str, frozenset[P]] = {
    "viewer": frozenset(_VIEWER), "member": frozenset(_MEMBER), "admin": frozenset(_ADMIN), "owner": frozenset(_OWNER),
}
ROLE_RANK = {"viewer": 0, "member": 1, "admin": 2, "owner": 3}


def can_delete_project(permissions: frozenset[P], actor_user_id, project_created_by) -> bool:
    """ABAC rule: admins (permission) OR the creator of this specific project (attribute)."""
    if P.PROJECT_DELETE in permissions:
        return True
    return P.PROJECT_WRITE in permissions and actor_user_id is not None and actor_user_id == project_created_by


def can_assign_role(actor_role: str, target_role: str) -> bool:
    """No privilege escalation: you can only grant roles below your own (owners may grant admin)."""
    return ROLE_RANK[target_role] < ROLE_RANK[actor_role]
