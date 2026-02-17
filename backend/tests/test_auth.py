import base64
import json
import os
import sys

from fastapi import Depends, FastAPI
from fastapi.testclient import TestClient

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from auth import _decode_jwt, get_current_user, require_roles


def make_mock_token(payload):
    header = base64.urlsafe_b64encode(json.dumps({"alg": "none"}).encode()).rstrip(b"=")
    body = base64.urlsafe_b64encode(json.dumps(payload).encode()).rstrip(b"=")
    return f"{header.decode()}.{body.decode()}."


def _build_test_app():
    app = FastAPI()

    @app.get("/whoami")
    async def whoami(user=Depends(get_current_user)):
        return user

    @app.get("/admin-only")
    async def admin_only(user=Depends(require_roles(["Admin"]))):
        return {"sub": user["sub"]}

    return app


def test_decode_jwt_dev_mode(monkeypatch):
    monkeypatch.setenv("JWT_VERIFY_SIGNATURE", "false")
    token = make_mock_token(
        {
            "sub": "user-123",
            "cognito:groups": ["Dispatcher"],
            "custom:org_id": "org-001",
        }
    )
    decoded = _decode_jwt(token)
    assert decoded.get("sub") == "user-123"


def test_whoami_with_org_and_groups(monkeypatch):
    monkeypatch.setenv("JWT_VERIFY_SIGNATURE", "false")
    app = _build_test_app()
    client = TestClient(app)
    token = make_mock_token(
        {
            "sub": "user-123",
            "cognito:username": "tester",
            "email": "test@example.com",
            "cognito:groups": ["Dispatcher"],
            "custom:org_id": "org-001",
        }
    )

    response = client.get("/whoami", headers={"Authorization": f"Bearer {token}"})
    assert response.status_code == 200
    body = response.json()
    assert body["sub"] == "user-123"
    assert body["org_id"] == "org-001"
    assert "Dispatcher" in body["groups"]


def test_missing_org_claim_is_forbidden(monkeypatch):
    monkeypatch.setenv("JWT_VERIFY_SIGNATURE", "false")
    app = _build_test_app()
    client = TestClient(app)
    token = make_mock_token({"sub": "user-123", "cognito:groups": ["Admin"]})

    response = client.get("/whoami", headers={"Authorization": f"Bearer {token}"})
    assert response.status_code == 403


def test_rbac_blocks_non_admin(monkeypatch):
    monkeypatch.setenv("JWT_VERIFY_SIGNATURE", "false")
    app = _build_test_app()
    client = TestClient(app)
    dispatcher_token = make_mock_token(
        {
            "sub": "dispatcher-1",
            "cognito:groups": ["Dispatcher"],
            "custom:org_id": "org-001",
        }
    )

    response = client.get("/admin-only", headers={"Authorization": f"Bearer {dispatcher_token}"})
    assert response.status_code == 403
