import base64
import json
import os
import sys

import pytest
from fastapi.testclient import TestClient

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from app import app
from pod_service import reset_in_memory_pod_store
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
    monkeypatch.setenv("USE_IN_MEMORY_POD_STORE", "true")
    monkeypatch.setenv("POD_UPLOAD_URL_EXPIRES_SECONDS", "180")
    _orders.clear()
    reset_in_memory_pod_store()


def _create_assigned_order(admin_token: str, driver_id: str) -> str:
    create_response = client.post(
        "/orders/",
        json={
            "customer_name": "POD Customer",
            "address": "100 Delivery Ln",
            "num_packages": 1,
        },
        headers={"Authorization": f"Bearer {admin_token}"},
    )
    order_id = create_response.json()["id"]
    client.post(
        f"/orders/{order_id}/assign",
        json={"driver_id": driver_id},
        headers={"Authorization": f"Bearer {admin_token}"},
    )
    return order_id


def test_driver_can_request_presigned_uploads():
    admin_token = make_token("admin-1", "org-1", ["Admin"])
    driver_token = make_token("driver-1", "org-1", ["Driver"])
    order_id = _create_assigned_order(admin_token, "driver-1")

    response = client.post(
        "/pod/presign",
        json={
            "order_id": order_id,
            "artifacts": [
                {
                    "artifact_type": "photo",
                    "content_type": "image/jpeg",
                    "file_size_bytes": 250000,
                    "file_name": "dropoff.jpg",
                },
                {
                    "artifact_type": "signature",
                    "content_type": "image/png",
                    "file_size_bytes": 64000,
                    "file_name": "sig.png",
                },
            ],
        },
        headers={"Authorization": f"Bearer {driver_token}"},
    )
    assert response.status_code == 200
    body = response.json()
    assert len(body["uploads"]) == 2
    for upload in body["uploads"]:
        assert upload["key"].startswith(f"pod/org-1/{order_id}/driver-1/")
        assert upload["expires_in"] == 180
        assert "url" in upload
        assert "fields" in upload


def test_presign_rejects_unsupported_type_or_size():
    admin_token = make_token("admin-1", "org-1", ["Admin"])
    driver_token = make_token("driver-1", "org-1", ["Driver"])
    order_id = _create_assigned_order(admin_token, "driver-1")

    bad_type = client.post(
        "/pod/presign",
        json={
            "order_id": order_id,
            "artifacts": [
                {
                    "artifact_type": "photo",
                    "content_type": "application/pdf",
                    "file_size_bytes": 1000,
                }
            ],
        },
        headers={"Authorization": f"Bearer {driver_token}"},
    )
    assert bad_type.status_code == 400

    bad_size = client.post(
        "/pod/presign",
        json={
            "order_id": order_id,
            "artifacts": [
                {
                    "artifact_type": "signature",
                    "content_type": "image/png",
                    "file_size_bytes": 5 * 1024 * 1024,
                }
            ],
        },
        headers={"Authorization": f"Bearer {driver_token}"},
    )
    assert bad_size.status_code == 400


def test_unassigned_driver_cannot_upload_or_save_metadata():
    admin_token = make_token("admin-1", "org-1", ["Admin"])
    driver_one_token = make_token("driver-1", "org-1", ["Driver"])
    driver_two_token = make_token("driver-2", "org-1", ["Driver"])
    order_id = _create_assigned_order(admin_token, "driver-1")

    presign_forbidden = client.post(
        "/pod/presign",
        json={
            "order_id": order_id,
            "artifacts": [
                {
                    "artifact_type": "photo",
                    "content_type": "image/jpeg",
                    "file_size_bytes": 10000,
                }
            ],
        },
        headers={"Authorization": f"Bearer {driver_two_token}"},
    )
    assert presign_forbidden.status_code == 403

    presign_ok = client.post(
        "/pod/presign",
        json={
            "order_id": order_id,
            "artifacts": [
                {
                    "artifact_type": "photo",
                    "content_type": "image/jpeg",
                    "file_size_bytes": 10000,
                }
            ],
        },
        headers={"Authorization": f"Bearer {driver_one_token}"},
    )
    key = presign_ok.json()["uploads"][0]["key"]

    metadata_forbidden = client.post(
        "/pod/metadata",
        json={"order_id": order_id, "photo_keys": [key]},
        headers={"Authorization": f"Bearer {driver_two_token}"},
    )
    assert metadata_forbidden.status_code == 403


def test_driver_can_store_pod_metadata():
    admin_token = make_token("admin-1", "org-1", ["Admin"])
    driver_token = make_token("driver-1", "org-1", ["Driver"])
    order_id = _create_assigned_order(admin_token, "driver-1")

    presign = client.post(
        "/pod/presign",
        json={
            "order_id": order_id,
            "artifacts": [
                {
                    "artifact_type": "photo",
                    "content_type": "image/jpeg",
                    "file_size_bytes": 20000,
                }
            ],
        },
        headers={"Authorization": f"Bearer {driver_token}"},
    )
    photo_key = presign.json()["uploads"][0]["key"]

    metadata = client.post(
        "/pod/metadata",
        json={
            "order_id": order_id,
            "photo_keys": [photo_key],
            "notes": "Left with front desk",
            "location": {"lat": 37.782, "lng": -122.404, "heading": 90},
        },
        headers={"Authorization": f"Bearer {driver_token}"},
    )
    assert metadata.status_code == 200
    body = metadata.json()
    assert body["org_id"] == "org-1"
    assert body["order_id"] == order_id
    assert body["driver_id"] == "driver-1"
    assert body["photo_keys"] == [photo_key]
    assert body["location"]["lat"] == 37.782
