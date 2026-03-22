import base64
import json
import os
import sys

from fastapi.testclient import TestClient

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "../..")))

from backend import app as app_module
from backend.app import app
from backend.auth import web_auth_cookie_name

client = TestClient(app)


def make_token(
    *,
    sub: str,
    email: str,
    groups=None,
    org_id: str | None = None,
):
    payload = {
        "sub": sub,
        "email": email,
        "cognito:username": sub,
    }
    if groups is not None:
        payload["cognito:groups"] = groups
    if org_id:
        payload["custom:org_id"] = org_id
    header = base64.urlsafe_b64encode(json.dumps({"alg": "none"}).encode()).rstrip(b"=")
    body = base64.urlsafe_b64encode(json.dumps(payload).encode()).rstrip(b"=")
    return f"{header.decode()}.{body.decode()}."


def test_ui_auth_session_inactive_without_cookie():
    response = client.get("/ui/auth/session")
    assert response.status_code == 200
    assert response.json()["active"] is False


def test_ui_hosted_login_callback_sets_http_only_cookie_and_session(monkeypatch):
    monkeypatch.setenv("JWT_VERIFY_SIGNATURE", "false")

    def fake_exchange(**kwargs):
        return {
            "id_token": make_token(
                sub="session-user-1",
                email="session-user-1@example.com",
                groups=["Admin"],
                org_id="org-session-1",
            )
        }

    monkeypatch.setattr(app_module, "_exchange_hosted_code_for_token", fake_exchange)

    callback = client.post(
        "/ui/auth/hosted-login/callback",
        json={
            "code": "abc123",
            "state": "state-1",
            "expected_state": "state-1",
            "code_verifier": "verifier-1",
            "redirect_uri": "https://example.com/ui/login",
            "domain": "demo-auth.example.com",
            "client_id": "client-123",
        },
    )
    assert callback.status_code == 200
    set_cookie = callback.headers.get("set-cookie", "")
    assert web_auth_cookie_name() in set_cookie
    assert "httponly" in set_cookie.lower()

    session = client.get("/ui/auth/session")
    assert session.status_code == 200
    body = session.json()
    assert body["active"] is True
    assert body["user"]["sub"] == "session-user-1"
    assert body["user"]["org_id"] == "org-session-1"
    assert "Admin" in (body["user"]["groups"] or [])


def test_ui_auth_logout_clears_cookie_and_returns_logout_url(monkeypatch):
    monkeypatch.setenv("JWT_VERIFY_SIGNATURE", "false")
    token = make_token(
        sub="session-user-2",
        email="session-user-2@example.com",
        groups=["Dispatcher"],
        org_id="org-session-2",
    )

    def fake_exchange(**kwargs):
        return {"id_token": token}

    monkeypatch.setattr(app_module, "_exchange_hosted_code_for_token", fake_exchange)
    callback = client.post(
        "/ui/auth/hosted-login/callback",
        json={
            "code": "logout-code",
            "state": "logout-state",
            "expected_state": "logout-state",
            "code_verifier": "logout-verifier",
            "redirect_uri": "https://example.com/ui/login",
            "domain": "demo-auth.example.com",
            "client_id": "client-123",
        },
    )
    assert callback.status_code == 200

    logout = client.post(
        "/ui/auth/logout",
        json={
            "domain": "demo-auth.example.com",
            "client_id": "client-123",
            "logout_uri": "https://example.com/ui/login",
        },
    )
    assert logout.status_code == 200
    payload = logout.json()
    assert payload["ok"] is True
    assert payload["logout_url"].startswith("https://demo-auth.example.com/logout?")
    assert "Max-Age=0" in (logout.headers.get("set-cookie", ""))

    session = client.get("/ui/auth/session")
    assert session.status_code == 200
    assert session.json()["active"] is False
