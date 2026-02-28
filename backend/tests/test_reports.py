import base64
import json
import os
import sys
from datetime import datetime, timedelta, timezone

import pytest
from fastapi.testclient import TestClient

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "../..")))

from backend.location_service import reset_in_memory_driver_location_store
from backend.order_store import reset_in_memory_order_store
from backend.app import app

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


def make_order_payload(customer_name: str, reference_number: int):
    return {
        "customer_name": customer_name,
        "reference_number": reference_number,
        "pick_up_address": "Warehouse A",
        "delivery": f"{reference_number} Main St",
        "dimensions": "12x8x5 in",
        "weight": 4.5,
        "num_packages": 1,
    }


@pytest.fixture(autouse=True)
def _test_env(monkeypatch):
    monkeypatch.setenv("JWT_VERIFY_SIGNATURE", "false")
    monkeypatch.setenv("USE_IN_MEMORY_ORDER_STORE", "true")
    monkeypatch.setenv("USE_IN_MEMORY_DRIVER_LOCATION_STORE", "true")
    reset_in_memory_order_store()
    reset_in_memory_driver_location_store()


def test_dispatch_summary_reports_orders_and_active_drivers():
    org_id = "org-report-1"
    admin_token = make_token("admin-1", org_id, ["Admin"])
    dispatcher_token = make_token("dispatch-1", org_id, ["Dispatcher"])
    driver_1 = make_token("driver-1", org_id, ["Driver"])
    driver_2 = make_token("driver-2", org_id, ["Driver"])

    order_1 = client.post("/orders/", json=make_order_payload("Order 1", 1101), headers={"Authorization": f"Bearer {admin_token}"})
    order_2 = client.post("/orders/", json=make_order_payload("Order 2", 1102), headers={"Authorization": f"Bearer {admin_token}"})
    order_3 = client.post("/orders/", json=make_order_payload("Order 3", 1103), headers={"Authorization": f"Bearer {admin_token}"})
    assert order_1.status_code == 200
    assert order_2.status_code == 200
    assert order_3.status_code == 200

    order_1_id = order_1.json()["id"]
    order_2_id = order_2.json()["id"]

    assert client.post(
        f"/orders/{order_1_id}/assign",
        json={"driver_id": "driver-1"},
        headers={"Authorization": f"Bearer {admin_token}"},
    ).status_code == 200
    assert client.post(
        f"/orders/{order_2_id}/assign",
        json={"driver_id": "driver-2"},
        headers={"Authorization": f"Bearer {admin_token}"},
    ).status_code == 200
    assert client.post(
        f"/orders/{order_2_id}/status",
        json={"status": "Failed"},
        headers={"Authorization": f"Bearer {admin_token}"},
    ).status_code == 200

    assert client.post(
        "/drivers/location",
        json={"lat": 36.16, "lng": -86.78},
        headers={"Authorization": f"Bearer {driver_1}"},
    ).status_code == 200
    old_timestamp = (datetime.now(timezone.utc) - timedelta(hours=3)).isoformat()
    assert client.post(
        "/drivers/location",
        json={"lat": 35.15, "lng": -90.05, "timestamp": old_timestamp},
        headers={"Authorization": f"Bearer {driver_2}"},
    ).status_code == 200

    summary = client.get(
        "/reports/dispatch-summary?active_minutes=60",
        headers={"Authorization": f"Bearer {dispatcher_token}"},
    )
    assert summary.status_code == 200
    body = summary.json()
    assert body["org_id"] == org_id
    assert body["total_orders"] == 3
    assert body["assigned_orders"] == 2
    assert body["unassigned_orders"] == 1
    assert body["terminal_orders"] == 1
    assert body["by_status"]["Created"] == 1
    assert body["by_status"]["Assigned"] == 1
    assert body["by_status"]["Failed"] == 1
    assert body["active_drivers"] == 1
    assert body["active_driver_ids"] == ["driver-1"]


def test_driver_cannot_view_dispatch_summary():
    driver_token = make_token("driver-10", "org-report-2", ["Driver"])
    response = client.get(
        "/reports/dispatch-summary",
        headers={"Authorization": f"Bearer {driver_token}"},
    )
    assert response.status_code == 403
