import os
import re
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from typing import List, Optional
from uuid import uuid4

from fastapi import APIRouter, Depends, File, HTTPException, Query, UploadFile, status as http_status

try:
    from backend.audit_store import get_audit_log_store
    from backend.auth import ROLE_ADMIN, ROLE_DISPATCHER, ROLE_DRIVER, get_current_user, require_roles
    from backend.pod_service import get_pod_data_store, get_upload_expiry_seconds
    from backend.repositories import get_identity_repository
    from backend.schemas import (
        AuditLogRecord,
        OrganizationRecord,
        OrganizationUpdateRequest,
        ProfilePhotoPresignRequest,
        ProfilePhotoPresignResponse,
        UserProfileUpdate,
        UserRecord,
    )
except ModuleNotFoundError:  # local run from backend/ directory
    from audit_store import get_audit_log_store
    from auth import ROLE_ADMIN, ROLE_DISPATCHER, ROLE_DRIVER, get_current_user, require_roles
    from pod_service import get_pod_data_store, get_upload_expiry_seconds
    from repositories import get_identity_repository
    from schemas import (
        AuditLogRecord,
        OrganizationRecord,
        OrganizationUpdateRequest,
        ProfilePhotoPresignRequest,
        ProfilePhotoPresignResponse,
        UserProfileUpdate,
        UserRecord,
    )

router = APIRouter(tags=["identity"])
_USER_LIST_ROLES = {ROLE_ADMIN, ROLE_DISPATCHER, ROLE_DRIVER}

_PROFILE_PHOTO_ALLOWED_TYPES = {"image/jpeg", "image/png", "image/webp"}
_PROFILE_PHOTO_MAX_BYTES = 5 * 1024 * 1024  # 5 MB
_SAFE_EXT_RE = re.compile(r"[^a-z0-9.]")


def _safe_photo_ext(file_name: Optional[str]) -> str:
    if not file_name or "." not in file_name:
        return ""
    ext = file_name[file_name.rfind("."):].lower()
    ext = _SAFE_EXT_RE.sub("", ext)
    if not ext.startswith(".") or len(ext) > 10:
        return ""
    return ext


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
        # Fields sourced from the JWT / Cognito — always overwrite.
        username=user.get("username"),
        email=user.get("email"),
        roles=user.get("groups", []),
        is_active=True,
        # User-editable profile fields — preserve whatever was last saved so
        # that a plain GET /users/me never wipes phone, photo_url, or
        # tsa_certified that the user previously set via PUT /users/me.
        phone=existing_user.phone if existing_user else None,
        photo_url=existing_user.photo_url if existing_user else None,
        tsa_certified=existing_user.tsa_certified if existing_user else False,
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


@router.put("/users/me", response_model=UserRecord)
async def update_current_user_profile(
    payload: UserProfileUpdate,
    user=Depends(get_current_user),
    repo=Depends(get_identity_repository),
):
    _ensure_org(user, repo)
    record = _sync_user(user, repo)
    updates = payload.model_dump(exclude_unset=True)
    if not updates:
        return record
    for field, value in updates.items():
        setattr(record, field, value)
    record.updated_at = datetime.now(timezone.utc)
    return repo.upsert_user(record)


@router.post("/users/me/photo/presign", response_model=ProfilePhotoPresignResponse)
async def presign_profile_photo_upload(
    payload: ProfilePhotoPresignRequest,
    user=Depends(get_current_user),
    pod_store=Depends(get_pod_data_store),
):
    if payload.content_type not in _PROFILE_PHOTO_ALLOWED_TYPES:
        raise HTTPException(
            status_code=http_status.HTTP_400_BAD_REQUEST,
            detail=f"Unsupported content_type '{payload.content_type}'",
        )
    if payload.file_size_bytes > _PROFILE_PHOTO_MAX_BYTES:
        raise HTTPException(
            status_code=http_status.HTTP_400_BAD_REQUEST,
            detail=f"file_size_bytes exceeds maximum of {_PROFILE_PHOTO_MAX_BYTES}",
        )

    ext = _safe_photo_ext(payload.file_name)
    object_key = f"profile-photos/{user['org_id']}/{user['sub']}/{uuid4()}{ext}"
    expires_in = get_upload_expiry_seconds()
    presigned = pod_store.create_presigned_post(
        key=object_key,
        content_type=payload.content_type,
        expires_in=expires_in,
        max_size_bytes=_PROFILE_PHOTO_MAX_BYTES,
    )

    bucket = os.environ.get("POD_BUCKET_NAME", "")
    if bucket:
        region = os.environ.get("AWS_DEFAULT_REGION", "us-east-1")
        object_url = f"https://{bucket}.s3.{region}.amazonaws.com/{object_key}"
    else:
        object_url = f"https://example.invalid/{object_key}"

    return ProfilePhotoPresignResponse(
        url=presigned["url"],
        fields=presigned["fields"],
        key=object_key,
        object_url=object_url,
        expires_in=expires_in,
        max_size_bytes=_PROFILE_PHOTO_MAX_BYTES,
    )


_UPLOAD_DIR = Path(tempfile.gettempdir()) / "discra_uploads" / "profile-photos"
_PHOTO_EXT = {"image/png": ".png", "image/webp": ".webp"}


@router.post("/users/me/photo")
async def upload_profile_photo(
    file: UploadFile = File(...),
    user=Depends(get_current_user),
    repo=Depends(get_identity_repository),
):
    """Direct profile photo upload — single multipart POST, works in both
    local dev (files saved to temp dir, served via /uploads/ static mount)
    and production (PUT to S3 when POD_BUCKET_NAME is set)."""
    content_type = (file.content_type or "").split(";")[0].strip()
    if content_type not in _PROFILE_PHOTO_ALLOWED_TYPES:
        raise HTTPException(
            status_code=http_status.HTTP_400_BAD_REQUEST,
            detail=f"Unsupported image type '{content_type}'",
        )
    data = await file.read()
    if len(data) > _PROFILE_PHOTO_MAX_BYTES:
        raise HTTPException(
            status_code=http_status.HTTP_400_BAD_REQUEST,
            detail="Image must be under 5 MB",
        )

    ext = _PHOTO_EXT.get(content_type, ".jpg")
    bucket = os.environ.get("POD_BUCKET_NAME", "")
    if bucket:
        try:
            import boto3
            key = f"profile-photos/{user['org_id']}/{user['sub']}{ext}"
            boto3.client("s3").put_object(
                Bucket=bucket, Key=key, Body=data, ContentType=content_type
            )
            region = os.environ.get("AWS_DEFAULT_REGION", "us-east-1")
            photo_url = f"https://{bucket}.s3.{region}.amazonaws.com/{key}"
        except Exception as exc:
            raise HTTPException(
                status_code=http_status.HTTP_502_BAD_GATEWAY,
                detail="Photo upload to storage failed.",
            ) from exc
    else:
        # Local dev — persist to filesystem, served by the /uploads/ StaticFiles mount.
        dest_dir = _UPLOAD_DIR / user["org_id"]
        dest_dir.mkdir(parents=True, exist_ok=True)
        dest = dest_dir / f"{user['sub']}{ext}"
        dest.write_bytes(data)
        photo_url = (
            f"http://localhost:8000/uploads/profile-photos"
            f"/{user['org_id']}/{user['sub']}{ext}"
        )

    _ensure_org(user, repo)
    record = _sync_user(user, repo)
    record.photo_url = photo_url
    record.updated_at = datetime.now(timezone.utc)
    repo.upsert_user(record)
    return {"photo_url": photo_url}


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


@router.get("/audit/logs", response_model=List[AuditLogRecord])
async def list_audit_logs(
    limit: int = Query(default=100, ge=1, le=500),
    action: Optional[str] = Query(default=None),
    target_type: Optional[str] = Query(default=None),
    actor_id: Optional[str] = Query(default=None),
    user=Depends(require_roles([ROLE_ADMIN, ROLE_DISPATCHER])),
    audit_store=Depends(get_audit_log_store),
):
    return audit_store.list_events(
        user["org_id"],
        limit=limit,
        action=action,
        target_type=target_type,
        actor_id=actor_id,
    )
