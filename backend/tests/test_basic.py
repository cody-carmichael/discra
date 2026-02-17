import os, sys
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), '..')))

from app import app
from fastapi.testclient import TestClient

client = TestClient(app)

def test_health():
    r = client.get('/health')
    assert r.status_code == 200
    assert r.json() == {'ok': True}

def test_version_default():
    # ensure VERSION not set
    os.environ.pop('VERSION', None)
    r = client.get('/version')
    assert r.status_code == 200
    assert r.json().get('version') == 'dev'

def test_version_env():
    os.environ['VERSION'] = 'unittest'
    r = client.get('/version')
    assert r.status_code == 200
    assert r.json().get('version') == 'unittest'
