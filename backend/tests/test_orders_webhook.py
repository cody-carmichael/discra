import base64
import json
import os
import sys

import pytest
from fastapi.testclient import TestClient

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "../..")))

from backend.app import app
from backend.routers.orders import _orders

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
):
    return {
        "org_id": org_id,
        "source": "shopify",
        "orders": [
            {
                "external_order_id": external_order_id,
                "customer_name": customer_name,
                "reference_number": reference_number,
                "pick_up_address": pick_up_address,
                "delivery": delivery,
                "dimensions": "12x8x6 in",
                "weight": 6.4,
                "num_packages": 1,
            }
        ],
    }


@pytest.fixture(autouse=True)
def _test_env(monkeypatch):
    monkeypatch.setenv("JWT_VERIFY_SIGNATURE", "false")
    monkeypatch.setenv("USE_IN_MEMORY_IDENTITY_STORE", "true")
    monkeypatch.setenv("ORDERS_WEBHOOK_TOKEN", "orders-secret")
    _orders.clear()


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
    assert org2.status_code == 200
    assert org1.json()["created"] == 1
    assert org2.json()["created"] == 1

    admin_org1 = make_token("admin-1", "org-1", ["Admin"])
    admin_org2 = make_token("admin-2", "org-2", ["Admin"])
    list_org1 = client.get("/orders/", headers={"Authorization": f"Bearer {admin_org1}"})
    list_org2 = client.get("/orders/", headers={"Authorization": f"Bearer {admin_org2}"})
    assert len(list_org1.json()) == 1
    assert len(list_org2.json()) == 1
    assert list_org1.json()[0]["customer_name"] == "Alice"
    assert list_org2.json()[0]["customer_name"] == "Bob"
