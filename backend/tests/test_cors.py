"""CORS origin allowlist (security backlog S-2).

The web consoles call the API same-origin, so this list only governs genuine
cross-origin browsers. Default is local-dev origins with NO wildcard; the
deployed origin(s) come from the CorsAllowedOrigins stack parameter via
CORS_ALLOWED_ORIGINS. Locks: no wildcard by default, unknown origins blocked,
configured origins honored, explicit "*" still available as an opt-in.
"""

import os
import sys

from fastapi.testclient import TestClient

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "../..")))

from backend.app import create_app

EVIL = "https://evil.example.com"


def _client(monkeypatch, origins_env=None):
    if origins_env is None:
        monkeypatch.delenv("CORS_ALLOWED_ORIGINS", raising=False)
    else:
        monkeypatch.setenv("CORS_ALLOWED_ORIGINS", origins_env)
    return TestClient(create_app())


def _acao(resp):
    return resp.headers.get("access-control-allow-origin")


def test_default_cors_has_no_wildcard_and_blocks_unknown_origin(monkeypatch):
    client = _client(monkeypatch)
    resp = client.get("/health", headers={"Origin": EVIL})
    assert resp.status_code == 200
    assert _acao(resp) != "*"
    assert _acao(resp) != EVIL  # unknown origin must not be reflected


def test_default_cors_allows_localhost_dev_origin(monkeypatch):
    client = _client(monkeypatch)
    resp = client.get("/health", headers={"Origin": "http://127.0.0.1:8000"})
    assert resp.status_code == 200
    assert _acao(resp) == "http://127.0.0.1:8000"


def test_configured_origins_allow_and_block(monkeypatch):
    client = _client(monkeypatch, "https://app.example.com")
    allowed = client.get("/health", headers={"Origin": "https://app.example.com"})
    assert _acao(allowed) == "https://app.example.com"
    blocked = client.get("/health", headers={"Origin": EVIL})
    assert _acao(blocked) != EVIL
    assert _acao(blocked) != "*"


def test_preflight_from_unknown_origin_is_not_allowed(monkeypatch):
    client = _client(monkeypatch, "https://app.example.com")
    resp = client.options(
        "/orders/",
        headers={
            "Origin": EVIL,
            "Access-Control-Request-Method": "POST",
            "Access-Control-Request-Headers": "authorization,content-type",
        },
    )
    assert _acao(resp) != EVIL
    assert _acao(resp) != "*"


def test_explicit_wildcard_opt_in_is_honored(monkeypatch):
    client = _client(monkeypatch, "*")
    resp = client.get("/health", headers={"Origin": EVIL})
    assert _acao(resp) == "*"
