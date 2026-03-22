import base64
import hashlib
import hmac
import json
import os
import re
import sys
from datetime import datetime, timezone
from urllib.parse import unquote

import pytest
from fastapi.testclient import TestClient

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "../..")))

from backend.app import app
from backend.audit_store import get_audit_log_store, reset_in_memory_audit_log_store
from backend.onboarding_service import reset_in_memory_onboarding_repository
from backend.repositories import _IN_MEMORY_REPO
from backend.routers import onboarding as onboarding_router

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


def auth_header(token: str):
    return {"Authorization": f"Bearer {token}"}


class FakeNotifier:
    def __init__(self):
        self.messages = []

    def send_email(self, *, to_addresses, subject: str, text_body: str):
        self.messages.append(
            {
                "to": list(to_addresses),
                "subject": subject,
                "text": text_body,
            }
        )


class FakeCognitoAdminClient:
    def __init__(self):
        self.calls = []

    def ensure_admin_access(self, *, username: str, org_id: str, role_name: str = "Admin"):
        self.calls.append(
            {
                "username": username,
                "org_id": org_id,
                "role_name": role_name,
            }
        )


def _extract_review_token(notifier: FakeNotifier) -> str:
    pattern = re.compile(r"token=([A-Za-z0-9%._\-]+)")
    for message in reversed(notifier.messages):
        match = pattern.search(message["text"])
        if match:
            return unquote(match.group(1))
    raise AssertionError("No review token found in notifier messages")


def _build_signed_review_token(*, registration_id: str, iat_epoch: int, exp_epoch: int, secret: str) -> str:
    payload = {
        "registration_id": registration_id,
        "iat": iat_epoch,
        "exp": exp_epoch,
    }
    encoded = base64.urlsafe_b64encode(json.dumps(payload, separators=(",", ":")).encode("utf-8")).decode("utf-8").rstrip("=")
    signature = hmac.new(secret.encode("utf-8"), encoded.encode("utf-8"), digestmod=hashlib.sha256).hexdigest()
    return f"{encoded}.{signature}"


def _submit_registration(requester_token: str, tenant_name: str = "Acme Onboarding"):
    return client.post(
        "/onboarding/registrations",
        json={"tenant_name": tenant_name, "contact_name": "Owner", "notes": "pilot"},
        headers=auth_header(requester_token),
    )


@pytest.fixture(autouse=True)
def _test_env(monkeypatch):
    monkeypatch.setenv("JWT_VERIFY_SIGNATURE", "false")
    monkeypatch.setenv("USE_IN_MEMORY_IDENTITY_STORE", "true")
    monkeypatch.setenv("USE_IN_MEMORY_AUDIT_LOG_STORE", "true")
    monkeypatch.setenv("USE_IN_MEMORY_ONBOARDING_STORE", "true")
    monkeypatch.setenv("ONBOARDING_LINK_SIGNING_SECRET", "test-onboarding-secret")
    monkeypatch.setenv("ONBOARDING_APPROVER_EMAIL_ALLOWLIST", "approver@example.com")
    monkeypatch.setenv("ONBOARDING_APP_REVIEW_URL_BASE", "https://app.example.com/dev/backend/ui/review")
    monkeypatch.setenv("ONBOARDING_APP_REGISTER_URL_BASE", "https://app.example.com/dev/backend/ui/register")
    monkeypatch.setenv("ENABLE_ONBOARDING_FLOW", "true")
    reset_in_memory_audit_log_store()
    reset_in_memory_onboarding_repository()
    _IN_MEMORY_REPO._orgs.clear()
    _IN_MEMORY_REPO._users.clear()
    app.dependency_overrides.clear()
    yield
    app.dependency_overrides.clear()


def test_registration_submit_update_and_pending_status():
    notifier = FakeNotifier()
    app.dependency_overrides[onboarding_router.get_onboarding_notifier] = lambda: notifier

    requester_token = make_token(sub="requester-1", email="requester-1@example.com", groups=[])
    first = _submit_registration(requester_token, tenant_name="Acme Alpha")
    assert first.status_code == 200
    first_body = first.json()
    assert first_body["exists"] is True
    assert first_body["registration"]["status"] == "Pending"

    second = _submit_registration(requester_token, tenant_name="Acme Alpha")
    assert second.status_code == 200
    second_body = second.json()
    assert second_body["exists"] is True
    assert second_body["registration"]["status"] == "Pending"
    assert second_body["registration"]["submitted_at"] == first_body["registration"]["submitted_at"]

    status = client.get("/onboarding/registrations/me", headers=auth_header(requester_token))
    assert status.status_code == 200
    status_body = status.json()
    assert status_body["exists"] is True
    assert status_body["registration"]["status"] == "Pending"
    assert len(notifier.messages) >= 1


def test_approve_flow_updates_org_user_cognito_and_notifications():
    notifier = FakeNotifier()
    cognito = FakeCognitoAdminClient()
    app.dependency_overrides[onboarding_router.get_onboarding_notifier] = lambda: notifier
    app.dependency_overrides[onboarding_router.get_onboarding_cognito_admin_client] = lambda: cognito

    requester_token = make_token(sub="requester-2", email="requester-2@example.com", groups=[])
    submit = _submit_registration(requester_token, tenant_name="Bright Freight")
    assert submit.status_code == 200

    review_token = _extract_review_token(notifier)
    review = client.get(f"/onboarding/review?token={review_token}")
    assert review.status_code == 200
    assert review.json()["registration"]["status"] == "Pending"

    approver_token = make_token(sub="approver-1", email="approver@example.com", groups=["Admin"])
    decision = client.post(
        "/onboarding/review/decision",
        json={"token": review_token, "decision": "approve", "reason": "Looks good"},
        headers=auth_header(approver_token),
    )
    assert decision.status_code == 200
    body = decision.json()
    assert body["idempotent"] is False
    assert body["registration"]["status"] == "Approved"
    assert body["registration"]["org_id"]

    org_id = body["registration"]["org_id"]
    org_record = _IN_MEMORY_REPO.get_org(org_id)
    assert org_record is not None
    user_record = _IN_MEMORY_REPO.get_user(org_id, "requester-2")
    assert user_record is not None
    assert "Admin" in user_record.roles
    assert len(cognito.calls) == 1
    assert cognito.calls[0]["org_id"] == org_id

    approval_messages = [item for item in notifier.messages if "approved" in item["subject"].lower()]
    assert len(approval_messages) >= 1


def test_approver_can_list_pending_and_approve_from_queue():
    notifier = FakeNotifier()
    cognito = FakeCognitoAdminClient()
    app.dependency_overrides[onboarding_router.get_onboarding_notifier] = lambda: notifier
    app.dependency_overrides[onboarding_router.get_onboarding_cognito_admin_client] = lambda: cognito

    requester_token = make_token(sub="requester-queue-1", email="requester-queue-1@example.com", groups=[])
    submit = _submit_registration(requester_token, tenant_name="Queue Freight")
    assert submit.status_code == 200
    registration_id = submit.json()["registration"]["registration_id"]

    approver_token = make_token(sub="approver-queue-1", email="approver@example.com", groups=["Admin"])
    pending = client.get("/onboarding/registrations/pending", headers=auth_header(approver_token))
    assert pending.status_code == 200
    pending_body = pending.json()
    pending_ids = [item["registration_id"] for item in pending_body["items"]]
    assert registration_id in pending_ids

    decision = client.post(
        "/onboarding/review/decision/by-registration",
        json={"registration_id": registration_id, "decision": "approve"},
        headers=auth_header(approver_token),
    )
    assert decision.status_code == 200
    body = decision.json()
    assert body["idempotent"] is False
    assert body["registration"]["status"] == "Approved"
    assert body["registration"]["org_id"]
    assert len(cognito.calls) == 1


def test_pending_queue_and_decision_by_registration_require_allowlisted_approver():
    notifier = FakeNotifier()
    app.dependency_overrides[onboarding_router.get_onboarding_notifier] = lambda: notifier

    requester_token = make_token(sub="requester-queue-2", email="requester-queue-2@example.com", groups=[])
    submit = _submit_registration(requester_token, tenant_name="Queue Reject Freight")
    assert submit.status_code == 200
    registration_id = submit.json()["registration"]["registration_id"]

    outsider_token = make_token(sub="outsider-queue-1", email="outsider@example.com", groups=["Admin"])
    pending = client.get("/onboarding/registrations/pending", headers=auth_header(outsider_token))
    assert pending.status_code == 403

    decision = client.post(
        "/onboarding/review/decision/by-registration",
        json={"registration_id": registration_id, "decision": "reject"},
        headers=auth_header(outsider_token),
    )
    assert decision.status_code == 403


def test_reject_flow_persists_decision_and_sends_notification():
    notifier = FakeNotifier()
    app.dependency_overrides[onboarding_router.get_onboarding_notifier] = lambda: notifier

    requester_token = make_token(sub="requester-3", email="requester-3@example.com", groups=[])
    submit = _submit_registration(requester_token, tenant_name="North Logistics")
    assert submit.status_code == 200
    review_token = _extract_review_token(notifier)

    approver_token = make_token(sub="approver-2", email="approver@example.com", groups=["Admin"])
    decision = client.post(
        "/onboarding/review/decision",
        json={"token": review_token, "decision": "reject", "reason": "Need additional verification"},
        headers=auth_header(approver_token),
    )
    assert decision.status_code == 200
    body = decision.json()
    assert body["registration"]["status"] == "Rejected"
    assert body["registration"]["decision_reason"] == "Need additional verification"
    assert body["registration"]["decided_by_email"] == "approver@example.com"

    rejected_messages = [item for item in notifier.messages if "update" in item["subject"].lower()]
    assert len(rejected_messages) >= 1


def test_signed_link_tamper_expiry_and_replay_protection():
    notifier = FakeNotifier()
    cognito = FakeCognitoAdminClient()
    app.dependency_overrides[onboarding_router.get_onboarding_notifier] = lambda: notifier
    app.dependency_overrides[onboarding_router.get_onboarding_cognito_admin_client] = lambda: cognito

    requester_token = make_token(sub="requester-4", email="requester-4@example.com", groups=[])
    submit = _submit_registration(requester_token, tenant_name="Replay Freight")
    assert submit.status_code == 200
    registration_id = submit.json()["registration"]["registration_id"]
    valid_review_token = _extract_review_token(notifier)

    tampered = valid_review_token[:-1] + ("a" if valid_review_token[-1] != "a" else "b")
    tampered_response = client.get(f"/onboarding/review?token={tampered}")
    assert tampered_response.status_code == 400

    now_epoch = int(datetime.now(timezone.utc).timestamp())
    expired_token = _build_signed_review_token(
        registration_id=registration_id,
        iat_epoch=now_epoch - 500,
        exp_epoch=now_epoch - 100,
        secret="test-onboarding-secret",
    )
    expired_response = client.get(f"/onboarding/review?token={expired_token}")
    assert expired_response.status_code == 400

    approver_token = make_token(sub="approver-3", email="approver@example.com", groups=["Admin"])
    first_decision = client.post(
        "/onboarding/review/decision",
        json={"token": valid_review_token, "decision": "approve"},
        headers=auth_header(approver_token),
    )
    assert first_decision.status_code == 200
    assert first_decision.json()["registration"]["status"] == "Approved"

    replay = client.post(
        "/onboarding/review/decision",
        json={"token": valid_review_token, "decision": "approve"},
        headers=auth_header(approver_token),
    )
    assert replay.status_code == 200
    assert replay.json()["idempotent"] is True
    assert replay.json()["registration"]["status"] == "Approved"


def test_unauthorized_decision_attempts_are_blocked():
    notifier = FakeNotifier()
    app.dependency_overrides[onboarding_router.get_onboarding_notifier] = lambda: notifier

    requester_token = make_token(sub="requester-5", email="requester-5@example.com", groups=[])
    submit = _submit_registration(requester_token, tenant_name="Allowlist Freight")
    assert submit.status_code == 200
    review_token = _extract_review_token(notifier)

    outsider_token = make_token(sub="outsider-1", email="outsider@example.com", groups=["Admin"])
    outsider_attempt = client.post(
        "/onboarding/review/decision",
        json={"token": review_token, "decision": "reject"},
        headers=auth_header(outsider_token),
    )
    assert outsider_attempt.status_code == 403

    unauthenticated_attempt = client.post(
        "/onboarding/review/decision",
        json={"token": review_token, "decision": "reject"},
    )
    assert unauthenticated_attempt.status_code == 401

    audit_events = get_audit_log_store().list_events("onboarding", limit=20)
    assert any(event.action == "onboarding.registration.submitted" for event in audit_events)
