import json
import os
from abc import ABC, abstractmethod
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional, Tuple
from uuid import uuid4

try:
    import boto3
    from boto3.dynamodb.conditions import Attr, Key
except ImportError:  # pragma: no cover - boto3 available in Lambda
    boto3 = None
    Attr = None
    Key = None

try:
    import stripe
except ImportError:  # pragma: no cover - installed via requirements
    stripe = None

try:
    from backend.schemas import (
        BillingInvitationRecord,
        BillingSeatState,
        BillingSummary,
        InvitationStatus,
        SeatRole,
        SeatSubscriptionRecord,
    )
except ModuleNotFoundError:  # local run from backend/ directory
    from schemas import (
        BillingInvitationRecord,
        BillingSeatState,
        BillingSummary,
        InvitationStatus,
        SeatRole,
        SeatSubscriptionRecord,
    )


def utc_now() -> datetime:
    return datetime.now(timezone.utc)


def _as_bool(value: Optional[str], default: bool = False) -> bool:
    if value is None:
        return default
    return value.strip().lower() in {"1", "true", "yes", "on"}


def _as_int(value: Any, default: int) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


def _normalized_roles(roles: List[str]) -> set[str]:
    return {role.strip().lower() for role in roles if isinstance(role, str) and role.strip()}


def _user_has_role(user, role: SeatRole) -> bool:
    roles = _normalized_roles(getattr(user, "roles", []) or [])
    return role.value.lower() in roles


@dataclass
class SeatUsage:
    dispatcher_active: int = 0
    driver_active: int = 0
    dispatcher_pending: int = 0
    driver_pending: int = 0


class SeatLimitExceededError(Exception):
    pass


class BillingStore(ABC):
    @abstractmethod
    def get_subscription(self, org_id: str) -> Optional[SeatSubscriptionRecord]:
        raise NotImplementedError

    @abstractmethod
    def upsert_subscription(self, subscription: SeatSubscriptionRecord) -> SeatSubscriptionRecord:
        raise NotImplementedError

    @abstractmethod
    def get_invitation(self, org_id: str, invitation_id: str) -> Optional[BillingInvitationRecord]:
        raise NotImplementedError

    @abstractmethod
    def upsert_invitation(self, invitation: BillingInvitationRecord) -> BillingInvitationRecord:
        raise NotImplementedError

    @abstractmethod
    def list_invitations(
        self,
        org_id: str,
        status: Optional[InvitationStatus] = None,
    ) -> List[BillingInvitationRecord]:
        raise NotImplementedError

    @abstractmethod
    def find_subscription_by_stripe_subscription_id(
        self,
        stripe_subscription_id: str,
    ) -> Optional[SeatSubscriptionRecord]:
        raise NotImplementedError

    @abstractmethod
    def find_subscription_by_stripe_customer_id(
        self,
        stripe_customer_id: str,
    ) -> Optional[SeatSubscriptionRecord]:
        raise NotImplementedError


class InMemoryBillingStore(BillingStore):
    def __init__(self):
        self.subscriptions: Dict[str, SeatSubscriptionRecord] = {}
        self.invitations: Dict[Tuple[str, str], BillingInvitationRecord] = {}

    def get_subscription(self, org_id: str) -> Optional[SeatSubscriptionRecord]:
        return self.subscriptions.get(org_id)

    def upsert_subscription(self, subscription: SeatSubscriptionRecord) -> SeatSubscriptionRecord:
        self.subscriptions[subscription.org_id] = subscription
        return subscription

    def get_invitation(self, org_id: str, invitation_id: str) -> Optional[BillingInvitationRecord]:
        return self.invitations.get((org_id, invitation_id))

    def upsert_invitation(self, invitation: BillingInvitationRecord) -> BillingInvitationRecord:
        self.invitations[(invitation.org_id, invitation.invitation_id)] = invitation
        return invitation

    def list_invitations(
        self,
        org_id: str,
        status: Optional[InvitationStatus] = None,
    ) -> List[BillingInvitationRecord]:
        values = [value for (item_org, _), value in self.invitations.items() if item_org == org_id]
        if status is None:
            return values
        return [value for value in values if value.status == status]

    def find_subscription_by_stripe_subscription_id(
        self,
        stripe_subscription_id: str,
    ) -> Optional[SeatSubscriptionRecord]:
        for item in self.subscriptions.values():
            if item.stripe_subscription_id == stripe_subscription_id:
                return item
        return None

    def find_subscription_by_stripe_customer_id(
        self,
        stripe_customer_id: str,
    ) -> Optional[SeatSubscriptionRecord]:
        for item in self.subscriptions.values():
            if item.stripe_customer_id == stripe_customer_id:
                return item
        return None


class DynamoBillingStore(BillingStore):
    def __init__(self, subscriptions_table_name: str, invitations_table_name: str):
        if boto3 is None:
            raise RuntimeError("boto3 not available")
        resource = boto3.resource("dynamodb")
        self._subscriptions_table = resource.Table(subscriptions_table_name)
        self._invitations_table = resource.Table(invitations_table_name)

    def get_subscription(self, org_id: str) -> Optional[SeatSubscriptionRecord]:
        item = self._subscriptions_table.get_item(Key={"org_id": org_id}).get("Item")
        if not item:
            return None
        return SeatSubscriptionRecord.model_validate(item)

    def upsert_subscription(self, subscription: SeatSubscriptionRecord) -> SeatSubscriptionRecord:
        self._subscriptions_table.put_item(Item=subscription.model_dump(mode="json"))
        return subscription

    def get_invitation(self, org_id: str, invitation_id: str) -> Optional[BillingInvitationRecord]:
        item = self._invitations_table.get_item(Key={"org_id": org_id, "invitation_id": invitation_id}).get("Item")
        if not item:
            return None
        return BillingInvitationRecord.model_validate(item)

    def upsert_invitation(self, invitation: BillingInvitationRecord) -> BillingInvitationRecord:
        self._invitations_table.put_item(Item=invitation.model_dump(mode="json"))
        return invitation

    def list_invitations(
        self,
        org_id: str,
        status: Optional[InvitationStatus] = None,
    ) -> List[BillingInvitationRecord]:
        response = self._invitations_table.query(KeyConditionExpression=Key("org_id").eq(org_id))
        items = list(response.get("Items", []))
        while "LastEvaluatedKey" in response:
            response = self._invitations_table.query(
                KeyConditionExpression=Key("org_id").eq(org_id),
                ExclusiveStartKey=response["LastEvaluatedKey"],
            )
            items.extend(response.get("Items", []))
        records = [BillingInvitationRecord.model_validate(item) for item in items]
        if status is None:
            return records
        return [record for record in records if record.status == status]

    def find_subscription_by_stripe_subscription_id(
        self,
        stripe_subscription_id: str,
    ) -> Optional[SeatSubscriptionRecord]:
        response = self._subscriptions_table.scan(
            FilterExpression=Attr("stripe_subscription_id").eq(stripe_subscription_id),
            Limit=1,
        )
        items = response.get("Items", [])
        if not items:
            return None
        return SeatSubscriptionRecord.model_validate(items[0])

    def find_subscription_by_stripe_customer_id(
        self,
        stripe_customer_id: str,
    ) -> Optional[SeatSubscriptionRecord]:
        response = self._subscriptions_table.scan(
            FilterExpression=Attr("stripe_customer_id").eq(stripe_customer_id),
            Limit=1,
        )
        items = response.get("Items", [])
        if not items:
            return None
        return SeatSubscriptionRecord.model_validate(items[0])


_IN_MEMORY_BILLING_STORE = InMemoryBillingStore()


def reset_in_memory_billing_store():
    _IN_MEMORY_BILLING_STORE.subscriptions.clear()
    _IN_MEMORY_BILLING_STORE.invitations.clear()


def get_billing_store() -> BillingStore:
    force_memory = _as_bool(os.environ.get("USE_IN_MEMORY_BILLING_STORE"), default=False)
    if force_memory:
        return _IN_MEMORY_BILLING_STORE

    subscriptions_table = os.environ.get("SEAT_SUBSCRIPTIONS_TABLE")
    invitations_table = os.environ.get("SEAT_INVITATIONS_TABLE")
    if not subscriptions_table or not invitations_table:
        return _IN_MEMORY_BILLING_STORE

    try:
        return DynamoBillingStore(
            subscriptions_table_name=subscriptions_table,
            invitations_table_name=invitations_table,
        )
    except Exception:
        return _IN_MEMORY_BILLING_STORE


def default_subscription(org_id: str) -> SeatSubscriptionRecord:
    now = utc_now()
    return SeatSubscriptionRecord(
        org_id=org_id,
        created_at=now,
        updated_at=now,
    )


def get_or_default_subscription(org_id: str, billing_store: BillingStore) -> SeatSubscriptionRecord:
    existing = billing_store.get_subscription(org_id)
    if existing:
        return existing
    return default_subscription(org_id)


def calculate_seat_usage(org_id: str, identity_repo, billing_store: BillingStore) -> SeatUsage:
    users = identity_repo.list_users(org_id)
    active_dispatchers = sum(
        1 for user in users if user.is_active and _user_has_role(user, SeatRole.DISPATCHER)
    )
    active_drivers = sum(
        1 for user in users if user.is_active and _user_has_role(user, SeatRole.DRIVER)
    )

    pending_invitations = billing_store.list_invitations(org_id=org_id, status=InvitationStatus.PENDING)
    pending_dispatchers = sum(1 for invite in pending_invitations if invite.role == SeatRole.DISPATCHER)
    pending_drivers = sum(1 for invite in pending_invitations if invite.role == SeatRole.DRIVER)

    return SeatUsage(
        dispatcher_active=active_dispatchers,
        driver_active=active_drivers,
        dispatcher_pending=pending_dispatchers,
        driver_pending=pending_drivers,
    )


def _build_seat_state(total: int, used: int, pending: int) -> BillingSeatState:
    available = total - used - pending
    return BillingSeatState(
        total=total,
        used=used,
        pending=pending,
        available=max(0, available),
    )


def build_billing_summary(subscription: SeatSubscriptionRecord, usage: SeatUsage) -> BillingSummary:
    return BillingSummary(
        org_id=subscription.org_id,
        plan_name=subscription.plan_name,
        status=subscription.status,
        stripe_customer_id=subscription.stripe_customer_id,
        stripe_subscription_id=subscription.stripe_subscription_id,
        dispatcher_seats=_build_seat_state(
            total=subscription.dispatcher_seat_limit,
            used=usage.dispatcher_active,
            pending=usage.dispatcher_pending,
        ),
        driver_seats=_build_seat_state(
            total=subscription.driver_seat_limit,
            used=usage.driver_active,
            pending=usage.driver_pending,
        ),
        updated_at=subscription.updated_at,
    )


def ensure_seat_limit_for_invitation(role: SeatRole, subscription: SeatSubscriptionRecord, usage: SeatUsage):
    if role == SeatRole.DISPATCHER:
        reserved = usage.dispatcher_active + usage.dispatcher_pending
        if reserved >= subscription.dispatcher_seat_limit:
            raise SeatLimitExceededError("Dispatcher seat limit reached")
        return

    reserved = usage.driver_active + usage.driver_pending
    if reserved >= subscription.driver_seat_limit:
        raise SeatLimitExceededError("Driver seat limit reached")


def ensure_seat_limit_for_activation(role: SeatRole, subscription: SeatSubscriptionRecord, usage: SeatUsage):
    if role == SeatRole.DISPATCHER:
        if usage.dispatcher_active >= subscription.dispatcher_seat_limit:
            raise SeatLimitExceededError("Dispatcher seat limit reached for activation")
        return

    if usage.driver_active >= subscription.driver_seat_limit:
        raise SeatLimitExceededError("Driver seat limit reached for activation")


def new_invitation(org_id: str, user_id: str, email: Optional[str], role: SeatRole) -> BillingInvitationRecord:
    now = utc_now()
    return BillingInvitationRecord(
        org_id=org_id,
        invitation_id=str(uuid4()),
        user_id=user_id,
        email=email,
        role=role,
        status=InvitationStatus.PENDING,
        created_at=now,
        updated_at=now,
    )


def find_pending_invitation(
    org_id: str,
    user_id: str,
    role: SeatRole,
    billing_store: BillingStore,
) -> Optional[BillingInvitationRecord]:
    pending = billing_store.list_invitations(org_id=org_id, status=InvitationStatus.PENDING)
    for invitation in pending:
        if invitation.user_id == user_id and invitation.role == role:
            return invitation
    return None


def _extract_quantity_for_price(items: List[Dict[str, Any]], price_id: str) -> Optional[int]:
    if not price_id:
        return None
    for item in items:
        price = item.get("price", {})
        if isinstance(price, dict) and price.get("id") == price_id:
            return _as_int(item.get("quantity"), default=0)
    return None


def _extract_limits_from_subscription_object(
    subscription_object: Dict[str, Any],
    fallback_dispatcher: int,
    fallback_driver: int,
) -> Tuple[int, int]:
    metadata = subscription_object.get("metadata", {}) or {}
    items = (subscription_object.get("items", {}) or {}).get("data", []) or []
    dispatcher_price = os.environ.get("STRIPE_DISPATCHER_PRICE_ID", "").strip()
    driver_price = os.environ.get("STRIPE_DRIVER_PRICE_ID", "").strip()

    dispatcher = _extract_quantity_for_price(items, dispatcher_price)
    driver = _extract_quantity_for_price(items, driver_price)

    if dispatcher is None:
        dispatcher = _as_int(metadata.get("dispatcher_seat_limit"), fallback_dispatcher)
    if driver is None:
        driver = _as_int(metadata.get("driver_seat_limit"), fallback_driver)

    return max(0, dispatcher), max(0, driver)


class StripeClient(ABC):
    @abstractmethod
    def parse_webhook_event(self, payload: bytes, signature_header: Optional[str]) -> Dict[str, Any]:
        raise NotImplementedError

    @abstractmethod
    def update_subscription_quantities(
        self,
        subscription_id: str,
        dispatcher_seat_limit: int,
        driver_seat_limit: int,
    ) -> Dict[str, Any]:
        raise NotImplementedError

    @abstractmethod
    def create_checkout_session(
        self,
        org_id: str,
        dispatcher_seat_limit: int,
        driver_seat_limit: int,
        success_url: str,
        cancel_url: str,
        customer_id: Optional[str] = None,
    ) -> Dict[str, Any]:
        raise NotImplementedError


class DisabledStripeClient(StripeClient):
    def parse_webhook_event(self, payload: bytes, signature_header: Optional[str]) -> Dict[str, Any]:
        del signature_header
        return json.loads(payload.decode("utf-8"))

    def update_subscription_quantities(
        self,
        subscription_id: str,
        dispatcher_seat_limit: int,
        driver_seat_limit: int,
    ) -> Dict[str, Any]:
        del subscription_id, dispatcher_seat_limit, driver_seat_limit
        return {}

    def create_checkout_session(
        self,
        org_id: str,
        dispatcher_seat_limit: int,
        driver_seat_limit: int,
        success_url: str,
        cancel_url: str,
        customer_id: Optional[str] = None,
    ) -> Dict[str, Any]:
        del org_id, dispatcher_seat_limit, driver_seat_limit, success_url, cancel_url, customer_id
        raise RuntimeError("Stripe checkout is not configured")


class StripeSdkClient(StripeClient):
    def __init__(
        self,
        api_key: Optional[str],
        webhook_secret: Optional[str],
        dispatcher_price_id: str,
        driver_price_id: str,
    ):
        if stripe is None:
            raise RuntimeError("stripe package not available")
        self._api_key = api_key.strip() if api_key else ""
        self._webhook_secret = webhook_secret.strip() if webhook_secret else ""
        self._dispatcher_price_id = dispatcher_price_id
        self._driver_price_id = driver_price_id
        if self._api_key:
            stripe.api_key = self._api_key

    def parse_webhook_event(self, payload: bytes, signature_header: Optional[str]) -> Dict[str, Any]:
        if self._webhook_secret:
            if not signature_header:
                raise ValueError("Missing Stripe-Signature header")
            return stripe.Webhook.construct_event(
                payload=payload,
                sig_header=signature_header,
                secret=self._webhook_secret,
            )
        return json.loads(payload.decode("utf-8"))

    def _item_update(self, items: List[Dict[str, Any]], price_id: str, quantity: int) -> Optional[Dict[str, Any]]:
        if not price_id:
            return None
        for item in items:
            price = item.get("price", {})
            if isinstance(price, dict) and price.get("id") == price_id:
                return {"id": item["id"], "quantity": quantity}
        return {"price": price_id, "quantity": quantity}

    def update_subscription_quantities(
        self,
        subscription_id: str,
        dispatcher_seat_limit: int,
        driver_seat_limit: int,
    ) -> Dict[str, Any]:
        if not self._api_key:
            raise RuntimeError("STRIPE_SECRET_KEY is required to update subscription quantities")
        if not subscription_id:
            raise RuntimeError("Stripe subscription id is required")

        subscription = stripe.Subscription.retrieve(
            subscription_id,
            expand=["items.data.price"],
        )
        items = (subscription.get("items", {}) or {}).get("data", [])
        updates = []
        dispatcher_update = self._item_update(items, self._dispatcher_price_id, dispatcher_seat_limit)
        if dispatcher_update:
            updates.append(dispatcher_update)
        driver_update = self._item_update(items, self._driver_price_id, driver_seat_limit)
        if driver_update:
            updates.append(driver_update)

        if not updates:
            return subscription

        return stripe.Subscription.modify(
            subscription_id,
            items=updates,
            proration_behavior="create_prorations",
        )

    def create_checkout_session(
        self,
        org_id: str,
        dispatcher_seat_limit: int,
        driver_seat_limit: int,
        success_url: str,
        cancel_url: str,
        customer_id: Optional[str] = None,
    ) -> Dict[str, Any]:
        if not self._api_key:
            raise RuntimeError("STRIPE_SECRET_KEY is required to create checkout sessions")

        line_items = []
        if self._dispatcher_price_id and dispatcher_seat_limit > 0:
            line_items.append({"price": self._dispatcher_price_id, "quantity": dispatcher_seat_limit})
        if self._driver_price_id and driver_seat_limit > 0:
            line_items.append({"price": self._driver_price_id, "quantity": driver_seat_limit})

        if not line_items:
            raise RuntimeError("At least one Stripe seat price id must be configured with a non-zero quantity")

        params: Dict[str, Any] = {
            "mode": "subscription",
            "line_items": line_items,
            "success_url": success_url,
            "cancel_url": cancel_url,
            "allow_promotion_codes": True,
            "client_reference_id": org_id,
            "metadata": {"org_id": org_id, "plan_name": "seat-based"},
            "subscription_data": {
                "metadata": {
                    "org_id": org_id,
                    "plan_name": "seat-based",
                    "dispatcher_seat_limit": str(dispatcher_seat_limit),
                    "driver_seat_limit": str(driver_seat_limit),
                }
            },
        }
        if customer_id:
            params["customer"] = customer_id

        return stripe.checkout.Session.create(**params)


def get_stripe_client() -> StripeClient:
    api_key = os.environ.get("STRIPE_SECRET_KEY", "")
    webhook_secret = os.environ.get("STRIPE_WEBHOOK_SECRET", "")
    dispatcher_price = os.environ.get("STRIPE_DISPATCHER_PRICE_ID", "").strip()
    driver_price = os.environ.get("STRIPE_DRIVER_PRICE_ID", "").strip()

    if stripe is not None and (api_key.strip() or webhook_secret.strip()):
        return StripeSdkClient(
            api_key=api_key,
            webhook_secret=webhook_secret,
            dispatcher_price_id=dispatcher_price,
            driver_price_id=driver_price,
        )
    return DisabledStripeClient()


def apply_subscription_webhook(
    event: Dict[str, Any],
    billing_store: BillingStore,
) -> Optional[SeatSubscriptionRecord]:
    event_type = event.get("type") or ""
    if not event_type.startswith("customer.subscription."):
        return None

    payload = (event.get("data", {}) or {}).get("object", {}) or {}
    stripe_subscription_id = str(payload.get("id") or "").strip()
    stripe_customer_id = str(payload.get("customer") or "").strip()
    metadata = payload.get("metadata", {}) or {}
    metadata_org_id = str(metadata.get("org_id") or "").strip()

    existing = None
    org_id = metadata_org_id
    if stripe_subscription_id:
        existing = billing_store.find_subscription_by_stripe_subscription_id(stripe_subscription_id)
    if existing is None and stripe_customer_id:
        existing = billing_store.find_subscription_by_stripe_customer_id(stripe_customer_id)
    if not org_id and existing:
        org_id = existing.org_id
    if not org_id:
        return None

    current = existing or get_or_default_subscription(org_id, billing_store)
    dispatcher_limit, driver_limit = _extract_limits_from_subscription_object(
        payload,
        fallback_dispatcher=current.dispatcher_seat_limit,
        fallback_driver=current.driver_seat_limit,
    )

    updated = SeatSubscriptionRecord(
        org_id=org_id,
        plan_name=str(metadata.get("plan_name") or current.plan_name),
        status=str(payload.get("status") or current.status),
        stripe_customer_id=stripe_customer_id or current.stripe_customer_id,
        stripe_subscription_id=stripe_subscription_id or current.stripe_subscription_id,
        dispatcher_seat_limit=dispatcher_limit,
        driver_seat_limit=driver_limit,
        created_at=current.created_at,
        updated_at=utc_now(),
    )
    return billing_store.upsert_subscription(updated)
