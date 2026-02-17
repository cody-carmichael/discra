Backend scaffold (Python, FastAPI + Mangum) for Discra migration PR1.

Local dev:
  # create virtualenv and install
  python -m venv .venv
  .\.venv\Scripts\Activate.ps1
  pip install -r requirements.txt

Run with Uvicorn:
  uvicorn app:app --reload --port 8000
  # then visit http://127.0.0.1:8000/health and /version

Lambda via SAM:
  sam build -t template.yaml
  sam local start-api --template template.yaml
  # the new endpoints are mounted at /backend/health and /backend/version in the SAM template.

Tests:
  pip install -r requirements.txt
  pytest -q
