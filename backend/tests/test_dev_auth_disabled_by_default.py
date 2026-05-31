"""Guards that UI dev-auth (credential-free role sign-in) can never be ON by accident.

Dev-auth lets anyone mint an Admin/Dispatcher/Driver session cookie with no
credentials (POST /backend/ui/dev-auth/login). It is a manual-testing convenience
and MUST be opt-in. Two independent layers must both fail safe:

  1. The application: is_dev_auth_enabled() defaults False when ENABLE_UI_DEV_AUTH
     is unset, and the dev-auth endpoints 404 in that state.
  2. The SAM template: the EnableUiDevAuth parameter defaults to "false", so a
     deploy that doesn't explicitly opt in does not ship an auth bypass.

Regression test for ledger issue A-6 (template previously defaulted "true").
"""
import os
import re
import sys
from pathlib import Path

from fastapi.testclient import TestClient

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "../..")))

from backend.auth import is_dev_auth_enabled


def _client_with_env(monkeypatch, value=None):
    if value is None:
        monkeypatch.delenv("ENABLE_UI_DEV_AUTH", raising=False)
    else:
        monkeypatch.setenv("ENABLE_UI_DEV_AUTH", value)
    # Import the app fresh-ish; create_app reads env at request time for dev-auth.
    from backend.app import app
    return TestClient(app)


def test_app_dev_auth_disabled_when_env_unset(monkeypatch):
    monkeypatch.delenv("ENABLE_UI_DEV_AUTH", raising=False)
    assert is_dev_auth_enabled() is False


def test_dev_auth_login_404s_when_disabled(monkeypatch):
    client = _client_with_env(monkeypatch, value=None)
    resp = client.post("/backend/ui/dev-auth/login", json={"role": "Admin"})
    # Disabled dev-auth must not mint a session; endpoint reports not-found.
    assert resp.status_code == 404
    assert "set-cookie" not in {k.lower() for k in resp.headers}


def test_ui_config_hides_dev_profiles_when_disabled(monkeypatch):
    client = _client_with_env(monkeypatch, value=None)
    cfg = client.get("/backend/ui/config").json()
    assert cfg["dev_auth_enabled"] is False
    assert cfg["dev_auth_profiles"] == []


def test_sam_template_defaults_dev_auth_off():
    """The deploy default must be secure: EnableUiDevAuth Default == 'false'."""
    template = (Path(__file__).resolve().parents[2] / "template.yaml").read_text(encoding="utf-8")
    block = re.search(r"^\s{2}EnableUiDevAuth:\n(?:\s{4}.*\n)+", template, re.MULTILINE)
    assert block, "EnableUiDevAuth parameter block not found in template.yaml"
    default = re.search(r"^\s{4}Default:\s*\"?(\w+)\"?\s*$", block.group(0), re.MULTILINE)
    assert default, "EnableUiDevAuth has no Default line"
    assert default.group(1) == "false", (
        f"EnableUiDevAuth defaults to {default.group(1)!r}; must be 'false' so deploys "
        "don't ship a credential-free Admin login (ledger A-6)."
    )
