import base64
import json
import os
import sys

import pytest
from fastapi.testclient import TestClient

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from app import app
from location_service import reset_in_memory_driver_location_store
try:
    from backend.routers.orders import _orders
except ModuleNotFoundError:
    from routers.orders import _orders

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
    monkeypatch.setenv("USE_IN_MEMORY_DRIVER_LOCATION_STORE", "true")
    monkeypatch.setenv("USE_IN_MEMORY_ROUTE_MATRIX", "true")
    _orders.clear()
    reset_in_memory_driver_location_store()


def _create_assigned_order(admin_token: str, driver_id: str, lat: float, lng: float):
    create = client.post(
        "/orders/",
        json={
            "customer_name": "Route Customer",
            "address": f"{lat},{lng}",
            "num_packages": 1,
            "delivery_lat": lat,
            "delivery_lng": lng,
        },
        headers={"Authorization": f"Bearer {admin_token}"},
    )
    order_id = create.json()["id"]
    client.post(
        f"/orders/{order_id}/assign",
        json={"driver_id": driver_id},
        headers={"Authorization": f"Bearer {admin_token}"},
    )
    return order_id


def test_optimize_assigned_orders_for_driver():
    admin_token = make_token("admin-1", "org-1", ["Admin"])
    driver_token = make_token("driver-1", "org-1", ["Driver"])

    client.post(
        "/drivers/location",
        json={"lat": 37.77, "lng": -122.42},
        headers={"Authorization": f"Bearer {driver_token}"},
    )

    order_ids = [
        _create_assigned_order(admin_token, "driver-1", 37.781, -122.404),
        _create_assigned_order(admin_token, "driver-1", 37.768, -122.431),
        _create_assigned_order(admin_token, "driver-1", 37.759, -122.414),
    ]

    response = client.post(
        "/routes/optimize",
        json={"driver_id": "driver-1"},
        headers={"Authorization": f"Bearer {admin_token}"},
    )
    assert response.status_code == 200
    body = response.json()
    assert body["matrix_source"] == "haversine-dev"
    returned_ids = [stop["order_id"] for stop in body["ordered_stops"]]
    assert set(returned_ids) == set(order_ids)
    assert body["total_distance_meters"] >= 0
    assert body["total_duration_seconds"] >= 0


def test_optimize_rejects_driver_role():
    driver_token = make_token("driver-2", "org-1", ["Driver"])
    response = client.post(
        "/routes/optimize",
        json={"driver_id": "driver-2", "stops": [{"order_id": "o1", "lat": 1, "lng": 1}]},
        headers={"Authorization": f"Bearer {driver_token}"},
    )
    assert response.status_code == 403


def test_optimize_fails_when_assigned_orders_missing_coordinates():
    dispatcher_token = make_token("dispatcher-1", "org-1", ["Dispatcher"])
    driver_id = "driver-1"

    create = client.post(
        "/orders/",
        json={"customer_name": "No coords", "address": "Missing", "num_packages": 1},
        headers={"Authorization": f"Bearer {dispatcher_token}"},
    )
    order_id = create.json()["id"]
    client.post(
        f"/orders/{order_id}/assign",
        json={"driver_id": driver_id},
        headers={"Authorization": f"Bearer {dispatcher_token}"},
    )

    response = client.post(
        "/routes/optimize",
        json={"driver_id": driver_id},
        headers={"Authorization": f"Bearer {dispatcher_token}"},
    )
    assert response.status_code == 400
    assert "missing delivery coordinates" in response.json()["detail"].lower()


def test_optimize_with_explicit_stops_payload():
    dispatcher_token = make_token("dispatcher-9", "org-9", ["Dispatcher"])
    response = client.post(
        "/routes/optimize",
        json={
            "driver_id": "driver-x",
            "start_lat": 37.77,
            "start_lng": -122.42,
            "stops": [
                {"order_id": "order-a", "lat": 37.781, "lng": -122.404},
                {"order_id": "order-b", "lat": 37.768, "lng": -122.431},
            ],
        },
        headers={"Authorization": f"Bearer {dispatcher_token}"},
    )
    assert response.status_code == 200
    body = response.json()
    assert len(body["ordered_stops"]) == 2
    assert {stop["order_id"] for stop in body["ordered_stops"]} == {"order-a", "order-b"}
