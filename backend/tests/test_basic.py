from fastapi.testclient import TestClient
import os
import sys

# ensure backend module path if needed
from app import app

client = TestClient(app)

def test_health():
    r = client.get("/health")
    assert r.status_code == 200
    assert r.json() == {"ok": True}

def test_version_default():
    if "VERSION" in os.environ:
        del os.environ["VERSION"]
    r = client.get("/version")
    assert r.status_code == 200
    assert r.json().get("version") == "dev"

def test_version_env():
    os.environ["VERSION"] = "test-version"
    r = client.get("/version")
    assert r.status_code == 200
    assert r.json().get("version") == "test-version"
