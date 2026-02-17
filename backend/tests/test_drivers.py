import base64
import json
import os
import sys
from datetime import datetime, timedelta, timezone

import pytest
from fastapi.testclient import TestClient

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from app import app
from location_service import reset_in_memory_driver_location_store

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
    monkeypatch.setenv("USE_IN_MEMORY_DRIVER_LOCATION_STORE", "true")
    monkeypatch.setenv("DRIVER_LOCATION_TTL_SECONDS", "3600")
    reset_in_memory_driver_location_store()


def test_driver_can_post_location_and_admin_can_list():
    driver_token = make_token("driver-1", "org-1", ["Driver"])
    admin_token = make_token("admin-1", "org-1", ["Admin"])

    update = client.post(
        "/drivers/location",
        json={"lat": 37.77, "lng": -122.42, "heading": 130},
        headers={"Authorization": f"Bearer {driver_token}"},
    )
    assert update.status_code == 200
    assert update.json()["driver_id"] == "driver-1"

    listing = client.get("/drivers", headers={"Authorization": f"Bearer {admin_token}"})
    assert listing.status_code == 200
    body = listing.json()
    assert len(body) == 1
    assert body[0]["driver_id"] == "driver-1"
    assert body[0]["org_id"] == "org-1"


def test_dispatcher_can_list_driver_locations():
    driver_token = make_token("driver-2", "org-2", ["Driver"])
    dispatcher_token = make_token("dispatch-1", "org-2", ["Dispatcher"])

    client.post(
        "/drivers/location",
        json={"lat": 40.71, "lng": -74.00},
        headers={"Authorization": f"Bearer {driver_token}"},
    )

    listing = client.get("/drivers", headers={"Authorization": f"Bearer {dispatcher_token}"})
    assert listing.status_code == 200
    assert len(listing.json()) == 1


def test_driver_cannot_list_all_driver_locations():
    driver_token = make_token("driver-3", "org-3", ["Driver"])
    response = client.get("/drivers", headers={"Authorization": f"Bearer {driver_token}"})
    assert response.status_code == 403


def test_locations_are_tenant_scoped():
    org1_driver = make_token("driver-a", "org-a", ["Driver"])
    org2_driver = make_token("driver-b", "org-b", ["Driver"])
    org1_admin = make_token("admin-a", "org-a", ["Admin"])

    client.post(
        "/drivers/location",
        json={"lat": 34.05, "lng": -118.24},
        headers={"Authorization": f"Bearer {org1_driver}"},
    )
    client.post(
        "/drivers/location",
        json={"lat": 47.60, "lng": -122.33},
        headers={"Authorization": f"Bearer {org2_driver}"},
    )

    listing = client.get("/drivers", headers={"Authorization": f"Bearer {org1_admin}"})
    assert listing.status_code == 200
    body = listing.json()
    assert len(body) == 1
    assert body[0]["driver_id"] == "driver-a"


def test_active_minutes_filter_excludes_old_location():
    old_driver_token = make_token("driver-old", "org-z", ["Driver"])
    active_driver_token = make_token("driver-new", "org-z", ["Driver"])
    admin_token = make_token("admin-z", "org-z", ["Admin"])
    old_timestamp = (datetime.now(timezone.utc) - timedelta(hours=3)).isoformat()

    client.post(
        "/drivers/location",
        json={"lat": 10.0, "lng": 10.0, "timestamp": old_timestamp},
        headers={"Authorization": f"Bearer {old_driver_token}"},
    )
    client.post(
        "/drivers/location",
        json={"lat": 11.0, "lng": 11.0},
        headers={"Authorization": f"Bearer {active_driver_token}"},
    )

    listing = client.get("/drivers?active_minutes=60", headers={"Authorization": f"Bearer {admin_token}"})
    assert listing.status_code == 200
    body = listing.json()
    assert len(body) == 1
    assert body[0]["driver_id"] == "driver-new"
