"""HTTP security headers are present on every response (security backlog S-1).

Locks the clickjacking / MIME-sniffing / referrer-leak protections added in
`app.py` so they can't silently regress. HSTS is only advertised over HTTPS.
"""

import os
import sys

import pytest
from fastapi.testclient import TestClient

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "../..")))

from backend.app import app

client = TestClient(app)

_BASELINE = {
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY",
    "referrer-policy": "strict-origin-when-cross-origin",
}


def _assert_baseline(headers):
    for name, expected in _BASELINE.items():
        assert headers.get(name) == expected, f"{name} expected {expected!r}, got {headers.get(name)!r}"
    csp = headers.get("content-security-policy", "")
    assert "frame-ancestors 'none'" in csp, f"CSP missing frame-ancestors: {csp!r}"


def test_security_headers_on_ui_html():
    resp = client.get("/ui/admin")
    assert resp.status_code == 200
    _assert_baseline(resp.headers)


def test_security_headers_on_driver_ui():
    resp = client.get("/backend/ui/driver")
    assert resp.status_code == 200
    _assert_baseline(resp.headers)


def test_security_headers_on_static_asset():
    # StaticFiles mounts are wrapped by the middleware too.
    resp = client.get("/ui/assets/admin.js")
    assert resp.status_code == 200
    _assert_baseline(resp.headers)


def test_security_headers_on_api_json():
    resp = client.get("/health")
    assert resp.status_code == 200
    _assert_baseline(resp.headers)


def test_security_headers_on_error_response():
    # 404s flow through the middleware and must still carry the headers.
    resp = client.get("/no-such-route-xyz")
    assert resp.status_code == 404
    _assert_baseline(resp.headers)


def test_hsts_absent_over_plain_http(monkeypatch):
    monkeypatch.delenv("FORCE_SECURE_COOKIES", raising=False)
    resp = client.get("/health")  # TestClient default scheme is http
    assert resp.status_code == 200
    assert "strict-transport-security" not in {k.lower() for k in resp.headers.keys()}


def test_hsts_present_when_secure(monkeypatch):
    monkeypatch.setenv("FORCE_SECURE_COOKIES", "true")
    resp = client.get("/health")
    assert resp.status_code == 200
    hsts = resp.headers.get("strict-transport-security")
    assert hsts is not None and "max-age=" in hsts
