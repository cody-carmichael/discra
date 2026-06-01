import base64
import json
import os
import sys

import pytest
from fastapi.testclient import TestClient

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "../..")))

from backend.app import app
from backend.order_store import reset_in_memory_order_store
from backend.pod_service import reset_in_memory_pod_store

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
    monkeypatch.setenv("USE_IN_MEMORY_ORDER_STORE", "true")
    monkeypatch.setenv("USE_IN_MEMORY_POD_STORE", "true")
    monkeypatch.setenv("POD_UPLOAD_URL_EXPIRES_SECONDS", "180")
    reset_in_memory_order_store()
    reset_in_memory_pod_store()


def _create_assigned_order(admin_token: str, driver_id: str) -> str:
    create_response = client.post(
        "/orders/",
        json={
            "customer_name": "POD Customer",
            "reference_id": "9001",
            "pick_up_street": "Warehouse POD",
            "pick_up_city": "Test City",
            "pick_up_state": "TS",
            "pick_up_zip": "00000",
            "delivery_street": "100 Delivery Ln",
            "delivery_city": "Dest City",
            "delivery_state": "DS",
            "delivery_zip": "99999",
            "dimensions": "8x8x8 in",
            "weight": 3.2,
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


def _presign_one(driver_token: str, order_id: str, artifact_type="photo", content_type="image/jpeg"):
    resp = client.post(
        "/pod/presign",
        json={
            "order_id": order_id,
            "artifacts": [
                {"artifact_type": artifact_type, "content_type": content_type, "file_size_bytes": 20000}
            ],
        },
        headers={"Authorization": f"Bearer {driver_token}"},
    )
    assert resp.status_code == 200
    return resp.json()["uploads"][0]["key"]


def test_pod_metadata_is_idempotent_on_duplicate_submit():
    """Regression (ledger A-1 / Step 1.2): a retried or double-submitted
    /pod/metadata with the SAME artifact keys must NOT create a second POD
    record — it returns the existing one. Guards against network retries, two
    tabs, and a restored detail panel producing duplicate deliveries."""
    admin_token = make_token("admin-1", "org-1", ["Admin"])
    driver_token = make_token("driver-1", "org-1", ["Driver"])
    order_id = _create_assigned_order(admin_token, "driver-1")
    photo_key = _presign_one(driver_token, order_id)

    payload = {"order_id": order_id, "photo_keys": [photo_key], "signature_keys": []}
    first = client.post("/pod/metadata", json=payload, headers={"Authorization": f"Bearer {driver_token}"})
    second = client.post("/pod/metadata", json=payload, headers={"Authorization": f"Bearer {driver_token}"})

    assert first.status_code == 200 and second.status_code == 200
    # Same logical record returned both times.
    assert first.json()["pod_id"] == second.json()["pod_id"]

    # And the viewer shows exactly ONE record for the order.
    pod_list = client.get(
        f"/pod/order/{order_id}", headers={"Authorization": f"Bearer {admin_token}"}
    )
    assert pod_list.status_code == 200
    assert len(pod_list.json()) == 1


def test_pod_metadata_distinct_captures_create_distinct_records():
    """A genuinely new capture (different keys) is still recorded separately —
    idempotency must not collapse legitimately different submissions."""
    admin_token = make_token("admin-1", "org-1", ["Admin"])
    driver_token = make_token("driver-1", "org-1", ["Driver"])
    order_id = _create_assigned_order(admin_token, "driver-1")

    key_a = _presign_one(driver_token, order_id)
    key_b = _presign_one(driver_token, order_id)
    assert key_a != key_b  # uuid4 per upload

    client.post("/pod/metadata", json={"order_id": order_id, "photo_keys": [key_a]},
                headers={"Authorization": f"Bearer {driver_token}"})
    client.post("/pod/metadata", json={"order_id": order_id, "photo_keys": [key_b]},
                headers={"Authorization": f"Bearer {driver_token}"})

    pod_list = client.get(f"/pod/order/{order_id}", headers={"Authorization": f"Bearer {admin_token}"})
    assert len(pod_list.json()) == 2


def test_pod_viewer_returns_photo_and_signature_urls():
    """The admin POD viewer must surface presigned GET URLs for both the photo
    and signature so the images actually render (Step 1.2 'image/signature
    appears'). In-memory store returns deterministic view URLs per key."""
    admin_token = make_token("admin-1", "org-1", ["Admin"])
    driver_token = make_token("driver-1", "org-1", ["Driver"])
    order_id = _create_assigned_order(admin_token, "driver-1")

    photo_key = _presign_one(driver_token, order_id, "photo", "image/jpeg")
    sig_key = _presign_one(driver_token, order_id, "signature", "image/png")
    client.post(
        "/pod/metadata",
        json={"order_id": order_id, "photo_keys": [photo_key], "signature_keys": [sig_key]},
        headers={"Authorization": f"Bearer {driver_token}"},
    )

    view = client.get(f"/pod/order/{order_id}", headers={"Authorization": f"Bearer {admin_token}"})
    assert view.status_code == 200
    record = view.json()[0]
    assert len(record["photo_urls"]) == 1 and record["photo_urls"][0]
    assert len(record["signature_urls"]) == 1 and record["signature_urls"][0]
