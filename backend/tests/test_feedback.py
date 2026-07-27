"""In-app pilot feedback (Step 6.3).

Covers the submit/list contract, the RBAC split (everyone submits, only
Admin/Dispatcher reads), tenant isolation, ordering, and input bounds.
"""
import base64
import json
import os
import sys

import pytest
from fastapi.testclient import TestClient

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "../..")))

from backend.app import app  # noqa: E402
from backend.feedback_store import (  # noqa: E402
    MAX_MESSAGE_CHARS,
    new_feedback_id,
    reset_in_memory_feedback_store,
)


def make_token(sub: str, org_id: str, groups):
    payload = {"sub": sub, "custom:org_id": org_id, "cognito:groups": groups}
    header = base64.urlsafe_b64encode(json.dumps({"alg": "none"}).encode()).rstrip(b"=")
    body = base64.urlsafe_b64encode(json.dumps(payload).encode()).rstrip(b"=")
    return f"{header.decode()}.{body.decode()}."


def auth_headers(role: str, org_id: str = "org-1"):
    token = make_token(sub=f"user-{role.lower()}", org_id=org_id, groups=[role])
    return {"Authorization": f"Bearer {token}"}


@pytest.fixture(autouse=True)
def _clean_store():
    reset_in_memory_feedback_store()
    yield
    reset_in_memory_feedback_store()


@pytest.fixture
def client():
    return TestClient(app)


def _submit(client, role="Driver", org="org-1", **payload):
    body = {"message": "the assign button is confusing"}
    body.update(payload)
    return client.post("/feedback", json=body, headers=auth_headers(role=role, org_id=org))


def _assert_status(resp, expected):
    """Assert status, but put the response body in the message.

    A bare `assert resp.status_code == 200` reports "assert 500 == 200" and nothing
    about why — useless when the failure only reproduces in CI.
    """
    assert resp.status_code == expected, (
        f"expected {expected}, got {resp.status_code}; body={resp.text[:800]!r}"
    )


# --- submit -----------------------------------------------------------------

@pytest.mark.parametrize("role", ["Admin", "Dispatcher", "Driver"])
def test_any_signed_in_role_can_submit(client, role):
    resp = _submit(client, role=role)
    _assert_status(resp, 200)
    assert resp.json()["ok"] is True
    assert resp.json()["feedback_id"]


def test_submit_requires_authentication(client):
    resp = client.post("/feedback", json={"message": "hi"})
    assert resp.status_code == 401


def test_submit_captures_context_and_identity(client):
    resp = _submit(
        client,
        role="Driver",
        category="bug",
        surface="driver-pwa",
        page="/backend/ui/driver",
        app_version="20260726",
    )
    _assert_status(resp, 200)

    listed = client.get("/feedback", headers=auth_headers(role="Admin", org_id="org-1")).json()
    assert len(listed) == 1
    row = listed[0]
    assert row["category"] == "bug"
    assert row["surface"] == "driver-pwa"
    assert row["page"] == "/backend/ui/driver"
    assert row["app_version"] == "20260726"
    assert row["submitted_by"]
    assert "Driver" in row["submitted_by_roles"]
    # user_agent is captured from the request, not the body
    assert "user_agent" in row


def test_unknown_category_falls_back_to_general(client):
    _submit(client, category="../../etc/passwd")
    listed = client.get("/feedback", headers=auth_headers(role="Admin", org_id="org-1")).json()
    assert listed[0]["category"] == "general"


def test_empty_message_rejected(client):
    resp = _submit(client, message="")
    assert resp.status_code == 422


def test_oversized_message_rejected(client):
    resp = _submit(client, message="x" * (MAX_MESSAGE_CHARS + 1))
    assert resp.status_code == 422


def test_org_id_comes_from_token_not_body(client):
    """A tester must not be able to file feedback into someone else's tenant."""
    resp = _submit(client, role="Driver", org="org-1", org_id="org-victim")
    assert resp.status_code == 200

    victim = client.get("/feedback", headers=auth_headers(role="Admin", org_id="org-victim"))
    assert victim.json() == []
    mine = client.get("/feedback", headers=auth_headers(role="Admin", org_id="org-1"))
    assert len(mine.json()) == 1


# --- list -------------------------------------------------------------------

@pytest.mark.parametrize("role", ["Admin", "Dispatcher"])
def test_admin_and_dispatcher_can_list(client, role):
    _submit(client)
    resp = client.get("/feedback", headers=auth_headers(role=role, org_id="org-1"))
    _assert_status(resp, 200)
    assert len(resp.json()) == 1


def test_driver_cannot_list_feedback(client):
    """A driver reading every colleague's complaints is a privacy problem."""
    _submit(client)
    resp = client.get("/feedback", headers=auth_headers(role="Driver", org_id="org-1"))
    assert resp.status_code == 403


def test_list_requires_authentication(client):
    assert client.get("/feedback").status_code == 401


def test_list_is_tenant_isolated(client):
    _submit(client, org="org-1", message="from org one")
    _submit(client, org="org-2", message="from org two")

    org1 = client.get("/feedback", headers=auth_headers(role="Admin", org_id="org-1")).json()
    assert [r["message"] for r in org1] == ["from org one"]

    org2 = client.get("/feedback", headers=auth_headers(role="Admin", org_id="org-2")).json()
    assert [r["message"] for r in org2] == ["from org two"]


def test_list_is_newest_first(client):
    for i in range(3):
        _submit(client, message=f"note {i}")
    listed = client.get("/feedback", headers=auth_headers(role="Admin", org_id="org-1")).json()
    assert [r["message"] for r in listed] == ["note 2", "note 1", "note 0"]


def test_list_limit_is_bounded(client):
    for i in range(5):
        _submit(client, message=f"note {i}")
    assert len(client.get("/feedback?limit=2", headers=auth_headers(role="Admin", org_id="org-1")).json()) == 2
    # out-of-range limits are rejected by validation rather than silently clamped
    assert client.get("/feedback?limit=0", headers=auth_headers(role="Admin", org_id="org-1")).status_code == 422
    assert client.get("/feedback?limit=5000", headers=auth_headers(role="Admin", org_id="org-1")).status_code == 422


# --- id generation ----------------------------------------------------------

def test_feedback_ids_sort_chronologically():
    from datetime import datetime, timedelta, timezone

    base = datetime(2026, 7, 26, 12, 0, 0, tzinfo=timezone.utc)
    ids = [new_feedback_id(base + timedelta(milliseconds=i)) for i in range(5)]
    assert ids == sorted(ids), "timestamp prefix must make lexicographic order == chronological"


def test_feedback_ids_are_unique_within_a_millisecond():
    from datetime import datetime, timezone

    moment = datetime(2026, 7, 26, 12, 0, 0, tzinfo=timezone.utc)
    ids = {new_feedback_id(moment) for _ in range(50)}
    assert len(ids) == 50
