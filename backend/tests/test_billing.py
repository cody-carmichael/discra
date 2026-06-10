import base64
import hashlib
import hmac
import json
import os
import sys
import time

import pytest
from fastapi.testclient import TestClient

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "../..")))

from backend.app import app
from backend.audit_store import get_audit_log_store, reset_in_memory_audit_log_store
from backend.billing_service import get_billing_store, reset_in_memory_billing_store
from backend.routers import billing as billing_router
from backend.schemas import SeatSubscriptionRecord
from backend.repositories import _IN_MEMORY_REPO

client = TestClient(app)


def make_token(sub: str, org_id: str, groups):
    payload = {
        "sub": sub,
        "custom:org_id": org_id,
        "cognito:groups": groups,
        "email": f"{sub}@example.com",
        "cognito:username": sub,
    }
    header = base64.urlsafe_b64encode(json.dumps({"alg": "none"}).encode()).rstrip(b"=")
    body = base64.urlsafe_b64encode(json.dumps(payload).encode()).rstrip(b"=")
    return f"{header.decode()}.{body.decode()}."


@pytest.fixture(autouse=True)
def _test_env(monkeypatch):
    monkeypatch.setenv("JWT_VERIFY_SIGNATURE", "false")
    monkeypatch.setenv("USE_IN_MEMORY_IDENTITY_STORE", "true")
    monkeypatch.setenv("USE_IN_MEMORY_BILLING_STORE", "true")
    monkeypatch.setenv("USE_IN_MEMORY_AUDIT_LOG_STORE", "true")
    monkeypatch.delenv("STRIPE_WEBHOOK_SECRET", raising=False)
    monkeypatch.delenv("STRIPE_SECRET_KEY", raising=False)
    monkeypatch.delenv("STRIPE_DISPATCHER_PRICE_ID", raising=False)
    monkeypatch.delenv("STRIPE_DRIVER_PRICE_ID", raising=False)
    monkeypatch.delenv("ALLOW_UNSAFE_STRIPE_WEBHOOK_WITHOUT_SECRET", raising=False)
    reset_in_memory_billing_store()
    reset_in_memory_audit_log_store()
    _IN_MEMORY_REPO._orgs.clear()
    _IN_MEMORY_REPO._users.clear()
    app.dependency_overrides.clear()
    yield
    app.dependency_overrides.clear()


def _auth_header(token: str):
    return {"Authorization": f"Bearer {token}"}


class _FakeStripeClient:
    def parse_webhook_event(self, payload: bytes, signature_header):
        del signature_header
        return json.loads(payload.decode("utf-8"))

    def update_subscription_quantities(self, subscription_id: str, dispatcher_seat_limit: int, driver_seat_limit: int):
        return {
            "id": subscription_id,
            "customer": "cus_test",
            "status": "active",
            "metadata": {"plan_name": "seat-based"},
            "items": {
                "data": [
                    {"id": "si_dispatch", "quantity": dispatcher_seat_limit, "price": {"id": "price_dispatcher"}},
                    {"id": "si_driver", "quantity": driver_seat_limit, "price": {"id": "price_driver"}},
                ]
            },
        }

    def create_checkout_session(
        self,
        org_id: str,
        dispatcher_seat_limit: int,
        driver_seat_limit: int,
        success_url: str,
        cancel_url: str,
        customer_id=None,
    ):
        del org_id, dispatcher_seat_limit, driver_seat_limit, success_url, cancel_url, customer_id
        return {"id": "cs_test_123", "url": "https://checkout.stripe.test/session/cs_test_123"}

    def create_billing_portal_session(self, customer_id: str, return_url: str):
        del customer_id, return_url
        return {"id": "bps_test_123", "url": "https://billing.stripe.test/session/bps_test_123"}


def test_admin_can_read_default_billing_summary():
    admin_token = make_token("admin-1", "org-1", ["Admin"])

    response = client.get("/billing/summary", headers=_auth_header(admin_token))
    assert response.status_code == 200
    body = response.json()
    assert body["dispatcher_seats"]["total"] == 0
    assert body["driver_seats"]["total"] == 0
    assert body["dispatcher_seats"]["available"] == 0
    assert body["driver_seats"]["available"] == 0


def test_admin_can_read_billing_status_defaults(monkeypatch):
    monkeypatch.delenv("STRIPE_SECRET_KEY", raising=False)
    monkeypatch.delenv("STRIPE_WEBHOOK_SECRET", raising=False)
    monkeypatch.delenv("STRIPE_DISPATCHER_PRICE_ID", raising=False)
    monkeypatch.delenv("STRIPE_DRIVER_PRICE_ID", raising=False)
    admin_token = make_token("admin-1", "org-1", ["Admin"])

    response = client.get("/billing/status", headers=_auth_header(admin_token))
    assert response.status_code == 200
    body = response.json()
    assert body["stripe_mode"] == "disabled"
    assert body["checkout_enabled"] is False
    assert body["webhook_signature_verification_enabled"] is False
    assert body["stripe_secret_key_configured"] is False
    assert body["stripe_dispatcher_price_id_configured"] is False
    assert body["stripe_driver_price_id_configured"] is False
    assert body["stripe_subscription_id"] is None


def test_admin_can_read_billing_status_when_stripe_configured(monkeypatch):
    monkeypatch.setenv("STRIPE_SECRET_KEY", "sk_test_123")
    monkeypatch.setenv("STRIPE_WEBHOOK_SECRET", "whsec_123")
    monkeypatch.setenv("STRIPE_DISPATCHER_PRICE_ID", "price_dispatch")
    monkeypatch.setenv("STRIPE_DRIVER_PRICE_ID", "price_driver")
    admin_token = make_token("admin-1", "org-1", ["Admin"])

    billing_store = get_billing_store()
    billing_store.upsert_subscription(
        SeatSubscriptionRecord(
            org_id="org-1",
            stripe_customer_id="cus_abc",
            stripe_subscription_id="sub_abc",
            dispatcher_seat_limit=2,
            driver_seat_limit=4,
            created_at=billing_router._utc_now(),
            updated_at=billing_router._utc_now(),
        )
    )

    response = client.get("/billing/status", headers=_auth_header(admin_token))
    assert response.status_code == 200
    body = response.json()
    assert body["stripe_mode"] == "test"
    assert body["checkout_enabled"] is True
    assert body["webhook_signature_verification_enabled"] is True
    assert body["stripe_secret_key_configured"] is True
    assert body["stripe_webhook_secret_configured"] is True
    assert body["stripe_dispatcher_price_id_configured"] is True
    assert body["stripe_driver_price_id_configured"] is True
    assert body["stripe_customer_id"] == "cus_abc"
    assert body["stripe_subscription_id"] == "sub_abc"


def test_checkout_creates_session_when_subscription_missing():
    admin_token = make_token("admin-1", "org-1", ["Admin"])
    app.dependency_overrides[billing_router.get_stripe_client] = lambda: _FakeStripeClient()

    response = client.post(
        "/billing/checkout",
        json={
            "dispatcher_seat_limit": 2,
            "driver_seat_limit": 3,
            "success_url": "https://example.com/admin?checkout=success",
            "cancel_url": "https://example.com/admin?checkout=cancel",
        },
        headers=_auth_header(admin_token),
    )
    assert response.status_code == 200
    body = response.json()
    assert body["mode"] == "checkout_session"
    assert body["checkout_session_id"] == "cs_test_123"
    assert body["checkout_url"].startswith("https://checkout.stripe.test/")

    audit_events = get_audit_log_store().list_events("org-1", limit=10)
    assert any(event.action == "billing.checkout.session_created" for event in audit_events)


def test_checkout_updates_existing_subscription_without_session():
    admin_token = make_token("admin-1", "org-1", ["Admin"])
    app.dependency_overrides[billing_router.get_stripe_client] = lambda: _FakeStripeClient()

    billing_store = get_billing_store()
    existing = SeatSubscriptionRecord(
        org_id="org-1",
        stripe_customer_id="cus_existing",
        stripe_subscription_id="sub_existing",
        dispatcher_seat_limit=1,
        driver_seat_limit=1,
        created_at=billing_router._utc_now(),
        updated_at=billing_router._utc_now(),
    )
    billing_store.upsert_subscription(existing)

    response = client.post(
        "/billing/checkout",
        json={
            "dispatcher_seat_limit": 4,
            "driver_seat_limit": 5,
            "success_url": "https://example.com/admin?checkout=success",
            "cancel_url": "https://example.com/admin?checkout=cancel",
        },
        headers=_auth_header(admin_token),
    )
    assert response.status_code == 200
    body = response.json()
    assert body["mode"] == "subscription_update"
    assert body["summary"]["dispatcher_seats"]["total"] == 4
    assert body["summary"]["driver_seats"]["total"] == 5

    audit_events = get_audit_log_store().list_events("org-1", limit=10)
    assert any(event.action == "billing.subscription.updated_via_api" for event in audit_events)


def test_portal_requires_linked_stripe_customer():
    admin_token = make_token("admin-1", "org-1", ["Admin"])
    app.dependency_overrides[billing_router.get_stripe_client] = lambda: _FakeStripeClient()

    response = client.post(
        "/billing/portal",
        json={"return_url": "https://example.com/admin"},
        headers=_auth_header(admin_token),
    )
    assert response.status_code == 409
    assert "not linked" in response.json()["detail"].lower()


def test_portal_creates_session_for_linked_customer():
    admin_token = make_token("admin-1", "org-1", ["Admin"])
    app.dependency_overrides[billing_router.get_stripe_client] = lambda: _FakeStripeClient()

    billing_store = get_billing_store()
    billing_store.upsert_subscription(
        SeatSubscriptionRecord(
            org_id="org-1",
            stripe_customer_id="cus_existing",
            stripe_subscription_id="sub_existing",
            dispatcher_seat_limit=1,
            driver_seat_limit=1,
            created_at=billing_router._utc_now(),
            updated_at=billing_router._utc_now(),
        )
    )

    response = client.post(
        "/billing/portal",
        json={"return_url": "https://example.com/admin"},
        headers=_auth_header(admin_token),
    )
    assert response.status_code == 200
    body = response.json()
    assert body["portal_session_id"] == "bps_test_123"
    assert body["portal_url"].startswith("https://billing.stripe.test/")

    audit_events = get_audit_log_store().list_events("org-1", limit=10)
    assert any(event.action == "billing.portal.session_created" for event in audit_events)


def test_invitation_respects_dispatcher_seat_limit():
    admin_token = make_token("admin-1", "org-1", ["Admin"])
    set_limit = client.post(
        "/billing/seats",
        json={"dispatcher_seat_limit": 1, "driver_seat_limit": 0},
        headers=_auth_header(admin_token),
    )
    assert set_limit.status_code == 200

    first_invite = client.post(
        "/billing/invitations",
        json={"user_id": "dispatcher-1", "email": "d1@example.com", "role": "Dispatcher"},
        headers=_auth_header(admin_token),
    )
    assert first_invite.status_code == 200

    second_invite = client.post(
        "/billing/invitations",
        json={"user_id": "dispatcher-2", "email": "d2@example.com", "role": "Dispatcher"},
        headers=_auth_header(admin_token),
    )
    assert second_invite.status_code == 409
    assert "Dispatcher seat limit reached" in second_invite.json()["detail"]

    audit_events = get_audit_log_store().list_events("org-1", limit=10)
    actions = [event.action for event in audit_events]
    assert "billing.seats.updated" in actions
    assert "billing.invitation.created" in actions


def test_activation_rechecks_seat_limit():
    admin_token = make_token("admin-1", "org-1", ["Admin"])
    limit_response = client.post(
        "/billing/seats",
        json={"dispatcher_seat_limit": 0, "driver_seat_limit": 1},
        headers=_auth_header(admin_token),
    )
    assert limit_response.status_code == 200

    invite = client.post(
        "/billing/invitations",
        json={"user_id": "invited-driver", "email": "driver@example.com", "role": "Driver"},
        headers=_auth_header(admin_token),
    )
    assert invite.status_code == 200
    invitation_id = invite.json()["invitation_id"]

    # Fill the only active driver seat before activation to validate activation-time enforcement.
    active_driver_token = make_token("active-driver", "org-1", ["Driver"])
    sync = client.post("/users/me/sync", headers=_auth_header(active_driver_token))
    assert sync.status_code == 200

    activate = client.post(
        f"/billing/invitations/{invitation_id}/activate",
        headers=_auth_header(admin_token),
    )
    assert activate.status_code == 409
    assert "Driver seat limit reached for activation" in activate.json()["detail"]


def test_activation_writes_audit_event_on_success():
    admin_token = make_token("admin-1", "org-1", ["Admin"])
    set_limit = client.post(
        "/billing/seats",
        json={"dispatcher_seat_limit": 0, "driver_seat_limit": 1},
        headers=_auth_header(admin_token),
    )
    assert set_limit.status_code == 200

    invite = client.post(
        "/billing/invitations",
        json={"user_id": "driver-new", "email": "driver-new@example.com", "role": "Driver"},
        headers=_auth_header(admin_token),
    )
    assert invite.status_code == 200
    invitation_id = invite.json()["invitation_id"]

    activate = client.post(
        f"/billing/invitations/{invitation_id}/activate",
        headers=_auth_header(admin_token),
    )
    assert activate.status_code == 200

    audit_events = get_audit_log_store().list_events("org-1", limit=10)
    assert any(event.action == "billing.invitation.activated" for event in audit_events)


def test_activation_preserves_existing_user_profile():
    """Activating an invitation for a user who already exists must not wipe the
    profile fields (name/phone/photo/TSA) they saved via PUT /users/me."""
    admin_token = make_token("admin-1", "org-1", ["Admin"])
    set_limit = client.post(
        "/billing/seats",
        json={"dispatcher_seat_limit": 5, "driver_seat_limit": 5},
        headers=_auth_header(admin_token),
    )
    assert set_limit.status_code == 200

    # Existing driver who has already filled in their profile.
    driver_token = make_token("prof-user", "org-1", ["Driver"])
    assert client.post("/users/me/sync", headers=_auth_header(driver_token)).status_code == 200
    profile = client.put(
        "/users/me",
        json={
            "first_name": "Jane",
            "last_name": "Doe",
            "phone": "(555) 123-4567",
            "photo_url": "https://example.com/jane.jpg",
            "tsa_certified": True,
        },
        headers=_auth_header(driver_token),
    )
    assert profile.status_code == 200

    # Admin invites the same user to a dispatcher seat, then activates it.
    invite = client.post(
        "/billing/invitations",
        json={"user_id": "prof-user", "email": "prof-user@example.com", "role": "Dispatcher"},
        headers=_auth_header(admin_token),
    )
    assert invite.status_code == 200
    invitation_id = invite.json()["invitation_id"]

    activate = client.post(
        f"/billing/invitations/{invitation_id}/activate",
        headers=_auth_header(admin_token),
    )
    assert activate.status_code == 200

    activated_user = activate.json()
    assert activated_user["first_name"] == "Jane"
    assert activated_user["last_name"] == "Doe"
    assert activated_user["phone"] == "(555) 123-4567"
    assert activated_user["photo_url"] == "https://example.com/jane.jpg"
    assert activated_user["tsa_certified"] is True
    assert "Driver" in activated_user["roles"]
    assert "Dispatcher" in activated_user["roles"]


def test_admin_can_list_and_cancel_pending_invitations():
    admin_token = make_token("admin-1", "org-1", ["Admin"])
    limit_response = client.post(
        "/billing/seats",
        json={"dispatcher_seat_limit": 2, "driver_seat_limit": 2},
        headers=_auth_header(admin_token),
    )
    assert limit_response.status_code == 200

    invite = client.post(
        "/billing/invitations",
        json={"user_id": "dispatcher-1", "email": "dispatcher@example.com", "role": "Dispatcher"},
        headers=_auth_header(admin_token),
    )
    assert invite.status_code == 200
    invitation_id = invite.json()["invitation_id"]

    list_response = client.get("/billing/invitations?status=Pending", headers=_auth_header(admin_token))
    assert list_response.status_code == 200
    pending_ids = [item["invitation_id"] for item in list_response.json()]
    assert invitation_id in pending_ids

    cancel_response = client.post(
        f"/billing/invitations/{invitation_id}/cancel",
        headers=_auth_header(admin_token),
    )
    assert cancel_response.status_code == 200
    assert cancel_response.json()["status"] == "Cancelled"

    list_after_cancel = client.get("/billing/invitations?status=Pending", headers=_auth_header(admin_token))
    assert list_after_cancel.status_code == 200
    pending_after_cancel = [item["invitation_id"] for item in list_after_cancel.json()]
    assert invitation_id not in pending_after_cancel

    audit_events = get_audit_log_store().list_events("org-1", limit=20)
    assert any(event.action == "billing.invitation.cancelled" for event in audit_events)


def test_webhook_syncs_subscription_limits_from_stripe_event(monkeypatch):
    monkeypatch.setenv("ALLOW_UNSAFE_STRIPE_WEBHOOK_WITHOUT_SECRET", "true")
    monkeypatch.setenv("STRIPE_DISPATCHER_PRICE_ID", "price_dispatcher")
    monkeypatch.setenv("STRIPE_DRIVER_PRICE_ID", "price_driver")
    admin_token = make_token("admin-1", "org-1", ["Admin"])

    event_payload = {
        "id": "evt_123",
        "type": "customer.subscription.updated",
        "data": {
            "object": {
                "id": "sub_123",
                "customer": "cus_123",
                "status": "active",
                "metadata": {"org_id": "org-1", "plan_name": "Pro"},
                "items": {
                    "data": [
                        {"id": "si_dispatch", "quantity": 2, "price": {"id": "price_dispatcher"}},
                        {"id": "si_driver", "quantity": 4, "price": {"id": "price_driver"}},
                    ]
                },
            }
        },
    }

    webhook = client.post(
        "/webhooks/stripe",
        data=json.dumps(event_payload),
        headers={"Content-Type": "application/json"},
    )
    assert webhook.status_code == 200
    assert webhook.json()["org_id"] == "org-1"

    summary = client.get("/billing/summary", headers=_auth_header(admin_token))
    assert summary.status_code == 200
    body = summary.json()
    assert body["plan_name"] == "Pro"
    assert body["dispatcher_seats"]["total"] == 2
    assert body["driver_seats"]["total"] == 4
    assert body["stripe_subscription_id"] == "sub_123"

    audit_events = get_audit_log_store().list_events("org-1", limit=10)
    webhook_events = [event for event in audit_events if event.action == "billing.subscription.webhook_applied"]
    assert len(webhook_events) == 1
    assert webhook_events[0].details["event_type"] == "customer.subscription.updated"


def test_webhook_fails_closed_without_secret():
    webhook = client.post(
        "/webhooks/stripe",
        data=json.dumps({"id": "evt", "type": "customer.subscription.updated", "data": {"object": {}}}),
        headers={"Content-Type": "application/json"},
    )
    assert webhook.status_code == 503
    assert "not configured" in webhook.json()["detail"].lower()


def test_webhook_requires_signature_when_secret_configured(monkeypatch):
    monkeypatch.setenv("STRIPE_WEBHOOK_SECRET", "whsec_test")
    webhook = client.post(
        "/webhooks/stripe",
        data=json.dumps({"id": "evt", "type": "customer.subscription.updated", "data": {"object": {}}}),
        headers={"Content-Type": "application/json"},
    )
    assert webhook.status_code == 400
    assert "Stripe-Signature" in webhook.json()["detail"]


def test_email_first_invitation_creates_with_email_as_user_id():
    admin_token = make_token("admin-1", "org-1", ["Admin"])
    client.post(
        "/billing/seats",
        json={"dispatcher_seat_limit": 5, "driver_seat_limit": 5},
        headers=_auth_header(admin_token),
    )

    invite = client.post(
        "/billing/invitations",
        json={"email": "newuser@example.com", "role": "Dispatcher"},
        headers=_auth_header(admin_token),
    )
    assert invite.status_code == 200
    body = invite.json()
    assert body["user_id"] == "newuser@example.com"
    assert body["email"] == "newuser@example.com"
    assert body["role"] == "Dispatcher"
    assert body["status"] == "Pending"


def test_invitation_requires_email_or_user_id():
    admin_token = make_token("admin-1", "org-1", ["Admin"])
    invite = client.post(
        "/billing/invitations",
        json={"role": "Dispatcher"},
        headers=_auth_header(admin_token),
    )
    assert invite.status_code == 422


# --- RBAC: every billing endpoint is Admin-only ---

BILLING_ENDPOINTS = [
    ("GET", "/billing/summary", None),
    ("GET", "/billing/status", None),
    ("POST", "/billing/seats", {"dispatcher_seat_limit": 1, "driver_seat_limit": 1}),
    (
        "POST",
        "/billing/checkout",
        {
            "dispatcher_seat_limit": 1,
            "driver_seat_limit": 1,
            "success_url": "https://example.com/ok",
            "cancel_url": "https://example.com/cancel",
        },
    ),
    ("POST", "/billing/portal", {"return_url": "https://example.com/admin"}),
    ("POST", "/billing/invitations", {"email": "x@example.com", "role": "Driver"}),
    ("GET", "/billing/invitations", None),
    ("POST", "/billing/invitations/some-id/activate", None),
    ("POST", "/billing/invitations/some-id/cancel", None),
]


@pytest.mark.parametrize("role", ["Dispatcher", "Driver"])
@pytest.mark.parametrize("method,path,body", BILLING_ENDPOINTS)
def test_non_admin_roles_get_403_on_billing_endpoints(method, path, body, role):
    token = make_token(f"{role.lower()}-1", "org-1", [role])
    response = client.request(method, path, json=body, headers=_auth_header(token))
    assert response.status_code == 403, f"{role} {method} {path} -> {response.status_code}"
    assert "insufficient role" in response.json()["detail"].lower()


@pytest.mark.parametrize("method,path,body", BILLING_ENDPOINTS)
def test_unauthenticated_requests_get_401_on_billing_endpoints(method, path, body):
    response = client.request(method, path, json=body)
    assert response.status_code == 401, f"anon {method} {path} -> {response.status_code}"


# --- Webhook idempotency and ordering ---

def _subscription_event(event_id, created, *, quantity_dispatcher, quantity_driver, event_type="customer.subscription.updated"):
    return {
        "id": event_id,
        "type": event_type,
        "created": created,
        "data": {
            "object": {
                "id": "sub_123",
                "customer": "cus_123",
                "status": "active",
                "metadata": {"org_id": "org-1", "plan_name": "Pro"},
                "items": {
                    "data": [
                        {"id": "si_dispatch", "quantity": quantity_dispatcher, "price": {"id": "price_dispatcher"}},
                        {"id": "si_driver", "quantity": quantity_driver, "price": {"id": "price_driver"}},
                    ]
                },
            }
        },
    }


def _post_unsigned_webhook(event):
    return client.post(
        "/webhooks/stripe",
        data=json.dumps(event),
        headers={"Content-Type": "application/json"},
    )


def test_webhook_duplicate_event_is_ignored(monkeypatch):
    monkeypatch.setenv("ALLOW_UNSAFE_STRIPE_WEBHOOK_WITHOUT_SECRET", "true")
    monkeypatch.setenv("STRIPE_DISPATCHER_PRICE_ID", "price_dispatcher")
    monkeypatch.setenv("STRIPE_DRIVER_PRICE_ID", "price_driver")
    admin_token = make_token("admin-1", "org-1", ["Admin"])

    event = _subscription_event("evt_dup", 1_700_000_000, quantity_dispatcher=2, quantity_driver=4)
    first = _post_unsigned_webhook(event)
    assert first.status_code == 200
    assert first.json()["org_id"] == "org-1"

    replay = _post_unsigned_webhook(event)
    assert replay.status_code == 200
    assert replay.json()["org_id"] is None  # duplicate delivery applied nothing

    summary = client.get("/billing/summary", headers=_auth_header(admin_token)).json()
    assert summary["dispatcher_seats"]["total"] == 2
    assert summary["driver_seats"]["total"] == 4

    audit_events = get_audit_log_store().list_events("org-1", limit=20)
    applied = [event for event in audit_events if event.action == "billing.subscription.webhook_applied"]
    assert len(applied) == 1


def test_webhook_stale_out_of_order_event_does_not_overwrite_newer_state(monkeypatch):
    monkeypatch.setenv("ALLOW_UNSAFE_STRIPE_WEBHOOK_WITHOUT_SECRET", "true")
    monkeypatch.setenv("STRIPE_DISPATCHER_PRICE_ID", "price_dispatcher")
    monkeypatch.setenv("STRIPE_DRIVER_PRICE_ID", "price_driver")
    admin_token = make_token("admin-1", "org-1", ["Admin"])

    newer = _subscription_event("evt_new", 1_700_000_100, quantity_dispatcher=5, quantity_driver=10)
    assert _post_unsigned_webhook(newer).status_code == 200

    stale = _subscription_event("evt_old", 1_700_000_000, quantity_dispatcher=1, quantity_driver=1)
    response = _post_unsigned_webhook(stale)
    assert response.status_code == 200
    assert response.json()["org_id"] is None  # stale event dropped

    summary = client.get("/billing/summary", headers=_auth_header(admin_token)).json()
    assert summary["dispatcher_seats"]["total"] == 5
    assert summary["driver_seats"]["total"] == 10


def test_manual_seat_update_preserves_webhook_dedup_state(monkeypatch):
    monkeypatch.setenv("ALLOW_UNSAFE_STRIPE_WEBHOOK_WITHOUT_SECRET", "true")
    monkeypatch.setenv("STRIPE_DISPATCHER_PRICE_ID", "price_dispatcher")
    monkeypatch.setenv("STRIPE_DRIVER_PRICE_ID", "price_driver")
    admin_token = make_token("admin-1", "org-1", ["Admin"])

    event = _subscription_event("evt_1", 1_700_000_100, quantity_dispatcher=5, quantity_driver=10)
    assert _post_unsigned_webhook(event).status_code == 200

    seats = client.post(
        "/billing/seats",
        json={"dispatcher_seat_limit": 6, "driver_seat_limit": 10},
        headers=_auth_header(admin_token),
    )
    assert seats.status_code == 200

    # A replay of the already-applied event must still be dropped after the
    # manual update rebuilt the subscription record.
    replay = _post_unsigned_webhook(event)
    assert replay.status_code == 200
    assert replay.json()["org_id"] is None

    summary = client.get("/billing/summary", headers=_auth_header(admin_token)).json()
    assert summary["dispatcher_seats"]["total"] == 6


# --- Webhook signature verification (real stripe library) ---

def _stripe_signature_header(payload: str, secret: str, timestamp=None) -> str:
    ts = int(timestamp if timestamp is not None else time.time())
    signed = f"{ts}.{payload}"
    digest = hmac.new(secret.encode("utf-8"), signed.encode("utf-8"), hashlib.sha256).hexdigest()
    return f"t={ts},v1={digest}"


def test_webhook_accepts_correctly_signed_event(monkeypatch):
    secret = "whsec_test_secret"
    monkeypatch.setenv("STRIPE_WEBHOOK_SECRET", secret)
    monkeypatch.setenv("STRIPE_DISPATCHER_PRICE_ID", "price_dispatcher")
    monkeypatch.setenv("STRIPE_DRIVER_PRICE_ID", "price_driver")
    admin_token = make_token("admin-1", "org-1", ["Admin"])

    payload = json.dumps(_subscription_event("evt_signed", 1_700_000_000, quantity_dispatcher=3, quantity_driver=7))
    response = client.post(
        "/webhooks/stripe",
        data=payload,
        headers={
            "Content-Type": "application/json",
            "Stripe-Signature": _stripe_signature_header(payload, secret),
        },
    )
    assert response.status_code == 200
    assert response.json()["org_id"] == "org-1"

    summary = client.get("/billing/summary", headers=_auth_header(admin_token)).json()
    assert summary["dispatcher_seats"]["total"] == 3
    assert summary["driver_seats"]["total"] == 7


def test_webhook_rejects_bad_signature(monkeypatch):
    monkeypatch.setenv("STRIPE_WEBHOOK_SECRET", "whsec_test_secret")
    payload = json.dumps(_subscription_event("evt_forged", 1_700_000_000, quantity_dispatcher=99, quantity_driver=99))

    response = client.post(
        "/webhooks/stripe",
        data=payload,
        headers={
            "Content-Type": "application/json",
            "Stripe-Signature": _stripe_signature_header(payload, "whsec_wrong_secret"),
        },
    )
    assert response.status_code == 400


def test_webhook_rejects_expired_signature_timestamp(monkeypatch):
    secret = "whsec_test_secret"
    monkeypatch.setenv("STRIPE_WEBHOOK_SECRET", secret)
    payload = json.dumps(_subscription_event("evt_replayed", 1_700_000_000, quantity_dispatcher=2, quantity_driver=2))

    stale_ts = int(time.time()) - 3600  # far outside Stripe's default 300s tolerance
    response = client.post(
        "/webhooks/stripe",
        data=payload,
        headers={
            "Content-Type": "application/json",
            "Stripe-Signature": _stripe_signature_header(payload, secret, timestamp=stale_ts),
        },
    )
    assert response.status_code == 400


# --- StripeSdkClient must return plain dicts (stripe-python v15 returns
# StripeObject, which is NOT a dict and broke checkout/portal/webhooks in
# every environment with real Stripe configured) ---

def test_stripe_sdk_client_returns_plain_dicts(monkeypatch):
    import stripe
    from stripe._stripe_object import StripeObject

    from backend.billing_service import StripeSdkClient

    def fake_session_create(**params):
        return StripeObject.construct_from(
            {"id": "cs_live_shape", "object": "checkout.session", "url": "https://checkout.stripe.com/c/pay/x"},
            None,
        )

    def fake_portal_create(**params):
        return StripeObject.construct_from(
            {"id": "bps_live_shape", "object": "billing_portal.session", "url": "https://billing.stripe.com/p/session/x"},
            None,
        )

    def fake_sub_retrieve(subscription_id, **params):
        return StripeObject.construct_from(
            {
                "id": subscription_id,
                "object": "subscription",
                "status": "active",
                "customer": "cus_x",
                "metadata": {},
                "items": {"data": []},
            },
            None,
        )

    monkeypatch.setattr(stripe.checkout.Session, "create", staticmethod(fake_session_create))
    monkeypatch.setattr(stripe.billing_portal.Session, "create", staticmethod(fake_portal_create))
    monkeypatch.setattr(stripe.Subscription, "retrieve", staticmethod(fake_sub_retrieve))

    sdk = StripeSdkClient(
        api_key="sk_test_x",
        webhook_secret="",
        dispatcher_price_id="price_d",
        driver_price_id="price_v",
    )

    session = sdk.create_checkout_session(
        org_id="org-1",
        dispatcher_seat_limit=1,
        driver_seat_limit=1,
        success_url="https://example.com/ok",
        cancel_url="https://example.com/cancel",
    )
    assert type(session) is dict
    assert session.get("url") == "https://checkout.stripe.com/c/pay/x"

    portal = sdk.create_billing_portal_session(customer_id="cus_x", return_url="https://example.com")
    assert type(portal) is dict
    assert portal.get("url") == "https://billing.stripe.com/p/session/x"

    # no price ids configured -> no updates -> returns the retrieved subscription
    sdk_no_prices = StripeSdkClient(
        api_key="sk_test_x",
        webhook_secret="",
        dispatcher_price_id="",
        driver_price_id="",
    )
    subscription = sdk_no_prices.update_subscription_quantities(
        subscription_id="sub_x",
        dispatcher_seat_limit=1,
        driver_seat_limit=1,
    )
    assert type(subscription) is dict
    assert subscription.get("status") == "active"


# --- Seat over-allocation guards ---

def test_seat_limit_cannot_be_lowered_below_active_plus_pending():
    admin_token = make_token("admin-1", "org-1", ["Admin"])
    assert (
        client.post(
            "/billing/seats",
            json={"dispatcher_seat_limit": 2, "driver_seat_limit": 2},
            headers=_auth_header(admin_token),
        ).status_code
        == 200
    )

    invite = client.post(
        "/billing/invitations",
        json={"email": "d1@example.com", "role": "Driver"},
        headers=_auth_header(admin_token),
    )
    assert invite.status_code == 200

    lowered = client.post(
        "/billing/seats",
        json={"driver_seat_limit": 0},
        headers=_auth_header(admin_token),
    )
    assert lowered.status_code == 400
    assert "cannot be lower" in lowered.json()["detail"].lower()
