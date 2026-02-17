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


@pytest.fixture(autouse=True)
def _test_env(monkeypatch):
    monkeypatch.setenv("JWT_VERIFY_SIGNATURE", "false")
    monkeypatch.setenv("USE_IN_MEMORY_IDENTITY_STORE", "true")
    _orders.clear()


def test_create_and_list_order_for_tenant():
    admin_token = make_token("admin-a", "org-a", ["Admin"])
    payload = {
        "customer_name": "Alice",
        "address": "123 Main St",
        "phone": "555-1234",
        "email": "alice@example.com",
        "notes": "Leave at door",
        "num_packages": 1,
    }

    create_response = client.post("/orders/", json=payload, headers={"Authorization": f"Bearer {admin_token}"})
    assert create_response.status_code == 200
    created = create_response.json()
    assert created["customer_name"] == "Alice"
    assert created["org_id"] == "org-a"

    list_response = client.get("/orders/", headers={"Authorization": f"Bearer {admin_token}"})
    assert list_response.status_code == 200
    listed = list_response.json()
    assert len(listed) == 1
    assert listed[0]["id"] == created["id"]


def test_cross_tenant_order_access_is_hidden():
    org_a_admin = make_token("admin-a", "org-a", ["Admin"])
    org_b_admin = make_token("admin-b", "org-b", ["Admin"])

    create_response = client.post(
        "/orders/",
        json={
            "customer_name": "Bob",
            "address": "456 Broadway",
            "num_packages": 2,
        },
        headers={"Authorization": f"Bearer {org_a_admin}"},
    )
    order_id = create_response.json()["id"]

    forbidden_get = client.get(f"/orders/{order_id}", headers={"Authorization": f"Bearer {org_b_admin}"})
    assert forbidden_get.status_code == 404

    org_b_list = client.get("/orders/", headers={"Authorization": f"Bearer {org_b_admin}"})
    assert org_b_list.status_code == 200
    assert org_b_list.json() == []


def test_assign_and_unassign_order():
    admin_token = make_token("admin-a", "org-a", ["Admin"])

    create_response = client.post(
        "/orders/",
        json={"customer_name": "Carol", "address": "789 Market St", "num_packages": 1},
        headers={"Authorization": f"Bearer {admin_token}"},
    )
    order_id = create_response.json()["id"]

    assign_response = client.post(
        f"/orders/{order_id}/assign",
        json={"driver_id": "driver-1"},
        headers={"Authorization": f"Bearer {admin_token}"},
    )
    assert assign_response.status_code == 200
    assert assign_response.json()["status"] == "Assigned"
    assert assign_response.json()["assigned_to"] == "driver-1"

    unassign_response = client.post(
        f"/orders/{order_id}/unassign",
        headers={"Authorization": f"Bearer {admin_token}"},
    )
    assert unassign_response.status_code == 200
    assert unassign_response.json()["status"] == "Created"
    assert unassign_response.json()["assigned_to"] is None


def test_driver_inbox_and_status_update():
    admin_token = make_token("admin-a", "org-a", ["Admin"])
    driver_token = make_token("driver-1", "org-a", ["Driver"])
    other_driver_token = make_token("driver-2", "org-a", ["Driver"])

    create_response = client.post(
        "/orders/",
        json={"customer_name": "Dave", "address": "100 1st Ave", "num_packages": 1},
        headers={"Authorization": f"Bearer {admin_token}"},
    )
    order_id = create_response.json()["id"]

    client.post(
        f"/orders/{order_id}/assign",
        json={"driver_id": "driver-1"},
        headers={"Authorization": f"Bearer {admin_token}"},
    )

    inbox_response = client.get("/orders/driver/inbox", headers={"Authorization": f"Bearer {driver_token}"})
    assert inbox_response.status_code == 200
    assert len(inbox_response.json()) == 1
    assert inbox_response.json()[0]["id"] == order_id

    pickup_response = client.post(
        f"/orders/{order_id}/status",
        json={"status": "PickedUp"},
        headers={"Authorization": f"Bearer {driver_token}"},
    )
    assert pickup_response.status_code == 200
    assert pickup_response.json()["status"] == "PickedUp"

    forbidden_update = client.post(
        f"/orders/{order_id}/status",
        json={"status": "EnRoute"},
        headers={"Authorization": f"Bearer {other_driver_token}"},
    )
    assert forbidden_update.status_code == 403


def test_invalid_status_transition_is_rejected():
    dispatcher_token = make_token("dispatcher-a", "org-a", ["Dispatcher"])
    create_response = client.post(
        "/orders/",
        json={"customer_name": "Eve", "address": "11 2nd St", "num_packages": 1},
        headers={"Authorization": f"Bearer {dispatcher_token}"},
    )
    order_id = create_response.json()["id"]

    invalid = client.post(
        f"/orders/{order_id}/status",
        json={"status": "Delivered"},
        headers={"Authorization": f"Bearer {dispatcher_token}"},
    )
    assert invalid.status_code == 400
