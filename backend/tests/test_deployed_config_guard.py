"""Deployed-config startup guard (security backlog S-8).

In a deployed runtime (Lambda sets AWS_LAMBDA_FUNCTION_NAME, or
REQUIRE_SECURE_CONFIG=true), create_app() must refuse to start with a dev
escape hatch unsafely set. Local dev (no marker) is never affected.
"""

import logging
import os
import sys

import pytest

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "../..")))

from backend.app import create_app


@pytest.fixture(autouse=True)
def _clean_env(monkeypatch):
    for var in (
        "AWS_LAMBDA_FUNCTION_NAME",
        "REQUIRE_SECURE_CONFIG",
        "JWT_VERIFY_SIGNATURE",
        "ALLOW_UNSAFE_STRIPE_WEBHOOK_WITHOUT_SECRET",
        "ENABLE_UI_DEV_AUTH",
    ):
        monkeypatch.delenv(var, raising=False)


def test_lambda_refuses_disabled_jwt_verification(monkeypatch):
    monkeypatch.setenv("AWS_LAMBDA_FUNCTION_NAME", "discra-backend")
    monkeypatch.setenv("JWT_VERIFY_SIGNATURE", "false")
    with pytest.raises(RuntimeError, match="JWT_VERIFY_SIGNATURE"):
        create_app()


def test_lambda_refuses_unsigned_stripe_webhooks(monkeypatch):
    monkeypatch.setenv("AWS_LAMBDA_FUNCTION_NAME", "discra-backend")
    monkeypatch.setenv("ALLOW_UNSAFE_STRIPE_WEBHOOK_WITHOUT_SECRET", "true")
    with pytest.raises(RuntimeError, match="STRIPE_WEBHOOK"):
        create_app()


def test_require_secure_config_opt_in_guards_non_lambda(monkeypatch):
    monkeypatch.setenv("REQUIRE_SECURE_CONFIG", "true")
    monkeypatch.setenv("JWT_VERIFY_SIGNATURE", "false")
    with pytest.raises(RuntimeError, match="JWT_VERIFY_SIGNATURE"):
        create_app()


def test_lambda_starts_with_safe_config(monkeypatch):
    monkeypatch.setenv("AWS_LAMBDA_FUNCTION_NAME", "discra-backend")
    monkeypatch.setenv("JWT_VERIFY_SIGNATURE", "true")
    assert create_app() is not None


def test_local_dev_is_unaffected_by_unsafe_flags(monkeypatch):
    # No deployed marker: the pytest suite itself runs with verification off.
    monkeypatch.setenv("JWT_VERIFY_SIGNATURE", "false")
    monkeypatch.setenv("ALLOW_UNSAFE_STRIPE_WEBHOOK_WITHOUT_SECRET", "true")
    assert create_app() is not None


def test_dev_auth_in_lambda_warns_but_starts(monkeypatch, caplog):
    monkeypatch.setenv("AWS_LAMBDA_FUNCTION_NAME", "discra-backend")
    monkeypatch.setenv("ENABLE_UI_DEV_AUTH", "true")
    with caplog.at_level(logging.WARNING):
        assert create_app() is not None
    assert any("ENABLE_UI_DEV_AUTH" in rec.getMessage() for rec in caplog.records)
