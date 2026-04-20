import os
import re
import sys

from fastapi.testclient import TestClient

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "../..")))

from backend.app import app

client = TestClient(app)


def test_ui_pages_are_available():
    home = client.get("/ui")
    login = client.get("/ui/login")
    admin = client.get("/ui/admin")
    driver = client.get("/ui/driver")
    register = client.get("/ui/register")
    review = client.get("/ui/review")

    assert home.status_code == 200
    assert login.status_code == 200
    assert admin.status_code == 200
    assert driver.status_code == 200
    assert register.status_code == 200
    assert review.status_code == 200
    assert "The calm control tower for last-mile delivery teams." in home.text
    assert "Request Access" in home.text
    assert "Enter" in home.text
    assert "ui/login" in home.text
    assert "Welcome Back" in login.text
    assert "login-gateway-button" in login.text
    assert "Discra" in admin.text
    assert "Dispatch" in admin.text
    assert "My Stops" in driver.text
    assert "Register Your Tenant" in register.text
    assert "Create Account" in register.text
    assert "Sign In" in register.text
    assert "JWT Token (optional override)" not in register.text
    assert "App Dev Review" in review.text
    assert "logout-hosted-ui" in admin.text
    assert "driver-logout-hosted-ui" in driver.text


def test_ui_assets_and_service_worker_are_served():
    common_js = client.get("/ui/assets/common.js")
    login_js = client.get("/ui/assets/login.js")
    landing_js = client.get("/ui/assets/landing.js")
    styles_css = client.get("/ui/assets/styles.css")
    admin_manifest = client.get("/ui/assets/admin-manifest.json")
    driver_manifest = client.get("/ui/assets/driver-manifest.json")
    admin_service_worker = client.get("/ui/admin-sw.js")
    service_worker = client.get("/ui/driver-sw.js")

    assert common_js.status_code == 200
    assert login_js.status_code == 200
    assert landing_js.status_code == 200
    assert styles_css.status_code == 200
    assert admin_manifest.status_code == 200
    assert driver_manifest.status_code == 200
    assert admin_service_worker.status_code == 200
    assert service_worker.status_code == 200
    assert "DiscraCommon" in common_js.text
    assert "startHostedLogin" in common_js.text
    assert "consumeHostedLoginCallback" in common_js.text
    assert "resolveAdminPath" in login_js.text
    assert "IntersectionObserver" in landing_js.text
    assert "DiscraAdmin" in admin_manifest.text
    assert "DiscraDriver" in driver_manifest.text
    cache_name_match = re.search(r'const CACHE_NAME = "([^"]+)"', admin_service_worker.text)
    assert cache_name_match is not None
    assert cache_name_match.group(1).startswith("discra-admin-v")
    assert "CACHE_PREFIX = \"discra-admin-\"" in admin_service_worker.text
    assert "CACHE_NAME" in service_worker.text


def test_ui_config_reflects_env(monkeypatch):
    monkeypatch.setenv("COGNITO_HOSTED_UI_DOMAIN", "demo-auth.example.com")
    monkeypatch.setenv("FRONTEND_COGNITO_CLIENT_ID", "client-123")
    monkeypatch.setenv("FRONTEND_MAP_STYLE_URL", "https://maps.example.com/style.json")
    monkeypatch.setenv("ENABLE_ONBOARDING_FLOW", "true")

    response = client.get("/ui/config")
    assert response.status_code == 200
    body = response.json()
    assert body["cognito_domain"] == "demo-auth.example.com"
    assert body["cognito_client_id"] == "client-123"
    assert body["map_style_url"] == "https://maps.example.com/style.json"
    assert body["onboarding_enabled"] is True
    assert body["register_url_path"] == "/ui/register"
    assert body["review_url_path"] == "/ui/review"
