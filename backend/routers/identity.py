from datetime import datetime, timezone

from typing import List, Optional

from fastapi import APIRouter, Depends, HTTPException, Query, status as http_status

try:
    from backend.auth import ROLE_ADMIN, ROLE_DISPATCHER, ROLE_DRIVER, get_current_user, require_roles
    from backend.repositories import get_identity_repository
    from backend.schemas import OrganizationRecord, OrganizationUpdateRequest, UserRecord
except ModuleNotFoundError:  # local run from backend/ directory
    from auth import ROLE_ADMIN, ROLE_DISPATCHER, ROLE_DRIVER, get_current_user, require_roles
    from repositories import get_identity_repository
    from schemas import OrganizationRecord, OrganizationUpdateRequest, UserRecord

router = APIRouter(tags=["identity"])
_USER_LIST_ROLES = {ROLE_ADMIN, ROLE_DISPATCHER, ROLE_DRIVER}


def _default_org_name(user) -> str:
    claims = user.get("claims", {})
    return claims.get("custom:org_name") or claims.get("org_name") or f"Org {user['org_id']}"


def _ensure_org(user, repo) -> OrganizationRecord:
    existing_org = repo.get_org(user["org_id"])
    if existing_org:
        return existing_org

    now = datetime.now(timezone.utc)
    org = OrganizationRecord(
        org_id=user["org_id"],
        name=_default_org_name(user),
        created_by=user["sub"],
        created_at=now,
        updated_at=now,
    )
    return repo.upsert_org(org)


def _sync_user(user, repo) -> UserRecord:
    existing_user = repo.get_user(user["org_id"], user["sub"])
    now = datetime.now(timezone.utc)

    record = UserRecord(
        org_id=user["org_id"],
        user_id=user["sub"],
        username=user.get("username"),
        email=user.get("email"),
        roles=user.get("groups", []),
        is_active=True,
        created_at=existing_user.created_at if existing_user else now,
        updated_at=now,
    )
    return repo.upsert_user(record)


@router.get("/users/me", response_model=UserRecord)
async def get_current_user_record(
    user=Depends(get_current_user),
    repo=Depends(get_identity_repository),
):
    _ensure_org(user, repo)
    return _sync_user(user, repo)


@router.post("/users/me/sync", response_model=UserRecord)
async def sync_current_user_record(
    user=Depends(get_current_user),
    repo=Depends(get_identity_repository),
):
    _ensure_org(user, repo)
    return _sync_user(user, repo)


@router.get("/users", response_model=List[UserRecord])
async def list_users(
    role: Optional[str] = Query(default=None),
    active_only: bool = Query(default=True),
    user=Depends(require_roles([ROLE_ADMIN, ROLE_DISPATCHER])),
    repo=Depends(get_identity_repository),
):
    if role is not None and role not in _USER_LIST_ROLES:
        raise HTTPException(
            status_code=http_status.HTTP_400_BAD_REQUEST,
            detail=f"Invalid role filter '{role}'",
        )

    users = repo.list_users(user["org_id"])
    if active_only:
        users = [record for record in users if record.is_active]
    if role is not None:
        users = [record for record in users if role in (record.roles or [])]
    return sorted(users, key=lambda record: record.user_id)


@router.get("/orgs/me", response_model=OrganizationRecord)
async def get_current_org(
    user=Depends(get_current_user),
    repo=Depends(get_identity_repository),
):
    return _ensure_org(user, repo)


@router.put("/orgs/me", response_model=OrganizationRecord)
async def update_current_org(
    payload: OrganizationUpdateRequest,
    user=Depends(require_roles([ROLE_ADMIN])),
    repo=Depends(get_identity_repository),
):
    existing = _ensure_org(user, repo)
    updated = OrganizationRecord(
        org_id=existing.org_id,
        name=payload.name.strip(),
        created_by=existing.created_by,
        created_at=existing.created_at,
        updated_at=datetime.now(timezone.utc),
    )
    return repo.upsert_org(updated)
