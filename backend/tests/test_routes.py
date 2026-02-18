import base64
import json
import os
import sys

import pytest
from fastapi.testclient import TestClient

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "../..")))

from backend.app import app
from backend.location_service import reset_in_memory_driver_location_store
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
    monkeypatch.setenv("USE_IN_MEMORY_DRIVER_LOCATION_STORE", "true")
    monkeypatch.setenv("USE_IN_MEMORY_ROUTE_MATRIX", "true")
    _orders.clear()
    reset_in_memory_driver_location_store()


def _create_assigned_order(admin_token: str, driver_id: str, reference_number: int, delivery: str):
    create = client.post(
        "/orders/",
        json={
            "customer_name": "Route Customer",
            "reference_number": reference_number,
            "pick_up_address": "Route Warehouse",
            "delivery": delivery,
            "dimensions": "10x10x10 in",
            "weight": 5.5,
            "num_packages": 1,
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
        _create_assigned_order(admin_token, "driver-1", 7001, "Dropoff A"),
        _create_assigned_order(admin_token, "driver-1", 7002, "Dropoff B"),
        _create_assigned_order(admin_token, "driver-1", 7003, "Dropoff C"),
    ]

    response = client.post(
        "/routes/optimize",
        json={
            "driver_id": "driver-1",
            "stops": [
                {"order_id": order_ids[0], "lat": 37.781, "lng": -122.404},
                {"order_id": order_ids[1], "lat": 37.768, "lng": -122.431},
                {"order_id": order_ids[2], "lat": 37.759, "lng": -122.414},
            ],
        },
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


def test_optimize_assigned_orders_requires_explicit_stops():
    dispatcher_token = make_token("dispatcher-1", "org-1", ["Dispatcher"])
    driver_id = "driver-1"

    create = client.post(
        "/orders/",
        json={
            "customer_name": "No coords",
            "reference_number": 8001,
            "pick_up_address": "Warehouse Missing",
            "delivery": "Missing",
            "dimensions": "4x4x4 in",
            "weight": 1.5,
            "num_packages": 1,
        },
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
    assert "provide explicit stops" in response.json()["detail"].lower()


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
