"""Tests for the /email/rules CRUD endpoints."""

import base64
import json
import os
import sys
from datetime import datetime, timezone

import pytest
from fastapi.testclient import TestClient

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "../..")))

from backend.app import app
from backend.email_store import reset_in_memory_email_config_store
from backend.schemas import EmailConfig

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


ADMIN_TOKEN = make_token("admin-a", "org-a", ["Admin"])
DISPATCHER_TOKEN = make_token("disp-a", "org-a", ["Dispatcher"])
ADMIN_B_TOKEN = make_token("admin-b", "org-b", ["Admin"])

AUTH = {"Authorization": f"Bearer {ADMIN_TOKEN}"}
AUTH_DISP = {"Authorization": f"Bearer {DISPATCHER_TOKEN}"}
AUTH_B = {"Authorization": f"Bearer {ADMIN_B_TOKEN}"}


def _seed_connected_config(org_id: str = "org-a"):
    """Put a connected EmailConfig into the in-memory store for the given org."""
    from backend.email_store import get_email_config_store

    store = get_email_config_store()
    config = EmailConfig(
        org_id=org_id,
        gmail_email="test@example.com",
        gmail_refresh_token="tok",
        email_connected=True,
        connected_at=datetime.now(timezone.utc),
    )
    store.put_config(config)


@pytest.fixture(autouse=True)
def _test_env(monkeypatch):
    monkeypatch.setenv("JWT_VERIFY_SIGNATURE", "false")
    monkeypatch.setenv("USE_IN_MEMORY_EMAIL_STORE", "true")
    reset_in_memory_email_config_store()


# --- GET /email/rules ---

def test_list_rules_empty_when_no_config():
    resp = client.get("/email/rules", headers=AUTH)
    # No EmailConfig exists → returns empty list (config defaults)
    assert resp.status_code == 200
    data = resp.json()
    assert data["items"] == []
    assert isinstance(data["available_parsers"], list)
    assert len(data["available_parsers"]) > 0


def test_list_rules_returns_existing_rules():
    _seed_connected_config()
    # Create a rule first
    client.post("/email/rules", headers=AUTH, json={
        "name": "Vel Logistix",
        "sender_pattern": "vellogistix.com",
        "subject_pattern": "",
        "parser_type": "email-airspace",
    })
    resp = client.get("/email/rules", headers=AUTH)
    assert resp.status_code == 200
    assert len(resp.json()["items"]) == 1


def test_list_rules_requires_admin():
    resp = client.get("/email/rules", headers=AUTH_DISP)
    assert resp.status_code == 403


# --- POST /email/rules ---

def test_create_rule_success():
    _seed_connected_config()
    resp = client.post("/email/rules", headers=AUTH, json={
        "name": "Vel Logistix Airspace",
        "sender_pattern": "vellogistix.com",
        "subject_pattern": "dispatch",
        "parser_type": "email-airspace",
        "enabled": True,
    })
    assert resp.status_code == 201
    data = resp.json()
    assert data["name"] == "Vel Logistix Airspace"
    assert data["sender_pattern"] == "vellogistix.com"
    assert data["parser_type"] == "email-airspace"
    assert data["enabled"] is True
    assert "rule_id" in data
    assert "created_at" in data
    assert "updated_at" in data


def test_create_rule_no_email_config():
    resp = client.post("/email/rules", headers=AUTH, json={
        "name": "Test",
        "sender_pattern": "example.com",
        "parser_type": "email-airspace",
    })
    assert resp.status_code == 404


def test_create_rule_invalid_parser_type():
    _seed_connected_config()
    resp = client.post("/email/rules", headers=AUTH, json={
        "name": "Bad Parser",
        "sender_pattern": "example.com",
        "parser_type": "email-nonexistent",
    })
    assert resp.status_code == 400
    assert "parser_type" in resp.json()["detail"]


def test_create_rule_invalid_sender_pattern():
    _seed_connected_config()
    resp = client.post("/email/rules", headers=AUTH, json={
        "name": "Bad Sender",
        "sender_pattern": "nodotnoat",
        "parser_type": "email-airspace",
    })
    assert resp.status_code == 400


def test_create_rule_requires_admin():
    resp = client.post("/email/rules", headers=AUTH_DISP, json={
        "name": "Test",
        "sender_pattern": "example.com",
        "parser_type": "email-airspace",
    })
    assert resp.status_code == 403


def test_create_rule_tenant_isolation():
    """Rules created for org-a should not appear for org-b."""
    _seed_connected_config("org-a")
    _seed_connected_config("org-b")
    client.post("/email/rules", headers=AUTH, json={
        "name": "Org A Rule",
        "sender_pattern": "example.com",
        "parser_type": "email-airspace",
    })
    resp = client.get("/email/rules", headers=AUTH_B)
    assert resp.status_code == 200
    assert resp.json()["items"] == []


# --- PUT /email/rules/{rule_id} ---

def _create_rule(name="Test Rule", sender="example.com", parser="email-airspace"):
    _seed_connected_config()
    resp = client.post("/email/rules", headers=AUTH, json={
        "name": name,
        "sender_pattern": sender,
        "parser_type": parser,
    })
    return resp.json()["rule_id"]


def test_update_rule_name():
    rule_id = _create_rule()
    resp = client.put(f"/email/rules/{rule_id}", headers=AUTH, json={"name": "Updated Name"})
    assert resp.status_code == 200
    assert resp.json()["name"] == "Updated Name"
    assert resp.json()["sender_pattern"] == "example.com"  # unchanged


def test_update_rule_toggle_enabled():
    rule_id = _create_rule()
    resp = client.put(f"/email/rules/{rule_id}", headers=AUTH, json={"enabled": False})
    assert resp.status_code == 200
    assert resp.json()["enabled"] is False


def test_update_rule_not_found():
    _seed_connected_config()
    resp = client.put("/email/rules/nonexistent-id", headers=AUTH, json={"name": "X"})
    assert resp.status_code == 404


def test_update_rule_invalid_parser_type():
    rule_id = _create_rule()
    resp = client.put(f"/email/rules/{rule_id}", headers=AUTH, json={"parser_type": "email-fake"})
    assert resp.status_code == 400


def test_update_rule_requires_admin():
    _seed_connected_config()
    resp = client.put("/email/rules/some-id", headers=AUTH_DISP, json={"name": "X"})
    assert resp.status_code == 403


# --- DELETE /email/rules/{rule_id} ---

def test_delete_rule_success():
    rule_id = _create_rule()
    resp = client.delete(f"/email/rules/{rule_id}", headers=AUTH)
    assert resp.status_code == 204

    # Verify it's gone
    list_resp = client.get("/email/rules", headers=AUTH)
    assert list_resp.json()["items"] == []


def test_delete_rule_not_found():
    _seed_connected_config()
    resp = client.delete("/email/rules/nonexistent-id", headers=AUTH)
    assert resp.status_code == 404


def test_delete_rule_requires_admin():
    resp = client.delete("/email/rules/some-id", headers=AUTH_DISP)
    assert resp.status_code == 403


def test_delete_rule_no_email_config():
    resp = client.delete("/email/rules/some-id", headers=AUTH)
    assert resp.status_code == 404


# --- CRUD lifecycle ---

def test_full_crud_lifecycle():
    _seed_connected_config()

    # Create
    create_resp = client.post("/email/rules", headers=AUTH, json={
        "name": "Lifecycle Rule",
        "sender_pattern": "lifecycle.com",
        "subject_pattern": "order",
        "parser_type": "email-airspace",
        "enabled": True,
    })
    assert create_resp.status_code == 201
    rule_id = create_resp.json()["rule_id"]

    # Read
    list_resp = client.get("/email/rules", headers=AUTH)
    assert len(list_resp.json()["items"]) == 1

    # Update
    update_resp = client.put(f"/email/rules/{rule_id}", headers=AUTH, json={
        "name": "Updated Lifecycle",
        "enabled": False,
    })
    assert update_resp.status_code == 200
    assert update_resp.json()["name"] == "Updated Lifecycle"
    assert update_resp.json()["enabled"] is False

    # Delete
    del_resp = client.delete(f"/email/rules/{rule_id}", headers=AUTH)
    assert del_resp.status_code == 204

    # Confirm deletion
    final_resp = client.get("/email/rules", headers=AUTH)
    assert final_resp.json()["items"] == []
