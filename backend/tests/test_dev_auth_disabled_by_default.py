"""Guards that UI dev-auth (credential-free role sign-in) can never be ON by accident.

Dev-auth lets anyone mint an Admin/Dispatcher/Driver session cookie with no
credentials (POST /backend/ui/dev-auth/login). It is a manual-testing convenience
and MUST be opt-in. Three independent layers must all fail safe:

  1. The application: is_dev_auth_enabled() defaults False when ENABLE_UI_DEV_AUTH
     is unset, and the dev-auth endpoints 404 in that state.
  2. The SAM template: the EnableUiDevAuth parameter defaults to "false", so a
     NEW stack does not ship an auth bypass.
  3. The deploy workflow: it passes EnableUiDevAuth explicitly, so an EXISTING
     stack is corrected too.

Layer 3 is the one that actually bit us. Ledger issue A-6 was recorded as fixed
after layer 2 was changed on a branch, but that branch was never merged AND a
template default cannot protect a deployed stack: CloudFormation keeps a
parameter's previous value when a deploy omits it. discra-api-dev therefore
served a working credential-free Admin login (verified live 2026-07-26,
returning a session for org-pilot-1) throughout the alpha hardening effort.

Regression test for A-6.
"""
import os
import re
import sys
from pathlib import Path

from fastapi.testclient import TestClient

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "../..")))

from backend.auth import is_dev_auth_enabled

# Import the app BEFORE any env manipulation. backend/app.py calls _load_dotenv() at
# import time, which repopulates os.environ from a developer's local .env — so an env
# change applied before the first import gets silently undone by it. Importing here
# means the dotenv load has already happened and per-test monkeypatching sticks.
# (Dev-auth is read per request via is_dev_auth_enabled(), so patching env is enough;
# no app rebuild is needed.)
from backend.app import app as _app

REPO_ROOT = Path(__file__).resolve().parents[2]


def _client_with_env(monkeypatch, value=None):
    if value is None:
        monkeypatch.delenv("ENABLE_UI_DEV_AUTH", raising=False)
    else:
        monkeypatch.setenv("ENABLE_UI_DEV_AUTH", value)
    return TestClient(_app)


# --- Layer 1: the application ------------------------------------------------

def test_app_dev_auth_disabled_when_env_unset(monkeypatch):
    monkeypatch.delenv("ENABLE_UI_DEV_AUTH", raising=False)
    assert is_dev_auth_enabled() is False


def test_app_dev_auth_enabled_only_by_explicit_optin(monkeypatch):
    """Positive control: the 404s below mean "disabled", not "route doesn't exist"."""
    monkeypatch.setenv("ENABLE_UI_DEV_AUTH", "true")
    client = TestClient(_app)
    resp = client.post("/backend/ui/dev-auth/login", json={"role": "Admin"})
    assert resp.status_code == 200
    assert "set-cookie" in {k.lower() for k in resp.headers}


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


# --- Layer 2: the template default (protects a NEW stack) --------------------

def _dev_auth_param_block():
    template = (REPO_ROOT / "template.yaml").read_text(encoding="utf-8")
    block = re.search(r"^\s{2}EnableUiDevAuth:\n(?:\s{4}.*\n)+", template, re.MULTILINE)
    assert block, "EnableUiDevAuth parameter block not found in template.yaml"
    return block.group(0)


def test_sam_template_defaults_dev_auth_off():
    """The deploy default must be secure: EnableUiDevAuth Default == 'false'."""
    block = _dev_auth_param_block()
    default = re.search(r"^\s{4}Default:\s*\"?(\w+)\"?\s*$", block, re.MULTILINE)
    assert default, "EnableUiDevAuth has no Default line"
    assert default.group(1) == "false", (
        f"EnableUiDevAuth defaults to {default.group(1)!r}; must be 'false' so deploys "
        "don't ship a credential-free Admin login (ledger A-6)."
    )


def test_sam_template_constrains_dev_auth_values():
    """AllowedValues stops a typo ('True', 'yes') from being accepted as a value."""
    block = _dev_auth_param_block()
    assert "AllowedValues" in block, "EnableUiDevAuth should constrain AllowedValues"
    assert '"true"' in block and '"false"' in block


# --- Layer 3: the deploy workflow (protects an EXISTING stack) ---------------

def test_deploy_workflow_pins_dev_auth_off():
    """The workflow must pass EnableUiDevAuth explicitly on every deploy.

    A template default only applies when a stack is created. CloudFormation keeps
    the previous value for any parameter a deploy does not pass, so an existing
    stack that was once deployed with "true" stays "true" forever — which is
    precisely what happened to discra-api-dev. Pinning it in the override list is
    the only thing that actually closes the hole.
    """
    workflow = (REPO_ROOT / ".github/workflows/deploy-dev.yml").read_text(encoding="utf-8")
    assert "EnableUiDevAuth=false" in workflow, (
        "deploy-dev.yml must pin 'EnableUiDevAuth=false' in parameter_overrides; "
        "without it CloudFormation retains the stack's previous value and a "
        "credential-free Admin login can survive indefinitely (ledger A-6)."
    )
    # Guard against someone re-enabling it via the same list.
    assert "EnableUiDevAuth=true" not in workflow
