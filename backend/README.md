Discra Python backend (`PR1` to `PR7`) for migration from Java Lambda handlers.

## Implemented so far
- FastAPI app adapted to Lambda with Mangum (`backend/app.py`).
- Public parity endpoints:
  - `GET /health` -> `{"ok": true}`
  - `GET /version` -> `{"version": "<VERSION|dev>"}`
- Cognito-aware auth + RBAC:
  - groups from `cognito:groups` claim
  - tenant from `custom:org_id` (or `org_id`)
  - role checks at application layer (`Admin`, `Dispatcher`, `Driver`)
- Users/organizations model:
  - `GET /users/me`, `POST /users/me/sync`
  - `GET /orgs/me`, `PUT /orgs/me` (Admin only)
- Initial multi-tenant order routes with app-layer RBAC:
  - `POST /orders`, `GET /orders`, `GET /orders/{id}`
  - `POST /orders/{id}/assign`, `POST /orders/{id}/unassign`
  - `POST /orders/{id}/status`
  - `GET /orders/driver/inbox`
- POD workflow:
  - `POST /pod/presign` (Driver only)
  - `POST /pod/metadata` (Driver only)
  - S3 presigned POST with type/size limits + DynamoDB metadata storage
- Driver map data:
  - `POST /drivers/location` (Driver only)
  - `GET /drivers?active_minutes=` (Admin/Dispatcher)
  - Latest per-driver location stored in DynamoDB with TTL
- Route optimization:
  - `POST /routes/optimize` (Admin/Dispatcher)
  - Uses Amazon Location `CalculateRouteMatrix` when `LOCATION_ROUTE_CALCULATOR_NAME` is set
  - Uses OR-Tools for route ordering (single driver path)
- Billing + seat management:
  - `GET /billing/summary` (Admin)
  - `POST /billing/seats` (Admin)
  - `POST /billing/invitations` (Admin)
  - `POST /billing/invitations/{invitationId}/activate` (Admin)
  - `POST /webhooks/orders` (public with `x-orders-webhook-token`)
  - `POST /webhooks/stripe` (public)
  - Seat limits enforced for Dispatcher/Driver invitations and activation

## Local development
```powershell
cd backend
python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r requirements.txt
uvicorn app:app --reload --port 8000
```

Open:
- `http://127.0.0.1:8000/health`
- `http://127.0.0.1:8000/version`

For protected routes in local direct Uvicorn mode without Cognito:

```powershell
$env:JWT_VERIFY_SIGNATURE="false"
```

## Local SAM
Run from repo root:

```powershell
sam build -t template.yaml --use-container
sam local start-api --template template.yaml
```

Then call:
- `http://127.0.0.1:3000/dev/health` (existing Java endpoint)
- `http://127.0.0.1:3000/dev/version` (existing Java endpoint)
- `http://127.0.0.1:3000/dev/backend/health` (new Python endpoint)
- `http://127.0.0.1:3000/dev/backend/version` (new Python endpoint)

For local POD testing without AWS resources:

```powershell
$env:USE_IN_MEMORY_POD_STORE="true"
```

For local billing tests without AWS resources:

```powershell
$env:USE_IN_MEMORY_BILLING_STORE="true"
```

For local order-ingest webhook tests:

```powershell
$env:ORDERS_WEBHOOK_TOKEN="orders-secret"
```

## Tests
```powershell
cd backend
pip install -r requirements.txt
pytest -q tests -p no:cacheprovider
```
