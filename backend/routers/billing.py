import hmac
import os
from datetime import datetime, timezone
from typing import Optional
from uuid import uuid4

from fastapi import APIRouter, Depends, HTTPException, Request, status as http_status

try:
    from backend.auth import ROLE_ADMIN, require_roles
    from backend.billing_service import (
        SeatLimitExceededError,
        apply_subscription_webhook,
        build_billing_summary,
        calculate_seat_usage,
        ensure_seat_limit_for_activation,
        ensure_seat_limit_for_invitation,
        find_pending_invitation,
        get_billing_store,
        get_or_default_subscription,
        get_stripe_client,
        new_invitation,
    )
    from backend.repositories import get_identity_repository
    from backend.routers.orders import _orders, _tenant_orders
    from backend.schemas import (
        BillingInvitationCreateRequest,
        BillingInvitationRecord,
        BillingSeatsUpdateRequest,
        BillingSeatsUpdateResponse,
        BillingSummary,
        InvitationStatus,
        Order,
        OrderStatus,
        OrdersWebhookRequest,
        OrdersWebhookResponse,
        SeatSubscriptionRecord,
        StripeWebhookResponse,
        UserRecord,
    )
except ModuleNotFoundError:  # local run from backend/ directory
    from auth import ROLE_ADMIN, require_roles
    from billing_service import (
        SeatLimitExceededError,
        apply_subscription_webhook,
        build_billing_summary,
        calculate_seat_usage,
        ensure_seat_limit_for_activation,
        ensure_seat_limit_for_invitation,
        find_pending_invitation,
        get_billing_store,
        get_or_default_subscription,
        get_stripe_client,
        new_invitation,
    )
    from repositories import get_identity_repository
    from routers.orders import _orders, _tenant_orders
    from schemas import (
        BillingInvitationCreateRequest,
        BillingInvitationRecord,
        BillingSeatsUpdateRequest,
        BillingSeatsUpdateResponse,
        BillingSummary,
        InvitationStatus,
        Order,
        OrderStatus,
        OrdersWebhookRequest,
        OrdersWebhookResponse,
        SeatSubscriptionRecord,
        StripeWebhookResponse,
        UserRecord,
    )

router = APIRouter(tags=["billing"])


def _utc_now() -> datetime:
    return datetime.now(timezone.utc)


def _optional_text(value):
    if value is None:
        return None
    text = str(value).strip()
    return text or None


def _require_orders_webhook_token() -> str:
    token = os.environ.get("ORDERS_WEBHOOK_TOKEN", "").strip()
    if not token:
        raise HTTPException(
            status_code=http_status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Orders webhook is not configured",
        )
    return token


def _authorize_orders_webhook(request: Request):
    expected = _require_orders_webhook_token()
    provided = (request.headers.get("x-orders-webhook-token") or "").strip()
    if not provided or not hmac.compare_digest(provided, expected):
        raise HTTPException(
            status_code=http_status.HTTP_401_UNAUTHORIZED,
            detail="Invalid orders webhook token",
        )


def _find_existing_external_order(org_id: str, source: str, external_order_id: str) -> Optional[Order]:
    for order in _tenant_orders(org_id):
        if order.external_order_id == external_order_id and (order.source or "external") == source:
            return order
    return None


def _merge_stripe_subscription_snapshot(
    current: SeatSubscriptionRecord,
    stripe_subscription,
) -> SeatSubscriptionRecord:
    metadata = stripe_subscription.get("metadata", {}) if isinstance(stripe_subscription, dict) else {}
    status = _optional_text(stripe_subscription.get("status")) or current.status
    customer_id = _optional_text(stripe_subscription.get("customer")) or current.stripe_customer_id
    subscription_id = _optional_text(stripe_subscription.get("id")) or current.stripe_subscription_id
    return SeatSubscriptionRecord(
        org_id=current.org_id,
        plan_name=str(metadata.get("plan_name") or current.plan_name),
        status=status,
        stripe_customer_id=customer_id,
        stripe_subscription_id=subscription_id,
        dispatcher_seat_limit=current.dispatcher_seat_limit,
        driver_seat_limit=current.driver_seat_limit,
        created_at=current.created_at,
        updated_at=_utc_now(),
    )


@router.get("/billing/summary", response_model=BillingSummary)
async def get_billing_summary(
    user=Depends(require_roles([ROLE_ADMIN])),
    identity_repo=Depends(get_identity_repository),
    billing_store=Depends(get_billing_store),
):
    subscription = get_or_default_subscription(user["org_id"], billing_store)
    usage = calculate_seat_usage(user["org_id"], identity_repo, billing_store)
    return build_billing_summary(subscription, usage)


@router.post("/billing/seats", response_model=BillingSeatsUpdateResponse)
async def update_billing_seats(
    payload: BillingSeatsUpdateRequest,
    user=Depends(require_roles([ROLE_ADMIN])),
    identity_repo=Depends(get_identity_repository),
    billing_store=Depends(get_billing_store),
    stripe_client=Depends(get_stripe_client),
):
    if payload.dispatcher_seat_limit is None and payload.driver_seat_limit is None:
        raise HTTPException(
            status_code=http_status.HTTP_400_BAD_REQUEST,
            detail="At least one seat limit value is required",
        )

    subscription = get_or_default_subscription(user["org_id"], billing_store)
    usage = calculate_seat_usage(user["org_id"], identity_repo, billing_store)
    dispatcher_limit = (
        payload.dispatcher_seat_limit
        if payload.dispatcher_seat_limit is not None
        else subscription.dispatcher_seat_limit
    )
    driver_limit = (
        payload.driver_seat_limit
        if payload.driver_seat_limit is not None
        else subscription.driver_seat_limit
    )

    if dispatcher_limit < usage.dispatcher_active + usage.dispatcher_pending:
        raise HTTPException(
            status_code=http_status.HTTP_400_BAD_REQUEST,
            detail="Dispatcher seat limit cannot be lower than active + pending dispatchers",
        )
    if driver_limit < usage.driver_active + usage.driver_pending:
        raise HTTPException(
            status_code=http_status.HTTP_400_BAD_REQUEST,
            detail="Driver seat limit cannot be lower than active + pending drivers",
        )

    updated_subscription = SeatSubscriptionRecord(
        org_id=subscription.org_id,
        plan_name=subscription.plan_name,
        status=subscription.status,
        stripe_customer_id=subscription.stripe_customer_id,
        stripe_subscription_id=subscription.stripe_subscription_id,
        dispatcher_seat_limit=dispatcher_limit,
        driver_seat_limit=driver_limit,
        created_at=subscription.created_at,
        updated_at=_utc_now(),
    )

    if updated_subscription.stripe_subscription_id:
        try:
            stripe_subscription = stripe_client.update_subscription_quantities(
                subscription_id=updated_subscription.stripe_subscription_id,
                dispatcher_seat_limit=updated_subscription.dispatcher_seat_limit,
                driver_seat_limit=updated_subscription.driver_seat_limit,
            )
            if stripe_subscription:
                updated_subscription = _merge_stripe_subscription_snapshot(
                    current=updated_subscription,
                    stripe_subscription=stripe_subscription,
                )
        except Exception as exc:
            raise HTTPException(
                status_code=http_status.HTTP_502_BAD_GATEWAY,
                detail=f"Failed to sync seat limits with Stripe: {exc}",
            ) from exc

    persisted = billing_store.upsert_subscription(updated_subscription)
    summary = build_billing_summary(persisted, usage)
    return BillingSeatsUpdateResponse(summary=summary)


@router.post("/billing/invitations", response_model=BillingInvitationRecord)
async def create_invitation(
    payload: BillingInvitationCreateRequest,
    user=Depends(require_roles([ROLE_ADMIN])),
    identity_repo=Depends(get_identity_repository),
    billing_store=Depends(get_billing_store),
):
    subscription = get_or_default_subscription(user["org_id"], billing_store)
    usage = calculate_seat_usage(user["org_id"], identity_repo, billing_store)
    existing = find_pending_invitation(
        org_id=user["org_id"],
        user_id=payload.user_id,
        role=payload.role,
        billing_store=billing_store,
    )
    if existing:
        raise HTTPException(
            status_code=http_status.HTTP_409_CONFLICT,
            detail="Pending invitation already exists for this user and role",
        )

    try:
        ensure_seat_limit_for_invitation(payload.role, subscription, usage)
    except SeatLimitExceededError as exc:
        raise HTTPException(status_code=http_status.HTTP_409_CONFLICT, detail=str(exc)) from exc

    invitation = new_invitation(
        org_id=user["org_id"],
        user_id=payload.user_id,
        email=payload.email,
        role=payload.role,
    )
    return billing_store.upsert_invitation(invitation)


@router.post("/billing/invitations/{invitation_id}/activate", response_model=UserRecord)
async def activate_invitation(
    invitation_id: str,
    user=Depends(require_roles([ROLE_ADMIN])),
    identity_repo=Depends(get_identity_repository),
    billing_store=Depends(get_billing_store),
):
    invitation = billing_store.get_invitation(user["org_id"], invitation_id)
    if invitation is None:
        raise HTTPException(status_code=http_status.HTTP_404_NOT_FOUND, detail="Invitation not found")
    if invitation.status != InvitationStatus.PENDING:
        raise HTTPException(
            status_code=http_status.HTTP_409_CONFLICT,
            detail="Invitation is not pending",
        )

    subscription = get_or_default_subscription(user["org_id"], billing_store)
    usage = calculate_seat_usage(user["org_id"], identity_repo, billing_store)
    try:
        ensure_seat_limit_for_activation(invitation.role, subscription, usage)
    except SeatLimitExceededError as exc:
        raise HTTPException(status_code=http_status.HTTP_409_CONFLICT, detail=str(exc)) from exc

    existing_user = identity_repo.get_user(user["org_id"], invitation.user_id)
    now = _utc_now()
    roles = list(existing_user.roles) if existing_user else []
    if invitation.role.value not in roles:
        roles.append(invitation.role.value)

    user_record = UserRecord(
        org_id=user["org_id"],
        user_id=invitation.user_id,
        username=existing_user.username if existing_user else invitation.user_id,
        email=existing_user.email if existing_user and existing_user.email else invitation.email,
        roles=roles,
        is_active=True,
        created_at=existing_user.created_at if existing_user else now,
        updated_at=now,
    )
    saved_user = identity_repo.upsert_user(user_record)

    accepted_invitation = BillingInvitationRecord(
        org_id=invitation.org_id,
        invitation_id=invitation.invitation_id,
        user_id=invitation.user_id,
        email=invitation.email,
        role=invitation.role,
        status=InvitationStatus.ACCEPTED,
        created_at=invitation.created_at,
        updated_at=now,
    )
    billing_store.upsert_invitation(accepted_invitation)

    return saved_user


@router.post("/webhooks/orders", response_model=OrdersWebhookResponse)
async def order_ingest_webhook(payload: OrdersWebhookRequest, request: Request):
    _authorize_orders_webhook(request)

    created = 0
    updated = 0
    order_ids = []
    now = _utc_now()

    for incoming in payload.orders:
        existing = _find_existing_external_order(
            org_id=payload.org_id,
            source=payload.source,
            external_order_id=incoming.external_order_id,
        )
        if existing is None:
            order_id = str(uuid4())
            created_order = Order(
                id=order_id,
                customer_name=incoming.customer_name,
                reference_number=incoming.reference_number,
                pick_up_address=incoming.pick_up_address,
                delivery=incoming.delivery,
                dimensions=incoming.dimensions,
                weight=incoming.weight,
                phone=incoming.phone,
                email=incoming.email,
                notes=incoming.notes,
                num_packages=incoming.num_packages,
                external_order_id=incoming.external_order_id,
                source=payload.source,
                status=OrderStatus.CREATED,
                assigned_to=None,
                created_at=now,
                org_id=payload.org_id,
            )
            _orders[order_id] = created_order
            order_ids.append(order_id)
            created += 1
            continue

        updated_order = Order(
            id=existing.id,
            customer_name=incoming.customer_name,
            reference_number=incoming.reference_number,
            pick_up_address=incoming.pick_up_address,
            delivery=incoming.delivery,
            dimensions=incoming.dimensions,
            weight=incoming.weight,
            phone=incoming.phone,
            email=incoming.email,
            notes=incoming.notes,
            num_packages=incoming.num_packages,
            external_order_id=incoming.external_order_id,
            source=payload.source,
            status=existing.status,
            assigned_to=existing.assigned_to,
            created_at=existing.created_at,
            org_id=existing.org_id,
        )
        _orders[existing.id] = updated_order
        order_ids.append(existing.id)
        updated += 1

    return OrdersWebhookResponse(
        accepted=len(payload.orders),
        created=created,
        updated=updated,
        order_ids=order_ids,
    )


@router.post("/webhooks/stripe", response_model=StripeWebhookResponse)
async def stripe_webhook(
    request: Request,
    billing_store=Depends(get_billing_store),
    stripe_client=Depends(get_stripe_client),
):
    payload = await request.body()
    signature = request.headers.get("stripe-signature")
    try:
        event = stripe_client.parse_webhook_event(payload=payload, signature_header=signature)
    except ValueError as exc:
        raise HTTPException(status_code=http_status.HTTP_400_BAD_REQUEST, detail=str(exc)) from exc
    except Exception as exc:
        raise HTTPException(status_code=http_status.HTTP_400_BAD_REQUEST, detail="Invalid webhook payload") from exc

    updated = apply_subscription_webhook(event=event, billing_store=billing_store)
    return StripeWebhookResponse(
        received=True,
        event_type=event.get("type"),
        org_id=updated.org_id if updated else None,
    )
