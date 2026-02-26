import base64
import json
import os
import sys
from typing import Optional

import pytest
from fastapi.testclient import TestClient

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "../..")))

from backend.app import app
from backend.audit_store import get_audit_log_store, reset_in_memory_audit_log_store
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


def make_order_payload(
    customer_name: str,
    pick_up_address: str,
    delivery: str,
    reference_number: int = 1001,
    time_window_start: Optional[str] = None,
    time_window_end: Optional[str] = None,
):
    payload = {
        "customer_name": customer_name,
        "reference_number": reference_number,
        "pick_up_address": pick_up_address,
        "delivery": delivery,
        "dimensions": "10x8x4 in",
        "weight": 4.5,
        "num_packages": 1,
    }
    if time_window_start:
        payload["time_window_start"] = time_window_start
    if time_window_end:
        payload["time_window_end"] = time_window_end
    return payload


@pytest.fixture(autouse=True)
def _test_env(monkeypatch):
    monkeypatch.setenv("JWT_VERIFY_SIGNATURE", "false")
    monkeypatch.setenv("USE_IN_MEMORY_IDENTITY_STORE", "true")
    monkeypatch.setenv("USE_IN_MEMORY_ORDER_STORE", "true")
    monkeypatch.setenv("USE_IN_MEMORY_AUDIT_LOG_STORE", "true")
    reset_in_memory_order_store()
    reset_in_memory_audit_log_store()


def test_create_and_list_order_for_tenant():
    admin_token = make_token("admin-a", "org-a", ["Admin"])
    payload = make_order_payload("Alice", "Warehouse 1", "123 Main St")
    payload["phone"] = "555-1234"
    payload["email"] = "alice@example.com"
    payload["notes"] = "Leave at door"

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


def test_create_order_with_time_window():
    admin_token = make_token("admin-a", "org-a", ["Admin"])
    payload = make_order_payload(
        "Alice",
        "Warehouse 1",
        "123 Main St",
        time_window_start="2026-03-01T09:00:00Z",
        time_window_end="2026-03-01T11:00:00Z",
    )
    created = client.post("/orders/", json=payload, headers={"Authorization": f"Bearer {admin_token}"})
    assert created.status_code == 200
    body = created.json()
    assert body["time_window_start"] == "2026-03-01T09:00:00Z"
    assert body["time_window_end"] == "2026-03-01T11:00:00Z"


def test_create_order_rejects_invalid_time_window():
    admin_token = make_token("admin-a", "org-a", ["Admin"])
    payload = make_order_payload(
        "Alice",
        "Warehouse 1",
        "123 Main St",
        time_window_start="2026-03-01T12:00:00Z",
        time_window_end="2026-03-01T11:00:00Z",
    )
    created = client.post("/orders/", json=payload, headers={"Authorization": f"Bearer {admin_token}"})
    assert created.status_code == 422


def test_cross_tenant_order_access_is_hidden():
    org_a_admin = make_token("admin-a", "org-a", ["Admin"])
    org_b_admin = make_token("admin-b", "org-b", ["Admin"])

    create_response = client.post(
        "/orders/",
        json=make_order_payload("Bob", "Warehouse 2", "456 Broadway", reference_number=2002) | {"num_packages": 2},
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
        json=make_order_payload("Carol", "Warehouse 3", "789 Market St", reference_number=3003),
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

    audit_events = get_audit_log_store().list_events("org-a", limit=10)
    actions = [event.action for event in audit_events]
    assert "order.assigned" in actions
    assert "order.unassigned" in actions


def test_driver_inbox_and_status_update():
    admin_token = make_token("admin-a", "org-a", ["Admin"])
    driver_token = make_token("driver-1", "org-a", ["Driver"])
    other_driver_token = make_token("driver-2", "org-a", ["Driver"])

    create_response = client.post(
        "/orders/",
        json=make_order_payload("Dave", "Warehouse 4", "100 1st Ave", reference_number=4004),
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
        json=make_order_payload("Eve", "Warehouse 5", "11 2nd St", reference_number=5005),
        headers={"Authorization": f"Bearer {dispatcher_token}"},
    )
    order_id = create_response.json()["id"]

    invalid = client.post(
        f"/orders/{order_id}/status",
        json={"status": "Delivered"},
        headers={"Authorization": f"Bearer {dispatcher_token}"},
    )
    assert invalid.status_code == 400


def test_reassign_writes_order_reassigned_audit_event():
    admin_token = make_token("admin-a", "org-a", ["Admin"])
    created = client.post(
        "/orders/",
        json=make_order_payload("Frank", "Warehouse 6", "1010 Center St", reference_number=6006),
        headers={"Authorization": f"Bearer {admin_token}"},
    )
    order_id = created.json()["id"]

    first_assign = client.post(
        f"/orders/{order_id}/assign",
        json={"driver_id": "driver-1"},
        headers={"Authorization": f"Bearer {admin_token}"},
    )
    assert first_assign.status_code == 200

    second_assign = client.post(
        f"/orders/{order_id}/assign",
        json={"driver_id": "driver-2"},
        headers={"Authorization": f"Bearer {admin_token}"},
    )
    assert second_assign.status_code == 200

    audit_events = get_audit_log_store().list_events("org-a", limit=10)
    assert any(event.action == "order.reassigned" for event in audit_events)


def test_bulk_assign_and_unassign_orders():
    admin_token = make_token("admin-a", "org-a", ["Admin"])
    order_ids = []
    for reference in (7001, 7002):
        created = client.post(
            "/orders/",
            json=make_order_payload(
                f"Bulk {reference}",
                "Warehouse 8",
                f"{reference} Market St",
                reference_number=reference,
            ),
            headers={"Authorization": f"Bearer {admin_token}"},
        )
        assert created.status_code == 200
        order_ids.append(created.json()["id"])

    bulk_assign = client.post(
        "/orders/bulk-assign",
        json={"order_ids": order_ids, "driver_id": "driver-42"},
        headers={"Authorization": f"Bearer {admin_token}"},
    )
    assert bulk_assign.status_code == 200
    assert bulk_assign.json()["updated"] == 2

    listed = client.get("/orders/?status=Assigned", headers={"Authorization": f"Bearer {admin_token}"})
    assert listed.status_code == 200
    assigned_ids = {item["id"] for item in listed.json()}
    assert set(order_ids).issubset(assigned_ids)

    bulk_unassign = client.post(
        "/orders/bulk-unassign",
        json={"order_ids": order_ids},
        headers={"Authorization": f"Bearer {admin_token}"},
    )
    assert bulk_unassign.status_code == 200
    assert bulk_unassign.json()["updated"] == 2

    for order_id in order_ids:
        order_response = client.get(f"/orders/{order_id}", headers={"Authorization": f"Bearer {admin_token}"})
        assert order_response.status_code == 200
        body = order_response.json()
        assert body["status"] == "Created"
        assert body["assigned_to"] is None

    audit_events = get_audit_log_store().list_events("org-a", limit=20)
    actions = [event.action for event in audit_events]
    assert "order.bulk_assigned" in actions
    assert "order.bulk_unassigned" in actions


def test_bulk_assign_requires_driver_id():
    admin_token = make_token("admin-a", "org-a", ["Admin"])
    created = client.post(
        "/orders/",
        json=make_order_payload("Bulk missing driver", "Warehouse 9", "901 Main", reference_number=9001),
        headers={"Authorization": f"Bearer {admin_token}"},
    )
    order_id = created.json()["id"]

    bulk_assign = client.post(
        "/orders/bulk-assign",
        json={"order_ids": [order_id], "driver_id": "   "},
        headers={"Authorization": f"Bearer {admin_token}"},
    )
    assert bulk_assign.status_code == 400
