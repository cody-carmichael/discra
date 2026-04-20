"""Tests for Gmail self-healing OAuth (invalid_grant detection + recovery).

Covers:
- GmailAuthError is raised when the refresh-token exchange returns invalid_grant.
- The poller short-circuits when org_config.needs_reauth is True.
- The poller marks needs_reauth + last_error_code on GmailAuthError.
- /email/connect merges tokens into the existing config and preserves email_rules.
"""

import base64
import json
import os
import sys
from datetime import datetime, timezone
from unittest.mock import MagicMock, patch

import pytest
from fastapi.testclient import TestClient

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "../..")))

from backend.app import app
from backend import email_poller
from backend.email_store import (
    get_email_config_store,
    reset_in_memory_email_config_store,
)
from backend.gmail_client import (
    GmailAuthError,
    GmailClient,
    _classify_refresh_error,
)
from backend.schemas import EmailConfig, EmailRule


client = TestClient(app)


def _make_token(sub: str, org_id: str, groups):
    payload = {"sub": sub, "custom:org_id": org_id, "cognito:groups": groups}
    header = base64.urlsafe_b64encode(json.dumps({"alg": "none"}).encode()).rstrip(b"=")
    body = base64.urlsafe_b64encode(json.dumps(payload).encode()).rstrip(b"=")
    return f"{header.decode()}.{body.decode()}."


ADMIN_TOKEN = _make_token("admin-r", "org-r", ["Admin"])
AUTH = {"Authorization": f"Bearer {ADMIN_TOKEN}"}


@pytest.fixture(autouse=True)
def _env(monkeypatch):
    monkeypatch.setenv("JWT_VERIFY_SIGNATURE", "false")
    monkeypatch.setenv("USE_IN_MEMORY_EMAIL_STORE", "true")
    reset_in_memory_email_config_store()


# ---------------------------------------------------------------------------
# 1. GmailAuthError translation
# ---------------------------------------------------------------------------

def test_classify_refresh_error_detects_invalid_grant():
    err = Exception("('invalid_grant: Token has been expired or revoked.', {})")
    assert _classify_refresh_error(err) == "invalid_grant"


def test_classify_refresh_error_returns_none_for_unrelated():
    assert _classify_refresh_error(Exception("connection reset by peer")) is None


def test_get_service_raises_gmail_auth_error_on_refresh_failure(monkeypatch):
    """When Credentials.refresh raises a RefreshError-like exception with
    invalid_grant in the message, GmailClient should translate it to
    GmailAuthError(code='invalid_grant')."""

    # The gmail_client module aliases google.auth.exceptions.RefreshError to
    # _GoogleRefreshError on import, falling back to plain Exception when the
    # google libs are not installed. We raise whatever it currently aliases to
    # so the test runs in either environment.
    from backend.gmail_client import _GoogleRefreshError as RefreshErrorAlias

    class _FakeCreds:
        def __init__(self, *a, **kw):
            pass

        def refresh(self, _request):
            raise RefreshErrorAlias("invalid_grant: Token has been expired or revoked.")

    monkeypatch.setattr("backend.gmail_client.Credentials", _FakeCreds)
    monkeypatch.setattr("backend.gmail_client.GoogleAuthRequest", lambda: object())

    gc = GmailClient(refresh_token="bad", client_id="cid", client_secret="csecret")
    with pytest.raises(GmailAuthError) as exc_info:
        gc._get_service()
    assert exc_info.value.code == "invalid_grant"


# ---------------------------------------------------------------------------
# 2. Poller behavior
# ---------------------------------------------------------------------------

def _seed(org_id="org-r", **overrides) -> EmailConfig:
    cfg = EmailConfig(
        org_id=org_id,
        gmail_email="test@example.com",
        gmail_refresh_token="tok",
        email_connected=True,
        connected_at=datetime.now(timezone.utc),
        gmail_history_id="100",
    )
    for k, v in overrides.items():
        setattr(cfg, k, v)
    get_email_config_store().put_config(cfg)
    return cfg


def test_process_org_short_circuits_when_needs_reauth():
    cfg = _seed(needs_reauth=True)
    with patch("backend.email_poller.GmailClient") as mock_cls:
        created, errors = email_poller._process_org(cfg)
    assert created == 0
    assert errors == []
    # The Gmail client must not even be instantiated when reauth is required.
    mock_cls.assert_not_called()


def test_process_org_marks_needs_reauth_on_gmail_auth_error():
    cfg = _seed()
    fake_gmail = MagicMock()
    fake_gmail.list_new_message_ids.side_effect = GmailAuthError(
        code="invalid_grant", message="Token has been expired or revoked."
    )
    with patch("backend.email_poller.GmailClient", return_value=fake_gmail), \
         patch("backend.email_poller._notify_reauth_required") as notify:
        created, errors = email_poller._process_org(cfg)

    assert created == 0
    assert errors == ["auth:invalid_grant"]
    notify.assert_called_once()

    stored = get_email_config_store().get_config("org-r")
    assert stored.needs_reauth is True
    assert stored.last_error_code == "invalid_grant"
    assert stored.last_error and "invalid_grant" in stored.last_error


# ---------------------------------------------------------------------------
# 3. /email/connect preserves email_rules and clears reauth state
# ---------------------------------------------------------------------------

def test_connect_preserves_email_rules_and_clears_reauth(monkeypatch):
    # Seed a connection that already has rules + is in needs_reauth state.
    now = datetime.now(timezone.utc)
    rule = EmailRule(
        rule_id="rule-1",
        name="Vel Logistix",
        sender_pattern="vellogistix.com",
        subject_pattern="",
        parser_type="email-airspace",
        enabled=True,
        created_at=now,
        updated_at=now,
    )
    _seed(
        last_error="('invalid_grant: ...')",
        last_error_code="invalid_grant",
        last_error_at=now,
        needs_reauth=True,
    )
    cfg = get_email_config_store().get_config("org-r")
    cfg.email_rules = [rule]
    get_email_config_store().put_config(cfg)

    # Mock the OAuth code exchange to return a fresh token.
    monkeypatch.setattr(
        "backend.routers.email.exchange_auth_code",
        lambda **kw: {
            "refresh_token": "new-token",
            "access_token": "x",
            "email": "test@example.com",
        },
    )

    resp = client.post(
        "/email/connect",
        headers=AUTH,
        json={"code": "fake-auth-code", "redirect_uri": "https://example/cb"},
    )
    assert resp.status_code == 200
    assert resp.json()["ok"] is True

    after = get_email_config_store().get_config("org-r")
    assert after.gmail_refresh_token == "new-token"
    assert after.needs_reauth is False
    assert after.last_error is None
    assert after.last_error_code is None
    # History reset so the next poll re-initializes.
    assert after.gmail_history_id is None
    # Rules survived the reconnect.
    assert len(after.email_rules) == 1
    assert after.email_rules[0].rule_id == "rule-1"


def test_status_response_surfaces_needs_reauth():
    _seed(
        last_error="('invalid_grant: Token has been expired or revoked.')",
        last_error_code="invalid_grant",
        last_error_at=datetime.now(timezone.utc),
        needs_reauth=True,
    )
    resp = client.get("/email/status", headers=AUTH)
    assert resp.status_code == 200
    body = resp.json()
    assert body["connected"] is True
    assert body["needs_reauth"] is True
    assert body["last_error_code"] == "invalid_grant"
    # The friendly message should NOT contain the raw Google tuple.
    assert "invalid_grant" not in body["last_error"]
    assert "reconnect" in body["last_error"].lower()
