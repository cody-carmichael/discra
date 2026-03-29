import os
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends
from pydantic import BaseModel

try:
    from backend.auth import ROLE_DRIVER, ROLE_ADMIN, ROLE_DISPATCHER, get_current_user, require_roles
    from backend.push_store import get_push_subscription_store, SUBSCRIPTION_TTL_DAYS
    from backend.schemas import PushSubscriptionRecord
except ModuleNotFoundError:  # local run from backend/ directory
    from auth import ROLE_DRIVER, ROLE_ADMIN, ROLE_DISPATCHER, get_current_user, require_roles
    from push_store import get_push_subscription_store, SUBSCRIPTION_TTL_DAYS
    from schemas import PushSubscriptionRecord

router = APIRouter(prefix="/push", tags=["push"])


class PushSubscribeRequest(BaseModel):
    endpoint: str
    p256dh: str
    auth: str


@router.get("/vapid-public-key")
async def get_vapid_public_key():
    """Return the VAPID public key so the frontend can subscribe to push."""
    return {"publicKey": os.environ.get("VAPID_PUBLIC_KEY", "")}


@router.post("/subscribe")
async def subscribe_push(
    body: PushSubscribeRequest,
    user=Depends(require_roles([ROLE_DRIVER, ROLE_ADMIN, ROLE_DISPATCHER])),
    push_store=Depends(get_push_subscription_store),
):
    """Register or update a push subscription for the authenticated driver."""
    now = datetime.now(timezone.utc)
    expires_at = now + timedelta(days=SUBSCRIPTION_TTL_DAYS)

    record = PushSubscriptionRecord(
        org_id=user["org_id"],
        driver_id=user["sub"],
        endpoint=body.endpoint,
        p256dh=body.p256dh,
        auth=body.auth,
        created_at=now,
        expires_at_epoch=int(expires_at.timestamp()),
    )
    push_store.upsert_subscription(record)
    return {"ok": True}
