import base64
import json
import os
import sys

import pytest
from fastapi.testclient import TestClient

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "../..")))

from backend.app import app

client = TestClient(app)


def make_token(sub: str, org_id: str, groups, email: str = "user@example.com"):
    payload = {
        "sub": sub,
        "custom:org_id": org_id,
        "cognito:groups": groups,
        "email": email,
        "cognito:username": sub,
    }
    header = base64.urlsafe_b64encode(json.dumps({"alg": "none"}).encode()).rstrip(b"=")
    body = base64.urlsafe_b64encode(json.dumps(payload).encode()).rstrip(b"=")
    return f"{header.decode()}.{body.decode()}."


@pytest.fixture(autouse=True)
def _test_env(monkeypatch):
    monkeypatch.setenv("JWT_VERIFY_SIGNATURE", "false")
    monkeypatch.setenv("USE_IN_MEMORY_IDENTITY_STORE", "true")


def test_get_users_me_creates_or_updates_record():
    token = make_token("driver-1", "org-100", ["Driver"])
    response = client.get("/users/me", headers={"Authorization": f"Bearer {token}"})
    assert response.status_code == 200
    body = response.json()
    assert body["org_id"] == "org-100"
    assert body["user_id"] == "driver-1"
    assert body["roles"] == ["Driver"]


def test_org_me_auto_bootstrap_and_admin_update():
    admin_token = make_token("admin-1", "org-200", ["Admin"])

    get_org = client.get("/orgs/me", headers={"Authorization": f"Bearer {admin_token}"})
    assert get_org.status_code == 200
    assert get_org.json()["org_id"] == "org-200"

    update_org = client.put(
        "/orgs/me",
        json={"name": "Acme Dispatch"},
        headers={"Authorization": f"Bearer {admin_token}"},
    )
    assert update_org.status_code == 200
    assert update_org.json()["name"] == "Acme Dispatch"


def test_non_admin_cannot_update_org():
    dispatcher_token = make_token("dispatcher-1", "org-200", ["Dispatcher"])
    response = client.put(
        "/orgs/me",
        json={"name": "Should Not Work"},
        headers={"Authorization": f"Bearer {dispatcher_token}"},
    )
    assert response.status_code == 403
