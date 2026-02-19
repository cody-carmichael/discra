import os
import sys

from fastapi.testclient import TestClient

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "../..")))

from backend.app import app

client = TestClient(app)


def test_ui_pages_are_available():
    home = client.get("/ui")
    admin = client.get("/ui/admin")
    driver = client.get("/ui/driver")

    assert home.status_code == 200
    assert admin.status_code == 200
    assert driver.status_code == 200
    assert "Discra Pilot UI" in home.text
    assert "Admin and Dispatcher Console" in admin.text
    assert "Driver Workflow" in driver.text
    assert "logout-hosted-ui" in admin.text
    assert "driver-logout-hosted-ui" in driver.text


def test_ui_assets_and_service_worker_are_served():
    common_js = client.get("/ui/assets/common.js")
    styles_css = client.get("/ui/assets/styles.css")
    admin_manifest = client.get("/ui/assets/admin-manifest.json")
    driver_manifest = client.get("/ui/assets/driver-manifest.json")
    admin_service_worker = client.get("/ui/admin-sw.js")
    service_worker = client.get("/ui/driver-sw.js")

    assert common_js.status_code == 200
    assert styles_css.status_code == 200
    assert admin_manifest.status_code == 200
    assert driver_manifest.status_code == 200
    assert admin_service_worker.status_code == 200
    assert service_worker.status_code == 200
    assert "DiscraCommon" in common_js.text
    assert "startHostedLogin" in common_js.text
    assert "consumeHostedLoginCallback" in common_js.text
    assert "DiscraAdmin" in admin_manifest.text
    assert "DiscraDriver" in driver_manifest.text
    assert "discra-admin-v1" in admin_service_worker.text
    assert "CACHE_NAME" in service_worker.text


def test_ui_config_reflects_env(monkeypatch):
    monkeypatch.setenv("COGNITO_HOSTED_UI_DOMAIN", "demo-auth.example.com")
    monkeypatch.setenv("FRONTEND_COGNITO_CLIENT_ID", "client-123")
    monkeypatch.setenv("FRONTEND_MAP_STYLE_URL", "https://maps.example.com/style.json")

    response = client.get("/ui/config")
    assert response.status_code == 200
    body = response.json()
    assert body["cognito_domain"] == "demo-auth.example.com"
    assert body["cognito_client_id"] == "client-123"
    assert body["map_style_url"] == "https://maps.example.com/style.json"
