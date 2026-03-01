import base64
import hmac
import json
import os
import sys
import time
from typing import Optional

import pytest
from fastapi.testclient import TestClient

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "../..")))

from backend.app import app
from backend.order_store import reset_in_memory_order_store

client = TestClient(app)


def make_token(sub: str, org_id: str, groups):
    payload = {
        "sub": sub,
        "custom:org_id": org_id,
        "cognito:groups": groups,
    }
    header = base64.urlsafe_b64encode(json.dumps({"alg": "none"}).encode()).rstrip(b"=")
    body = base64.urlsafe_b64encode(json.dumps(payload).encode()).rstrip(b"=")
    return f"{header.decode()}.{body.decode()}."


def _webhook_payload(
    org_id: str,
    external_order_id: str,
    customer_name: str,
    pick_up_address: str,
    delivery: str,
    reference_number: int,
    time_window_start: Optional[str] = None,
    time_window_end: Optional[str] = None,
):
    order_payload = {
        "external_order_id": external_order_id,
        "customer_name": customer_name,
        "reference_number": reference_number,
        "pick_up_address": pick_up_address,
        "delivery": delivery,
        "dimensions": "12x8x6 in",
        "weight": 6.4,
        "num_packages": 1,
    }
    if time_window_start:
        order_payload["time_window_start"] = time_window_start
    if time_window_end:
        order_payload["time_window_end"] = time_window_end

    return {
        "org_id": org_id,
        "source": "shopify",
        "orders": [order_payload],
    }


def _signed_orders_webhook_headers(
    payload,
    secret: str,
    timestamp: Optional[int] = None,
    with_prefix: bool = False,
):
    ts_value = timestamp if timestamp is not None else int(time.time())
    raw_payload = json.dumps(payload, separators=(",", ":")).encode("utf-8")
    signature = hmac.new(
        secret.encode("utf-8"),
        f"{ts_value}.".encode("utf-8") + raw_payload,
        digestmod="sha256",
    ).hexdigest()
    signature_value = f"sha256={signature}" if with_prefix else signature
    return (
        {
            "content-type": "application/json",
            "x-orders-webhook-token": "orders-secret",
            "x-orders-webhook-timestamp": str(ts_value),
            "x-orders-webhook-signature": signature_value,
        },
        raw_payload,
    )


@pytest.fixture(autouse=True)
def _test_env(monkeypatch):
    monkeypatch.setenv("JWT_VERIFY_SIGNATURE", "false")
    monkeypatch.setenv("USE_IN_MEMORY_IDENTITY_STORE", "true")
    monkeypatch.setenv("USE_IN_MEMORY_ORDER_STORE", "true")
    monkeypatch.setenv("ORDERS_WEBHOOK_TOKEN", "orders-secret")
    monkeypatch.setenv("ORDERS_WEBHOOK_ALLOWED_ORG_ID", "org-1")
    reset_in_memory_order_store()


def test_orders_webhook_rejects_missing_or_bad_token():
    payload = _webhook_payload("org-1", "ext-1", "Alice", "Warehouse A", "100 Main", 101)

    missing = client.post("/webhooks/orders", json=payload)
    assert missing.status_code == 401

    bad = client.post(
        "/webhooks/orders",
        json=payload,
        headers={"x-orders-webhook-token": "bad-token"},
    )
    assert bad.status_code == 401


def test_orders_webhook_requires_allowed_org_binding_configuration(monkeypatch):
    monkeypatch.delenv("ORDERS_WEBHOOK_ALLOWED_ORG_ID", raising=False)
    payload = _webhook_payload("org-1", "ext-1", "Alice", "Warehouse A", "100 Main", 101)
    response = client.post(
        "/webhooks/orders",
        json=payload,
        headers={"x-orders-webhook-token": "orders-secret"},
    )
    assert response.status_code == 503
    assert "org binding" in response.json()["detail"].lower()


def test_orders_webhook_rejects_mismatched_org():
    payload = _webhook_payload("org-2", "ext-1", "Alice", "Warehouse A", "100 Main", 102)
    response = client.post(
        "/webhooks/orders",
        json=payload,
        headers={"x-orders-webhook-token": "orders-secret"},
    )
    assert response.status_code == 403
    assert "not allowed" in response.json()["detail"].lower()


def test_orders_webhook_requires_signature_headers_when_hmac_secret_configured(monkeypatch):
    monkeypatch.setenv("ORDERS_WEBHOOK_HMAC_SECRET", "hmac-secret")
    payload = _webhook_payload("org-1", "ext-1", "Alice", "Warehouse A", "100 Main", 111)
    response = client.post(
        "/webhooks/orders",
        json=payload,
        headers={"x-orders-webhook-token": "orders-secret"},
    )
    assert response.status_code == 401
    assert "signature" in response.json()["detail"].lower()


def test_orders_webhook_rejects_invalid_hmac_signature(monkeypatch):
    monkeypatch.setenv("ORDERS_WEBHOOK_HMAC_SECRET", "hmac-secret")
    payload = _webhook_payload("org-1", "ext-1", "Alice", "Warehouse A", "100 Main", 112)
    headers, raw_payload = _signed_orders_webhook_headers(payload, secret="wrong-secret")
    response = client.post("/webhooks/orders", content=raw_payload, headers=headers)
    assert response.status_code == 401
    assert "signature" in response.json()["detail"].lower()


def test_orders_webhook_rejects_stale_hmac_timestamp(monkeypatch):
    monkeypatch.setenv("ORDERS_WEBHOOK_HMAC_SECRET", "hmac-secret")
    monkeypatch.setenv("ORDERS_WEBHOOK_MAX_SKEW_SECONDS", "10")
    payload = _webhook_payload("org-1", "ext-1", "Alice", "Warehouse A", "100 Main", 113)
    stale_timestamp = int(time.time()) - 120
    headers, raw_payload = _signed_orders_webhook_headers(
        payload,
        secret="hmac-secret",
        timestamp=stale_timestamp,
    )
    response = client.post("/webhooks/orders", content=raw_payload, headers=headers)
    assert response.status_code == 401
    assert "timestamp" in response.json()["detail"].lower()


def test_orders_webhook_accepts_valid_hmac_signature(monkeypatch):
    monkeypatch.setenv("ORDERS_WEBHOOK_HMAC_SECRET", "hmac-secret")
    payload = _webhook_payload("org-1", "ext-1", "Alice", "Warehouse A", "100 Main", 114)
    headers, raw_payload = _signed_orders_webhook_headers(
        payload,
        secret="hmac-secret",
        with_prefix=True,
    )
    webhook = client.post("/webhooks/orders", content=raw_payload, headers=headers)
    assert webhook.status_code == 200
    assert webhook.json()["created"] == 1


def test_orders_webhook_creates_orders_visible_to_dispatchers():
    payload = {
        "org_id": "org-1",
        "source": "shopify",
        "orders": [
            {
                "external_order_id": "ext-1",
                "customer_name": "Alice",
                "reference_number": 201,
                "pick_up_address": "Warehouse A",
                "delivery": "100 Main",
                "dimensions": "12x8x6 in",
                "weight": 6.4,
                "num_packages": 2,
            },
            {
                "external_order_id": "ext-2",
                "customer_name": "Bob",
                "reference_number": 202,
                "pick_up_address": "Warehouse B",
                "delivery": "200 Main",
                "dimensions": "10x8x5 in",
                "weight": 4.2,
                "num_packages": 1,
            },
        ],
    }
    webhook = client.post(
        "/webhooks/orders",
        json=payload,
        headers={"x-orders-webhook-token": "orders-secret"},
    )
    assert webhook.status_code == 200
    body = webhook.json()
    assert body["accepted"] == 2
    assert body["created"] == 2
    assert body["updated"] == 0

    dispatcher_token = make_token("disp-1", "org-1", ["Dispatcher"])
    list_response = client.get(
        "/orders/",
        headers={"Authorization": f"Bearer {dispatcher_token}"},
    )
    assert list_response.status_code == 200
    orders = list_response.json()
    assert len(orders) == 2
    assert {item["external_order_id"] for item in orders} == {"ext-1", "ext-2"}
    assert all(item["source"] == "shopify" for item in orders)


def test_orders_webhook_persists_time_window_fields():
    payload = _webhook_payload(
        "org-1",
        "ext-time-window",
        "Alice",
        "Warehouse A",
        "100 Main",
        221,
        time_window_start="2026-03-02T10:00:00Z",
        time_window_end="2026-03-02T12:30:00Z",
    )
    webhook = client.post(
        "/webhooks/orders",
        json=payload,
        headers={"x-orders-webhook-token": "orders-secret"},
    )
    assert webhook.status_code == 200

    dispatcher_token = make_token("disp-1", "org-1", ["Dispatcher"])
    list_response = client.get(
        "/orders/",
        headers={"Authorization": f"Bearer {dispatcher_token}"},
    )
    assert list_response.status_code == 200
    order = next((item for item in list_response.json() if item["external_order_id"] == "ext-time-window"), None)
    assert order is not None
    assert order["time_window_start"] == "2026-03-02T10:00:00Z"
    assert order["time_window_end"] == "2026-03-02T12:30:00Z"


def test_orders_webhook_rejects_invalid_time_window():
    payload = _webhook_payload(
        "org-1",
        "ext-bad-window",
        "Alice",
        "Warehouse A",
        "100 Main",
        222,
        time_window_start="2026-03-02T13:00:00Z",
        time_window_end="2026-03-02T12:30:00Z",
    )
    webhook = client.post(
        "/webhooks/orders",
        json=payload,
        headers={"x-orders-webhook-token": "orders-secret"},
    )
    assert webhook.status_code == 422


def test_orders_webhook_rejects_duplicate_external_ids_in_single_payload():
    payload = {
        "org_id": "org-1",
        "source": "shopify",
        "orders": [
            {
                "external_order_id": "ext-1",
                "customer_name": "Alice",
                "reference_number": 251,
                "pick_up_address": "Warehouse A",
                "delivery": "100 Main",
                "dimensions": "12x8x6 in",
                "weight": 6.4,
                "num_packages": 1,
            },
            {
                "external_order_id": "ext-1",
                "customer_name": "Bob",
                "reference_number": 252,
                "pick_up_address": "Warehouse B",
                "delivery": "200 Main",
                "dimensions": "10x8x5 in",
                "weight": 4.2,
                "num_packages": 1,
            },
        ],
    }
    webhook = client.post(
        "/webhooks/orders",
        json=payload,
        headers={"x-orders-webhook-token": "orders-secret"},
    )
    assert webhook.status_code == 400
    assert "duplicate external_order_id" in webhook.json()["detail"].lower()


def test_orders_webhook_upserts_by_external_id_and_preserves_assignment():
    initial = client.post(
        "/webhooks/orders",
        json=_webhook_payload("org-1", "ext-1", "Alice", "Warehouse A", "100 Main", 301),
        headers={"x-orders-webhook-token": "orders-secret"},
    )
    assert initial.status_code == 200
    order_id = initial.json()["order_ids"][0]

    admin_token = make_token("admin-1", "org-1", ["Admin"])
    assign = client.post(
        f"/orders/{order_id}/assign",
        json={"driver_id": "driver-1"},
        headers={"Authorization": f"Bearer {admin_token}"},
    )
    assert assign.status_code == 200

    update = client.post(
        "/webhooks/orders",
        json=_webhook_payload("org-1", "ext-1", "Alice Updated", "Warehouse Z", "999 Main", 301),
        headers={"x-orders-webhook-token": "orders-secret"},
    )
    assert update.status_code == 200
    assert update.json()["created"] == 0
    assert update.json()["updated"] == 1
    assert update.json()["order_ids"] == [order_id]

    order = client.get(
        f"/orders/{order_id}",
        headers={"Authorization": f"Bearer {admin_token}"},
    )
    assert order.status_code == 200
    body = order.json()
    assert body["customer_name"] == "Alice Updated"
    assert body["delivery"] == "999 Main"
    assert body["pick_up_address"] == "Warehouse Z"
    assert body["status"] == "Assigned"
    assert body["assigned_to"] == "driver-1"


def test_orders_webhook_supports_same_external_id_across_orgs():
    org1 = client.post(
        "/webhooks/orders",
        json=_webhook_payload("org-1", "ext-1", "Alice", "Warehouse A", "100 Main", 401),
        headers={"x-orders-webhook-token": "orders-secret"},
    )
    org2 = client.post(
        "/webhooks/orders",
        json=_webhook_payload("org-2", "ext-1", "Bob", "Warehouse B", "200 Main", 501),
        headers={"x-orders-webhook-token": "orders-secret"},
    )
    assert org1.status_code == 200
    assert org2.status_code == 403
