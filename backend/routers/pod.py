from typing import List

from fastapi import APIRouter, Depends, HTTPException, status as http_status

try:
    from backend.auth import ROLE_ADMIN, ROLE_DISPATCHER, ROLE_DRIVER, require_roles
    from backend.pod_service import (
        build_pod_key,
        get_pod_data_store,
        get_upload_expiry_seconds,
        max_size_for_artifact,
        new_pod_metadata,
        pod_key_prefix,
        validate_presign_artifact,
    )
    from backend.routers.orders import _require_tenant_order
    from backend.schemas import (
        PodMetadataCreateRequest,
        PodMetadataRecord,
        PodMetadataRecordWithUrls,
        PodPresignRequest,
        PodPresignResponse,
        PodPresignedUpload,
    )
except ModuleNotFoundError:  # local run from backend/ directory
    from auth import ROLE_ADMIN, ROLE_DISPATCHER, ROLE_DRIVER, require_roles
    from pod_service import (
        build_pod_key,
        get_pod_data_store,
        get_upload_expiry_seconds,
        max_size_for_artifact,
        new_pod_metadata,
        pod_key_prefix,
        validate_presign_artifact,
    )
    from routers.orders import _require_tenant_order
    from schemas import (
        PodMetadataCreateRequest,
        PodMetadataRecord,
        PodMetadataRecordWithUrls,
        PodPresignRequest,
        PodPresignResponse,
        PodPresignedUpload,
    )

router = APIRouter(prefix="/pod", tags=["pod"])


def _require_assigned_driver(order, user):
    if order.assigned_to != user["sub"]:
        raise HTTPException(
            status_code=http_status.HTTP_403_FORBIDDEN,
            detail="POD actions require the assigned driver",
        )


def _validate_metadata_keys(prefix: str, keys: List[str]):
    for key in keys:
        if not isinstance(key, str) or not key.startswith(prefix):
            raise HTTPException(
                status_code=http_status.HTTP_400_BAD_REQUEST,
                detail=f"Invalid POD object key '{key}'",
            )


@router.post("/presign", response_model=PodPresignResponse)
async def create_pod_presigned_uploads(
    payload: PodPresignRequest,
    user=Depends(require_roles([ROLE_ADMIN, ROLE_DISPATCHER, ROLE_DRIVER])),
    pod_store=Depends(get_pod_data_store),
):
    order = _require_tenant_order(payload.order_id, user["org_id"])
    _require_assigned_driver(order, user)

    expires_in = get_upload_expiry_seconds()
    uploads = []
    for artifact in payload.artifacts:
        try:
            validate_presign_artifact(artifact)
        except ValueError as exc:
            raise HTTPException(status_code=http_status.HTTP_400_BAD_REQUEST, detail=str(exc)) from exc

        object_key = build_pod_key(
            org_id=user["org_id"],
            order_id=payload.order_id,
            driver_id=user["sub"],
            artifact=artifact,
        )
        max_size = max_size_for_artifact(artifact.artifact_type)
        presigned_post = pod_store.create_presigned_post(
            key=object_key,
            content_type=artifact.content_type,
            expires_in=expires_in,
            max_size_bytes=max_size,
        )
        uploads.append(
            PodPresignedUpload(
                artifact_type=artifact.artifact_type,
                key=object_key,
                url=presigned_post["url"],
                fields=presigned_post["fields"],
                expires_in=expires_in,
                max_size_bytes=max_size,
            )
        )

    return PodPresignResponse(uploads=uploads)


@router.post("/metadata", response_model=PodMetadataRecord)
async def create_pod_metadata(
    payload: PodMetadataCreateRequest,
    user=Depends(require_roles([ROLE_ADMIN, ROLE_DISPATCHER, ROLE_DRIVER])),
    pod_store=Depends(get_pod_data_store),
):
    order = _require_tenant_order(payload.order_id, user["org_id"])
    _require_assigned_driver(order, user)

    if not payload.photo_keys and not payload.signature_keys:
        raise HTTPException(
            status_code=http_status.HTTP_400_BAD_REQUEST,
            detail="At least one photo_keys or signature_keys entry is required",
        )

    key_prefix = pod_key_prefix(user["org_id"], payload.order_id, user["sub"])
    _validate_metadata_keys(key_prefix, payload.photo_keys)
    _validate_metadata_keys(key_prefix, payload.signature_keys)

    metadata = new_pod_metadata(
        org_id=user["org_id"],
        order_id=payload.order_id,
        driver_id=user["sub"],
        photo_keys=payload.photo_keys,
        signature_keys=payload.signature_keys,
        notes=payload.notes,
        captured_at=payload.captured_at,
        location=payload.location,
    )
    return pod_store.put_metadata(metadata)


@router.get("/order/{order_id}", response_model=List[PodMetadataRecordWithUrls])
async def list_pod_metadata_for_order(
    order_id: str,
    user=Depends(require_roles([ROLE_ADMIN, ROLE_DISPATCHER, ROLE_DRIVER])),
    pod_store=Depends(get_pod_data_store),
):
    order = _require_tenant_order(order_id, user["org_id"])
    user_roles = set(user.get("groups") or [])
    is_admin_or_dispatcher = bool(user_roles.intersection({ROLE_ADMIN, ROLE_DISPATCHER}))
    if not is_admin_or_dispatcher:
        _require_assigned_driver(order, user)

    records = pod_store.list_metadata_by_order(org_id=user["org_id"], order_id=order_id)
    enriched: List[PodMetadataRecordWithUrls] = []
    for record in records:
        photo_urls = [pod_store.generate_presigned_get_url(key) for key in record.photo_keys]
        signature_urls = [pod_store.generate_presigned_get_url(key) for key in record.signature_keys]
        enriched.append(
            PodMetadataRecordWithUrls(
                **record.model_dump(),
                photo_urls=photo_urls,
                signature_urls=signature_urls,
            )
        )
    enriched.sort(key=lambda r: r.created_at)
    return enriched
