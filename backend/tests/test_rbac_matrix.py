"""RBAC enforcement matrix — Endpoint x Role -> allow/deny (Alpha playbook Step 2.1).

This is the security lock for role-based access control across the whole backend.
Every protected endpoint is enumerated with the set of roles allowed to reach it
(per README "Protected endpoints" + backend/auth.py). The parametrized matrix then
asserts that:

  * every DISALLOWED role gets 403 on every protected endpoint, and
  * unauthenticated requests get 401,

with a handful of positive controls proving allowed roles are not blanket-denied.

A separate block of object-level (IDOR) tests proves a Driver can only ever touch
their OWN orders / POD / route, and that no user can reach another org's records by
id. require_roles() runs as a dependency before request-body validation, so the
deny assertions hold regardless of body contents.

Role summary: Admin = full access incl. billing/org; Dispatcher = orders / dispatch
/ reports (NO billing/org); Driver = own inbox / status / location / POD only.
"""

import base64
import json
import os
import sys
from collections import namedtuple

import pytest
from fastapi.testclient import TestClient

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "../..")))

from backend.app import app
from backend.audit_store import reset_in_memory_audit_log_store
from backend.geocode_service import reset_in_memory_address_geocoder
from backend.location_service import reset_in_memory_driver_location_store
from backend.order_store import reset_in_memory_order_store

client = TestClient(app)

ROLES = ["Admin", "Dispatcher", "Driver"]


def make_token(sub: str, org_id: str, groups, email: str = "user@example.com"):
    payload = {
        "sub": sub,
        "custom:org_id": org_id,
        "cognito:groups": groups,
        "cognito:username": sub,
        "email": email,
    }
    header = base64.urlsafe_b64encode(json.dumps({"alg": "none"}).encode()).rstrip(b"=")
    body = base64.urlsafe_b64encode(json.dumps(payload).encode()).rstrip(b"=")
    return f"{header.decode()}.{body.decode()}."


def token_for_role(role: str, org_id: str = "org-rbac") -> str:
    return make_token(f"user-{role.lower()}", org_id, [role])


def auth(token: str) -> dict:
    return {"Authorization": f"Bearer {token}"}


@pytest.fixture(autouse=True)
def _test_env(monkeypatch):
    monkeypatch.setenv("JWT_VERIFY_SIGNATURE", "false")
    monkeypatch.setenv("USE_IN_MEMORY_IDENTITY_STORE", "true")
    monkeypatch.setenv("USE_IN_MEMORY_ORDER_STORE", "true")
    monkeypatch.setenv("USE_IN_MEMORY_AUDIT_LOG_STORE", "true")
    monkeypatch.setenv("USE_IN_MEMORY_BILLING_STORE", "true")
    monkeypatch.setenv("USE_IN_MEMORY_POD_STORE", "true")
    monkeypatch.setenv("USE_IN_MEMORY_EMAIL_STORE", "true")
    monkeypatch.setenv("USE_IN_MEMORY_DRIVER_LOCATION_STORE", "true")
    monkeypatch.setenv("USE_IN_MEMORY_ROUTE_MATRIX", "true")
    monkeypatch.setenv("USE_IN_MEMORY_GEOCODER", "true")
    reset_in_memory_order_store()
    reset_in_memory_audit_log_store()
    reset_in_memory_driver_location_store()
    reset_in_memory_address_geocoder()


ORDER_BODY = {
    "customer_name": "RBAC Co",
    "reference_id": "RBAC-1",
    "pick_up_street": "1 Warehouse Way",
    "pick_up_city": "Town",
    "pick_up_state": "TS",
    "pick_up_zip": "00000",
    "delivery_street": "2 Dropoff Rd",
    "delivery_city": "City",
    "delivery_state": "DS",
    "delivery_zip": "99999",
    "dimensions": "10x10x10 in",
    "weight": 5.0,
    "num_packages": 1,
}

EP = namedtuple("EP", "id method path kwargs allowed")

# Every role-gated endpoint in the backend, paired with the roles allowed to reach
# the handler at the role-check layer. Endpoints allowed to all three roles carry an
# additional object-level guard (own-order / assigned-driver / approver) that the
# IDOR tests below exercise; they generate no deny rows here by design.
ENDPOINTS = [
    # identity
    EP("users_list", "GET", "/users", {}, {"Admin", "Dispatcher"}),
    EP("orgs_update", "PUT", "/orgs/me", {"json": {"name": "Org X"}}, {"Admin"}),
    EP("audit_logs", "GET", "/audit/logs", {}, {"Admin", "Dispatcher"}),
    # orders
    EP("orders_create", "POST", "/orders/", {"json": ORDER_BODY}, {"Admin", "Dispatcher"}),
    EP("orders_list", "GET", "/orders/", {}, {"Admin", "Dispatcher"}),
    EP("orders_assign", "POST", "/orders/abc/assign", {"json": {"driver_id": "d"}}, {"Admin", "Dispatcher"}),
    EP("orders_unassign", "POST", "/orders/abc/unassign", {}, {"Admin", "Dispatcher"}),
    EP("orders_bulk_assign", "POST", "/orders/bulk-assign", {"json": {"order_ids": ["x"], "driver_id": "d"}}, {"Admin", "Dispatcher"}),
    EP("orders_bulk_unassign", "POST", "/orders/bulk-unassign", {"json": {"order_ids": ["x"]}}, {"Admin", "Dispatcher"}),
    EP("orders_update", "PUT", "/orders/abc", {"json": {"customer_name": "Y"}}, {"Admin", "Dispatcher"}),
    EP("orders_status", "POST", "/orders/abc/status", {"json": {"status": "Assigned"}}, {"Admin", "Dispatcher", "Driver"}),
    EP("orders_driver_inbox", "GET", "/orders/driver/inbox", {}, {"Admin", "Dispatcher", "Driver"}),
    EP("orders_get", "GET", "/orders/abc", {}, {"Admin", "Dispatcher", "Driver"}),
    # pod
    EP("pod_presign", "POST", "/pod/presign", {"json": {"order_id": "abc", "artifacts": [{"artifact_type": "photo", "content_type": "image/jpeg", "file_size_bytes": 1024}]}}, {"Admin", "Dispatcher", "Driver"}),
    EP("pod_metadata", "POST", "/pod/metadata", {"json": {"order_id": "abc", "photo_keys": ["k"]}}, {"Admin", "Dispatcher", "Driver"}),
    EP("pod_list_for_order", "GET", "/pod/order/abc", {}, {"Admin", "Dispatcher"}),
    # drivers
    EP("drivers_location", "POST", "/drivers/location", {"json": {"lat": 1.0, "lng": 2.0}}, {"Admin", "Dispatcher", "Driver"}),
    EP("drivers_list", "GET", "/drivers", {}, {"Admin", "Dispatcher"}),
    EP("drivers_roster", "GET", "/drivers/roster", {}, {"Admin", "Dispatcher"}),
    # routes
    EP("routes_optimize", "POST", "/routes/optimize", {"json": {"driver_id": "d", "stops": [{"order_id": "o", "lat": 1, "lng": 1}]}}, {"Admin", "Dispatcher", "Driver"}),
    EP("routes_directions", "POST", "/routes/directions", {"json": {"driver_id": "d", "stops": [{"order_id": "o", "lat": 1, "lng": 1}]}}, {"Admin", "Dispatcher", "Driver"}),
    EP("routes_navigate", "POST", "/routes/navigate", {"json": {"start_lat": 1, "start_lng": 1, "dest_lat": 2, "dest_lng": 2}}, {"Admin", "Dispatcher", "Driver"}),
    # reports
    EP("reports_summary", "GET", "/reports/dispatch-summary", {}, {"Admin", "Dispatcher"}),
    # billing (Admin only)
    EP("billing_summary", "GET", "/billing/summary", {}, {"Admin"}),
    EP("billing_status", "GET", "/billing/status", {}, {"Admin"}),
    EP("billing_seats", "POST", "/billing/seats", {"json": {"dispatcher_seat_limit": 1}}, {"Admin"}),
    EP("billing_checkout", "POST", "/billing/checkout", {"json": {"dispatcher_seat_limit": 1, "success_url": "https://x", "cancel_url": "https://y"}}, {"Admin"}),
    EP("billing_portal", "POST", "/billing/portal", {"json": {"return_url": "https://x"}}, {"Admin"}),
    EP("billing_invitations_list", "GET", "/billing/invitations", {}, {"Admin"}),
    EP("billing_invitations_create", "POST", "/billing/invitations", {"json": {"email": "a@b.com", "role": "Driver"}}, {"Admin"}),
    EP("billing_invitation_activate", "POST", "/billing/invitations/abc/activate", {}, {"Admin"}),
    EP("billing_invitation_cancel", "POST", "/billing/invitations/abc/cancel", {}, {"Admin"}),
    # push
    EP("push_subscribe", "POST", "/push/subscribe", {"json": {"endpoint": "https://e", "p256dh": "p", "auth": "a"}}, {"Admin", "Dispatcher", "Driver"}),
    # email
    EP("email_connect", "POST", "/email/connect", {"json": {"code": "x", "redirect_uri": "https://x"}}, {"Admin"}),
    EP("email_disconnect", "POST", "/email/disconnect", {}, {"Admin"}),
    EP("email_status", "GET", "/email/status", {}, {"Admin", "Dispatcher"}),
    EP("email_skipped", "GET", "/email/skipped", {}, {"Admin", "Dispatcher"}),
    EP("email_skipped_elevate", "POST", "/email/skipped/abc/elevate", {"json": {}}, {"Admin", "Dispatcher"}),
    EP("email_rules_list", "GET", "/email/rules", {}, {"Admin"}),
    EP("email_rules_create", "POST", "/email/rules", {"json": {"name": "r", "sender_pattern": "x.com", "parser_type": "email-ai"}}, {"Admin"}),
    EP("email_rules_update", "PUT", "/email/rules/abc", {"json": {"enabled": False}}, {"Admin"}),
    EP("email_rules_delete", "DELETE", "/email/rules/abc", {}, {"Admin"}),
    EP("email_detect_format", "POST", "/email/rules/detect-format", {"data": {"text": "hello"}}, {"Admin"}),
    # simulator (Admin/Dispatcher + username allowlist; deny path is role-only)
    EP("sim_spawn", "POST", "/admin/simulator/spawn", {"json": {"count": 1}}, {"Admin", "Dispatcher"}),
    EP("sim_stop", "POST", "/admin/simulator/stop", {}, {"Admin", "Dispatcher"}),
    EP("sim_status", "GET", "/admin/simulator/status", {}, {"Admin", "Dispatcher"}),
    EP("sim_seed", "POST", "/admin/simulator/seed-orders", {"json": {"count": 1}}, {"Admin", "Dispatcher"}),
]


_DENY_CASES = [
    pytest.param(ep, role, id=f"{ep.id}-{role}")
    for ep in ENDPOINTS
    for role in ROLES
    if role not in ep.allowed
]


@pytest.mark.parametrize("ep,role", _DENY_CASES)
def test_disallowed_role_is_forbidden(ep, role):
    """Every role not in an endpoint's allow-set must be rejected with 403."""
    resp = client.request(ep.method, ep.path, headers=auth(token_for_role(role)), **ep.kwargs)
    assert resp.status_code == 403, (
        f"{role} on {ep.method} {ep.path} expected 403, got {resp.status_code}: {resp.text}"
    )


@pytest.mark.parametrize("ep", ENDPOINTS, ids=[ep.id for ep in ENDPOINTS])
def test_unauthenticated_is_rejected(ep):
    """Every protected endpoint requires authentication (401 with no token)."""
    resp = client.request(ep.method, ep.path, **ep.kwargs)
    assert resp.status_code == 401, (
        f"unauthenticated {ep.method} {ep.path} expected 401, got {resp.status_code}: {resp.text}"
    )


# Positive controls: a representative allowed role reaches each of these (no network,
# in-memory stores), proving the matrix is not blanket-denying every request.
_ALLOW_CONTROLS = [
    ("Admin", "GET", "/users"),
    ("Dispatcher", "GET", "/audit/logs"),
    ("Admin", "GET", "/orders/"),
    ("Dispatcher", "GET", "/reports/dispatch-summary"),
    ("Admin", "GET", "/billing/summary"),
    ("Admin", "GET", "/billing/invitations"),
    ("Dispatcher", "GET", "/email/status"),
    ("Admin", "GET", "/drivers"),
    ("Admin", "GET", "/drivers/roster"),
]


@pytest.mark.parametrize("role,method,path", _ALLOW_CONTROLS, ids=[f"{r}-{p}" for r, _, p in _ALLOW_CONTROLS])
def test_allowed_role_is_permitted(role, method, path):
    resp = client.request(method, path, headers=auth(token_for_role(role)))
    assert resp.status_code == 200, f"{role} on {method} {path} expected 200, got {resp.status_code}: {resp.text}"


# ── Object-level authorization (IDOR) ──────────────────────────────────────────


def _create_order(token: str, reference_id: str = "ID-1", delivery_street: str = "100 Main St") -> str:
    resp = client.post(
        "/orders/",
        json={**ORDER_BODY, "reference_id": reference_id, "delivery_street": delivery_street},
        headers=auth(token),
    )
    assert resp.status_code == 200, resp.text
    return resp.json()["id"]


def _assign(token: str, order_id: str, driver_id: str) -> None:
    resp = client.post(f"/orders/{order_id}/assign", json={"driver_id": driver_id}, headers=auth(token))
    assert resp.status_code == 200, resp.text


def test_cross_org_order_read_returns_404():
    order_id = _create_order(make_token("admin-a", "org-a", ["Admin"]))
    resp = client.get(f"/orders/{order_id}", headers=auth(make_token("admin-b", "org-b", ["Admin"])))
    assert resp.status_code == 404


def test_cross_org_order_status_update_returns_404():
    order_id = _create_order(make_token("admin-a", "org-a", ["Admin"]))
    resp = client.post(
        f"/orders/{order_id}/status",
        json={"status": "Assigned"},
        headers=auth(make_token("dispatcher-b", "org-b", ["Dispatcher"])),
    )
    assert resp.status_code == 404


def test_cross_org_pod_list_returns_404():
    order_id = _create_order(make_token("admin-a", "org-a", ["Admin"]))
    resp = client.get(f"/pod/order/{order_id}", headers=auth(make_token("admin-b", "org-b", ["Admin"])))
    assert resp.status_code == 404


def test_assigned_driver_can_read_own_order():
    admin = make_token("admin-1", "org-1", ["Admin"])
    order_id = _create_order(admin)
    _assign(admin, order_id, "user-driver")  # driver sub used by token_for_role("Driver")
    resp = client.get(f"/orders/{order_id}", headers=auth(token_for_role("Driver", "org-1")))
    assert resp.status_code == 200
    assert resp.json()["id"] == order_id


def test_cross_driver_order_read_returns_404():
    admin = make_token("admin-1", "org-1", ["Admin"])
    order_id = _create_order(admin)
    _assign(admin, order_id, "driver-1")
    resp = client.get(f"/orders/{order_id}", headers=auth(make_token("driver-2", "org-1", ["Driver"])))
    assert resp.status_code == 404


def test_cross_driver_order_status_update_forbidden():
    admin = make_token("admin-1", "org-1", ["Admin"])
    order_id = _create_order(admin)
    _assign(admin, order_id, "driver-1")
    resp = client.post(
        f"/orders/{order_id}/status",
        json={"status": "EnRoute"},
        headers=auth(make_token("driver-2", "org-1", ["Driver"])),
    )
    assert resp.status_code == 403


def test_cross_driver_pod_presign_forbidden():
    admin = make_token("admin-1", "org-1", ["Admin"])
    order_id = _create_order(admin)
    _assign(admin, order_id, "driver-1")
    resp = client.post(
        "/pod/presign",
        json={"order_id": order_id, "artifacts": [{"artifact_type": "photo", "content_type": "image/jpeg", "file_size_bytes": 1024}]},
        headers=auth(make_token("driver-2", "org-1", ["Driver"])),
    )
    assert resp.status_code == 403


def test_cross_driver_pod_metadata_forbidden():
    admin = make_token("admin-1", "org-1", ["Admin"])
    order_id = _create_order(admin)
    _assign(admin, order_id, "driver-1")
    resp = client.post(
        "/pod/metadata",
        json={"order_id": order_id, "photo_keys": [f"pod/org-1/{order_id}/driver-1/x.jpg"]},
        headers=auth(make_token("driver-2", "org-1", ["Driver"])),
    )
    assert resp.status_code == 403


def test_driver_cannot_optimize_another_drivers_route():
    resp = client.post(
        "/routes/optimize",
        json={"driver_id": "driver-1"},
        headers=auth(make_token("driver-2", "org-1", ["Driver"])),
    )
    assert resp.status_code == 403


def test_driver_cannot_get_directions_for_another_driver():
    resp = client.post(
        "/routes/directions",
        json={"driver_id": "driver-1"},
        headers=auth(make_token("driver-2", "org-1", ["Driver"])),
    )
    assert resp.status_code == 403


def test_driver_can_optimize_own_route():
    resp = client.post(
        "/routes/optimize",
        json={"driver_id": "driver-2", "stops": [{"order_id": "o1", "lat": 1, "lng": 1}]},
        headers=auth(make_token("driver-2", "org-1", ["Driver"])),
    )
    assert resp.status_code == 200


def test_dispatcher_can_optimize_any_driver_route():
    """Privileged roles retain cross-driver planning (regression guard for the fix)."""
    resp = client.post(
        "/routes/optimize",
        json={"driver_id": "driver-99", "stops": [{"order_id": "o1", "lat": 1, "lng": 1}]},
        headers=auth(make_token("dispatcher-1", "org-1", ["Dispatcher"])),
    )
    assert resp.status_code == 200
