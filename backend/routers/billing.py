import hmac
import os
from datetime import datetime, timezone
from typing import List, Optional
from uuid import uuid4

from fastapi import APIRouter, Depends, HTTPException, Request, status as http_status
from pydantic import ValidationError

try:
    from backend.auth import ROLE_ADMIN, require_roles
    from backend.audit_store import get_audit_log_store, new_event_id
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
    from backend.order_store import get_order_store
    from backend.repositories import get_identity_repository
    from backend.schemas import (
        BillingCheckoutRequest,
        BillingCheckoutResponse,
        BillingInvitationCreateRequest,
        BillingInvitationRecord,
        BillingPortalRequest,
        BillingPortalResponse,
        BillingProviderStatus,
        BillingSeatsUpdateRequest,
        BillingSeatsUpdateResponse,
        BillingSummary,
        InvitationStatus,
        AuditLogRecord,
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
    from audit_store import get_audit_log_store, new_event_id
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
    from order_store import get_order_store
    from repositories import get_identity_repository
    from schemas import (
        BillingCheckoutRequest,
        BillingCheckoutResponse,
        BillingInvitationCreateRequest,
        BillingInvitationRecord,
        BillingPortalRequest,
        BillingPortalResponse,
        BillingProviderStatus,
        BillingSeatsUpdateRequest,
        BillingSeatsUpdateResponse,
        BillingSummary,
        InvitationStatus,
        AuditLogRecord,
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


def _as_bool(value: Optional[str], default: bool = False) -> bool:
    if value is None:
        return default
    return value.strip().lower() in {"1", "true", "yes", "on"}


def _optional_text(value):
    if value is None:
        return None
    text = str(value).strip()
    return text or None


def _stripe_mode(secret_key: str) -> str:
    value = (secret_key or "").strip()
    if not value:
        return "disabled"
    if value.startswith("sk_live_"):
        return "live"
    if value.startswith("sk_test_"):
        return "test"
    return "configured"


def _require_stripe_webhook_secret():
    webhook_secret = _optional_text(os.environ.get("STRIPE_WEBHOOK_SECRET"))
    if webhook_secret:
        return

    allow_unsigned = _as_bool(
        os.environ.get("ALLOW_UNSAFE_STRIPE_WEBHOOK_WITHOUT_SECRET"),
        default=False,
    )
    if allow_unsigned:
        return

    raise HTTPException(
        status_code=http_status.HTTP_503_SERVICE_UNAVAILABLE,
        detail="Stripe webhook is not configured",
    )


def _request_id(request: Request):
    request_id = getattr(getattr(request, "state", object()), "request_id", None)
    if request_id:
        return str(request_id)
    return request.headers.get("x-correlation-id") or request.headers.get("x-request-id")


def _audit_event(
    audit_store,
    *,
    org_id: str,
    action: str,
    actor_id: Optional[str],
    actor_roles,
    target_type: str,
    target_id: str,
    request: Request,
    details: dict,
):
    now = _utc_now()
    event = AuditLogRecord(
        org_id=org_id,
        event_id=new_event_id(now),
        action=action,
        actor_id=actor_id,
        actor_roles=list(actor_roles or []),
        target_type=target_type,
        target_id=target_id,
        request_id=_request_id(request),
        details=details,
        created_at=now,
    )
    audit_store.put_event(event)


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


def _orders_webhook_hmac_secret() -> str:
    return os.environ.get("ORDERS_WEBHOOK_HMAC_SECRET", "").strip()


def _orders_webhook_allowed_org_id() -> str:
    return (os.environ.get("ORDERS_WEBHOOK_ALLOWED_ORG_ID") or "").strip()


def _orders_webhook_max_skew_seconds() -> int:
    raw_value = (os.environ.get("ORDERS_WEBHOOK_MAX_SKEW_SECONDS") or "").strip()
    if not raw_value:
        return 300
    try:
        parsed = int(raw_value)
    except ValueError:
        return 300
    return max(parsed, 0)


def _authorize_orders_webhook_signature(request: Request, raw_payload: bytes):
    secret = _orders_webhook_hmac_secret()
    if not secret:
        return

    raw_timestamp = (request.headers.get("x-orders-webhook-timestamp") or "").strip()
    raw_signature = (request.headers.get("x-orders-webhook-signature") or "").strip()
    if not raw_timestamp or not raw_signature:
        raise HTTPException(
            status_code=http_status.HTTP_401_UNAUTHORIZED,
            detail="Missing orders webhook signature headers",
        )

    try:
        timestamp = int(raw_timestamp)
    except ValueError as exc:
        raise HTTPException(
            status_code=http_status.HTTP_401_UNAUTHORIZED,
            detail="Invalid orders webhook timestamp",
        ) from exc

    max_skew = _orders_webhook_max_skew_seconds()
    now_epoch = int(_utc_now().timestamp())
    if abs(now_epoch - timestamp) > max_skew:
        raise HTTPException(
            status_code=http_status.HTTP_401_UNAUTHORIZED,
            detail="Orders webhook timestamp outside allowed window",
        )

    expected = hmac.new(
        secret.encode("utf-8"),
        f"{raw_timestamp}.".encode("utf-8") + raw_payload,
        digestmod="sha256",
    ).hexdigest()
    provided = raw_signature
    if provided.lower().startswith("sha256="):
        provided = provided.split("=", 1)[1]
    if not hmac.compare_digest(provided, expected):
        raise HTTPException(
            status_code=http_status.HTTP_401_UNAUTHORIZED,
            detail="Invalid orders webhook signature",
        )


def _find_existing_external_order(order_store, org_id: str, source: str, external_order_id: str) -> Optional[Order]:
    return order_store.find_order_by_external_id(
        org_id=org_id,
        source=source,
        external_order_id=external_order_id,
    )


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


@router.get("/billing/status", response_model=BillingProviderStatus)
async def get_billing_status(
    user=Depends(require_roles([ROLE_ADMIN])),
    billing_store=Depends(get_billing_store),
):
    subscription = get_or_default_subscription(user["org_id"], billing_store)
    secret_key = _optional_text(os.environ.get("STRIPE_SECRET_KEY")) or ""
    webhook_secret = _optional_text(os.environ.get("STRIPE_WEBHOOK_SECRET")) or ""
    dispatcher_price_id = _optional_text(os.environ.get("STRIPE_DISPATCHER_PRICE_ID")) or ""
    driver_price_id = _optional_text(os.environ.get("STRIPE_DRIVER_PRICE_ID")) or ""

    has_secret = bool(secret_key)
    has_webhook_secret = bool(webhook_secret)
    has_dispatcher_price = bool(dispatcher_price_id)
    has_driver_price = bool(driver_price_id)

    return BillingProviderStatus(
        org_id=user["org_id"],
        stripe_mode=_stripe_mode(secret_key),
        checkout_enabled=has_secret and (has_dispatcher_price or has_driver_price),
        webhook_signature_verification_enabled=has_webhook_secret,
        stripe_secret_key_configured=has_secret,
        stripe_webhook_secret_configured=has_webhook_secret,
        stripe_dispatcher_price_id_configured=has_dispatcher_price,
        stripe_driver_price_id_configured=has_driver_price,
        stripe_customer_id=subscription.stripe_customer_id,
        stripe_subscription_id=subscription.stripe_subscription_id,
    )


@router.post("/billing/seats", response_model=BillingSeatsUpdateResponse)
async def update_billing_seats(
    payload: BillingSeatsUpdateRequest,
    request: Request,
    user=Depends(require_roles([ROLE_ADMIN])),
    identity_repo=Depends(get_identity_repository),
    billing_store=Depends(get_billing_store),
    stripe_client=Depends(get_stripe_client),
    audit_store=Depends(get_audit_log_store),
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
    _audit_event(
        audit_store,
        org_id=user["org_id"],
        action="billing.seats.updated",
        actor_id=user.get("sub"),
        actor_roles=user.get("groups") or [],
        target_type="seat_subscription",
        target_id=user["org_id"],
        request=request,
        details={
            "dispatcher_seat_limit": persisted.dispatcher_seat_limit,
            "driver_seat_limit": persisted.driver_seat_limit,
            "stripe_subscription_id": persisted.stripe_subscription_id,
        },
    )
    return BillingSeatsUpdateResponse(summary=summary)


@router.post("/billing/checkout", response_model=BillingCheckoutResponse)
async def start_billing_checkout(
    payload: BillingCheckoutRequest,
    request: Request,
    user=Depends(require_roles([ROLE_ADMIN])),
    identity_repo=Depends(get_identity_repository),
    billing_store=Depends(get_billing_store),
    stripe_client=Depends(get_stripe_client),
    audit_store=Depends(get_audit_log_store),
):
    if payload.dispatcher_seat_limit is None and payload.driver_seat_limit is None:
        raise HTTPException(
            status_code=http_status.HTTP_400_BAD_REQUEST,
            detail="At least one seat limit value is required",
        )

    success_url = _optional_text(payload.success_url)
    cancel_url = _optional_text(payload.cancel_url)
    if not success_url or not cancel_url:
        raise HTTPException(
            status_code=http_status.HTTP_400_BAD_REQUEST,
            detail="success_url and cancel_url are required",
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
    if dispatcher_limit == 0 and driver_limit == 0:
        raise HTTPException(
            status_code=http_status.HTTP_400_BAD_REQUEST,
            detail="At least one seat limit must be greater than zero",
        )

    if subscription.stripe_subscription_id:
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
        _audit_event(
            audit_store,
            org_id=user["org_id"],
            action="billing.subscription.updated_via_api",
            actor_id=user.get("sub"),
            actor_roles=user.get("groups") or [],
            target_type="seat_subscription",
            target_id=user["org_id"],
            request=request,
            details={
                "dispatcher_seat_limit": persisted.dispatcher_seat_limit,
                "driver_seat_limit": persisted.driver_seat_limit,
                "stripe_subscription_id": persisted.stripe_subscription_id,
            },
        )
        return BillingCheckoutResponse(mode="subscription_update", summary=summary)

    try:
        checkout_session = stripe_client.create_checkout_session(
            org_id=user["org_id"],
            dispatcher_seat_limit=dispatcher_limit,
            driver_seat_limit=driver_limit,
            success_url=success_url,
            cancel_url=cancel_url,
            customer_id=subscription.stripe_customer_id,
        )
    except Exception as exc:
        raise HTTPException(
            status_code=http_status.HTTP_502_BAD_GATEWAY,
            detail=f"Failed to create Stripe checkout session: {exc}",
        ) from exc

    checkout_session_id = _optional_text(checkout_session.get("id")) if isinstance(checkout_session, dict) else None
    checkout_url = _optional_text(checkout_session.get("url")) if isinstance(checkout_session, dict) else None
    if not checkout_url:
        raise HTTPException(
            status_code=http_status.HTTP_502_BAD_GATEWAY,
            detail="Stripe checkout session did not return a redirect URL",
        )

    _audit_event(
        audit_store,
        org_id=user["org_id"],
        action="billing.checkout.session_created",
        actor_id=user.get("sub"),
        actor_roles=user.get("groups") or [],
        target_type="seat_subscription",
        target_id=user["org_id"],
        request=request,
        details={
            "dispatcher_seat_limit": dispatcher_limit,
            "driver_seat_limit": driver_limit,
            "stripe_checkout_session_id": checkout_session_id,
        },
    )
    return BillingCheckoutResponse(
        mode="checkout_session",
        checkout_url=checkout_url,
        checkout_session_id=checkout_session_id,
    )


@router.post("/billing/portal", response_model=BillingPortalResponse)
async def start_billing_portal(
    payload: BillingPortalRequest,
    request: Request,
    user=Depends(require_roles([ROLE_ADMIN])),
    billing_store=Depends(get_billing_store),
    stripe_client=Depends(get_stripe_client),
    audit_store=Depends(get_audit_log_store),
):
    return_url = _optional_text(payload.return_url)
    if not return_url:
        raise HTTPException(
            status_code=http_status.HTTP_400_BAD_REQUEST,
            detail="return_url is required",
        )

    subscription = get_or_default_subscription(user["org_id"], billing_store)
    customer_id = _optional_text(subscription.stripe_customer_id)
    if not customer_id:
        raise HTTPException(
            status_code=http_status.HTTP_409_CONFLICT,
            detail="Stripe customer is not linked for this organization",
        )

    try:
        portal_session = stripe_client.create_billing_portal_session(
            customer_id=customer_id,
            return_url=return_url,
        )
    except Exception as exc:
        raise HTTPException(
            status_code=http_status.HTTP_502_BAD_GATEWAY,
            detail=f"Failed to create Stripe billing portal session: {exc}",
        ) from exc

    portal_session_id = _optional_text(portal_session.get("id")) if isinstance(portal_session, dict) else None
    portal_url = _optional_text(portal_session.get("url")) if isinstance(portal_session, dict) else None
    if not portal_url:
        raise HTTPException(
            status_code=http_status.HTTP_502_BAD_GATEWAY,
            detail="Stripe billing portal did not return a redirect URL",
        )

    _audit_event(
        audit_store,
        org_id=user["org_id"],
        action="billing.portal.session_created",
        actor_id=user.get("sub"),
        actor_roles=user.get("groups") or [],
        target_type="seat_subscription",
        target_id=user["org_id"],
        request=request,
        details={
            "stripe_customer_id": customer_id,
            "stripe_portal_session_id": portal_session_id,
        },
    )
    return BillingPortalResponse(
        portal_url=portal_url,
        portal_session_id=portal_session_id,
    )


@router.post("/billing/invitations", response_model=BillingInvitationRecord)
async def create_invitation(
    payload: BillingInvitationCreateRequest,
    request: Request,
    user=Depends(require_roles([ROLE_ADMIN])),
    identity_repo=Depends(get_identity_repository),
    billing_store=Depends(get_billing_store),
    audit_store=Depends(get_audit_log_store),
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
    saved = billing_store.upsert_invitation(invitation)
    _audit_event(
        audit_store,
        org_id=user["org_id"],
        action="billing.invitation.created",
        actor_id=user.get("sub"),
        actor_roles=user.get("groups") or [],
        target_type="invitation",
        target_id=saved.invitation_id,
        request=request,
        details={
            "invited_user_id": saved.user_id,
            "role": saved.role.value,
            "status": saved.status.value,
        },
    )
    return saved


@router.get("/billing/invitations", response_model=List[BillingInvitationRecord])
async def list_invitations(
    status: Optional[InvitationStatus] = None,
    user=Depends(require_roles([ROLE_ADMIN])),
    billing_store=Depends(get_billing_store),
):
    invitations = billing_store.list_invitations(org_id=user["org_id"], status=status)
    return sorted(invitations, key=lambda invitation: invitation.created_at, reverse=True)


@router.post("/billing/invitations/{invitation_id}/activate", response_model=UserRecord)
async def activate_invitation(
    invitation_id: str,
    request: Request,
    user=Depends(require_roles([ROLE_ADMIN])),
    identity_repo=Depends(get_identity_repository),
    billing_store=Depends(get_billing_store),
    audit_store=Depends(get_audit_log_store),
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
    _audit_event(
        audit_store,
        org_id=user["org_id"],
        action="billing.invitation.activated",
        actor_id=user.get("sub"),
        actor_roles=user.get("groups") or [],
        target_type="invitation",
        target_id=invitation.invitation_id,
        request=request,
        details={
            "user_id": invitation.user_id,
            "role": invitation.role.value,
            "status": accepted_invitation.status.value,
        },
    )

    return saved_user


@router.post("/billing/invitations/{invitation_id}/cancel", response_model=BillingInvitationRecord)
async def cancel_invitation(
    invitation_id: str,
    request: Request,
    user=Depends(require_roles([ROLE_ADMIN])),
    billing_store=Depends(get_billing_store),
    audit_store=Depends(get_audit_log_store),
):
    invitation = billing_store.get_invitation(user["org_id"], invitation_id)
    if invitation is None:
        raise HTTPException(status_code=http_status.HTTP_404_NOT_FOUND, detail="Invitation not found")
    if invitation.status != InvitationStatus.PENDING:
        raise HTTPException(
            status_code=http_status.HTTP_409_CONFLICT,
            detail="Only pending invitations can be cancelled",
        )

    now = _utc_now()
    cancelled = BillingInvitationRecord(
        org_id=invitation.org_id,
        invitation_id=invitation.invitation_id,
        user_id=invitation.user_id,
        email=invitation.email,
        role=invitation.role,
        status=InvitationStatus.CANCELLED,
        created_at=invitation.created_at,
        updated_at=now,
    )
    saved = billing_store.upsert_invitation(cancelled)
    _audit_event(
        audit_store,
        org_id=user["org_id"],
        action="billing.invitation.cancelled",
        actor_id=user.get("sub"),
        actor_roles=user.get("groups") or [],
        target_type="invitation",
        target_id=invitation.invitation_id,
        request=request,
        details={
            "user_id": invitation.user_id,
            "role": invitation.role.value,
            "status": saved.status.value,
        },
    )
    return saved


@router.post("/webhooks/orders", response_model=OrdersWebhookResponse)
async def order_ingest_webhook(request: Request):
    _authorize_orders_webhook(request)
    raw_payload = await request.body()
    _authorize_orders_webhook_signature(request, raw_payload)

    try:
        payload = OrdersWebhookRequest.model_validate_json(raw_payload)
    except ValidationError as exc:
        raise HTTPException(
            status_code=http_status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=exc.errors(include_context=False),
        ) from exc

    duplicate_external_ids = []
    seen_external_ids = set()
    for incoming in payload.orders:
        external_order_id = incoming.external_order_id.strip()
        if external_order_id in seen_external_ids and external_order_id not in duplicate_external_ids:
            duplicate_external_ids.append(external_order_id)
        seen_external_ids.add(external_order_id)

    if duplicate_external_ids:
        raise HTTPException(
            status_code=http_status.HTTP_400_BAD_REQUEST,
            detail="Duplicate external_order_id values in payload: " + ", ".join(duplicate_external_ids),
        )

    allowed_org_id = _orders_webhook_allowed_org_id()
    if not allowed_org_id:
        raise HTTPException(
            status_code=http_status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Orders webhook org binding is not configured",
        )
    if payload.org_id != allowed_org_id:
        raise HTTPException(
            status_code=http_status.HTTP_403_FORBIDDEN,
            detail="Orders webhook org is not allowed",
        )

    order_store = get_order_store()

    created = 0
    updated = 0
    order_ids = []
    now = _utc_now()

    for incoming in payload.orders:
        existing = _find_existing_external_order(
            order_store=order_store,
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
                time_window_start=incoming.time_window_start,
                time_window_end=incoming.time_window_end,
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
            order_store.upsert_order(created_order)
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
            time_window_start=incoming.time_window_start,
            time_window_end=incoming.time_window_end,
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
        order_store.upsert_order(updated_order)
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
    audit_store=Depends(get_audit_log_store),
):
    _require_stripe_webhook_secret()
    payload = await request.body()
    signature = request.headers.get("stripe-signature")
    try:
        event = stripe_client.parse_webhook_event(payload=payload, signature_header=signature)
    except ValueError as exc:
        raise HTTPException(status_code=http_status.HTTP_400_BAD_REQUEST, detail=str(exc)) from exc
    except Exception as exc:
        raise HTTPException(status_code=http_status.HTTP_400_BAD_REQUEST, detail="Invalid webhook payload") from exc

    updated = apply_subscription_webhook(event=event, billing_store=billing_store)
    if updated is not None:
        _audit_event(
            audit_store,
            org_id=updated.org_id,
            action="billing.subscription.webhook_applied",
            actor_id="stripe-webhook",
            actor_roles=[],
            target_type="seat_subscription",
            target_id=updated.org_id,
            request=request,
            details={
                "event_type": event.get("type"),
                "stripe_subscription_id": updated.stripe_subscription_id,
                "dispatcher_seat_limit": updated.dispatcher_seat_limit,
                "driver_seat_limit": updated.driver_seat_limit,
            },
        )
    return StripeWebhookResponse(
        received=True,
        event_type=event.get("type"),
        org_id=updated.org_id if updated else None,
    )
