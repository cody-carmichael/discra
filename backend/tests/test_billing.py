import base64
import json
import os
import sys

import pytest
from fastapi.testclient import TestClient

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "../..")))

from backend.app import app
from backend.billing_service import reset_in_memory_billing_store
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
    monkeypatch.delenv("STRIPE_WEBHOOK_SECRET", raising=False)
    monkeypatch.delenv("STRIPE_SECRET_KEY", raising=False)
    monkeypatch.delenv("STRIPE_DISPATCHER_PRICE_ID", raising=False)
    monkeypatch.delenv("STRIPE_DRIVER_PRICE_ID", raising=False)
    reset_in_memory_billing_store()
    _IN_MEMORY_REPO._orgs.clear()
    _IN_MEMORY_REPO._users.clear()


def _auth_header(token: str):
    return {"Authorization": f"Bearer {token}"}


def test_admin_can_read_default_billing_summary():
    admin_token = make_token("admin-1", "org-1", ["Admin"])

    response = client.get("/billing/summary", headers=_auth_header(admin_token))
    assert response.status_code == 200
    body = response.json()
    assert body["dispatcher_seats"]["total"] == 0
    assert body["driver_seats"]["total"] == 0
    assert body["dispatcher_seats"]["available"] == 0
    assert body["driver_seats"]["available"] == 0


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


def test_webhook_syncs_subscription_limits_from_stripe_event(monkeypatch):
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


def test_webhook_requires_signature_when_secret_configured(monkeypatch):
    monkeypatch.setenv("STRIPE_WEBHOOK_SECRET", "whsec_test")
    webhook = client.post(
        "/webhooks/stripe",
        data=json.dumps({"id": "evt", "type": "customer.subscription.updated", "data": {"object": {}}}),
        headers={"Content-Type": "application/json"},
    )
    assert webhook.status_code == 400
    assert "Stripe-Signature" in webhook.json()["detail"]
