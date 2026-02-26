Discra Python backend (`PR1` to `PR18`) for migration from Java Lambda handlers.

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
  - `POST /orders` required fields:
    - `reference_number` (number)
    - `pick_up_address` (string)
    - `delivery` (string)
    - `dimensions` (string)
    - `weight` (number)
  - `POST /orders` optional scheduling fields:
    - `time_window_start` (datetime)
    - `time_window_end` (datetime, must be >= start)
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
  - Geocodes assigned order delivery addresses via Amazon Location place index when `LOCATION_PLACE_INDEX_NAME` is set
  - Uses OR-Tools for route ordering (single driver path)
  - If `stops` is omitted, assigned orders for the driver are geocoded and optimized automatically
  - Explicit `stops` with `lat/lng` are still supported as an override
- Billing + seat management:
  - `GET /billing/summary` (Admin)
  - `GET /billing/status` (Admin)
  - `POST /billing/checkout` (Admin)
  - `POST /billing/portal` (Admin)
  - `POST /billing/seats` (Admin)
  - `GET /billing/invitations` (Admin)
  - `POST /billing/invitations` (Admin)
  - `POST /billing/invitations/{invitationId}/activate` (Admin)
  - `POST /billing/invitations/{invitationId}/cancel` (Admin)
  - `POST /webhooks/orders` (public with `x-orders-webhook-token`, optional HMAC headers)
  - `POST /webhooks/stripe` (public)
  - Seat limits enforced for Dispatcher/Driver invitations and activation
- Audit logs:
  - Sensitive actions persisted to `AuditLogsTable` in DynamoDB
  - Tracks actor, roles, action, target, request id, and structured details
- Minimal web UIs:
  - `GET /ui` (workspace picker)
  - `GET /ui/admin` (Admin/Dispatcher console)
  - Admin console includes seat-billing controls for `GET /billing/summary`, `GET /billing/status`, `POST /billing/checkout`, `POST /billing/portal`, `POST /billing/seats`, `GET /billing/invitations`, `POST /billing/invitations`, invitation activation, and invitation cancellation
  - Admin order queue supports status + assigned-driver filters and free-text search (customer/reference/external id)
  - `GET /ui/admin-sw.js` (Admin/Dispatcher PWA service worker)
  - `GET /ui/driver` (Driver web app with POD + location updates)
  - `GET /ui/driver-sw.js` (Driver PWA service worker)
  - `GET /ui/config` (frontend config bootstrap for hosted UI and map style)
  - Hosted UI login/logout uses Cognito Authorization Code + PKCE flow
  - Admin/Dispatcher view includes mobile-optimized dispatch cards for assign/unassign/status actions
- Native mobile companion app:
  - React Native/Expo app in `mobile/`
  - Admin/Dispatcher: mobile dispatch + driver tracking + in-app active-driver map and route context
  - Driver: inbox/status/location updates + POD photo/signature capture + POD metadata submit
  - Hosted UI deep-link login/logout and offline queue sync for driver status/location events
  - Release hardening: session validation warnings, EAS build profiles, mobile CI typecheck workflow, smoke-test checklist

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
- `http://127.0.0.1:3000/dev/backend/ui` (frontend entrypoint)

For local POD testing without AWS resources:

```powershell
$env:USE_IN_MEMORY_POD_STORE="true"
```

For local billing tests without AWS resources:

```powershell
$env:USE_IN_MEMORY_BILLING_STORE="true"
```

For local audit log tests without AWS resources:

```powershell
$env:USE_IN_MEMORY_AUDIT_LOG_STORE="true"
```

For local order-ingest webhook tests:

```powershell
$env:ORDERS_WEBHOOK_TOKEN="orders-secret"
```

Optional signature hardening for order-ingest webhook:

```powershell
$env:ORDERS_WEBHOOK_HMAC_SECRET="orders-hmac-secret"
$env:ORDERS_WEBHOOK_MAX_SKEW_SECONDS="300"
```

When `ORDERS_WEBHOOK_HMAC_SECRET` is set, clients must also provide:
- `x-orders-webhook-timestamp` (Unix seconds)
- `x-orders-webhook-signature` (`sha256=<hex>` or `<hex>`)

Signature input format: `"{timestamp}.{raw_json_body}"` with HMAC-SHA256.

Pilot/demo seed helper (posts directly to `/webhooks/orders`):

```powershell
python ..\tools\pilot\seed_orders_webhook.py `
  --endpoint "https://<api-id>.execute-api.us-east-1.amazonaws.com/dev/backend/webhooks/orders" `
  --token "<ORDERS_WEBHOOK_TOKEN>" `
  --org-id "org-pilot-1" `
  --count 75 `
  --batch-size 50
```

When HMAC signing is enabled, also pass:

```powershell
--hmac-secret "<ORDERS_WEBHOOK_HMAC_SECRET>"
```

The seed helper reads `ORDERS_WEBHOOK_TOKEN` and `ORDERS_WEBHOOK_HMAC_SECRET` from environment variables when flags are omitted.

Optional frontend helper config:

```powershell
$env:COGNITO_HOSTED_UI_DOMAIN="your-domain.auth.us-east-1.amazoncognito.com"
$env:FRONTEND_COGNITO_CLIENT_ID="your-app-client-id"
$env:FRONTEND_MAP_STYLE_URL="https://demotiles.maplibre.org/style.json"
```

Optional Amazon Location routing/geocoding config:

```powershell
$env:LOCATION_ROUTE_CALCULATOR_NAME="your-route-calculator"
$env:LOCATION_PLACE_INDEX_NAME="your-place-index"
```

For Hosted UI login in deployed environments, configure Cognito app client:
- callback URLs:
  - `https://<api-domain>/dev/backend/ui/admin`
  - `https://<api-domain>/dev/backend/ui/driver`
- logout URLs:
  - same URLs, or your preferred post-logout page

## Tests
```powershell
cd backend
pip install -r requirements.txt
pytest -q tests -p no:cacheprovider
```
