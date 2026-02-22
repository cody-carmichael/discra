# Discra

Discra is an AWS SAM application migrating from Java Lambda handlers to a Python backend for delivery operations.

## Current architecture
- Java 21 Lambdas (legacy, still active):
  - `GET /health`
  - `GET /version`
  - `GET /admin/ping` (header `x-admin-token`)
- Python 3.12 Lambda (new backend path):
  - `GET /backend/health`
  - `GET /backend/version`
  - `GET /backend/ui` (public frontend entry)
  - `GET /backend/ui/admin` (Admin/Dispatcher console)
  - `GET /backend/ui/admin-sw.js` (Admin/Dispatcher PWA service worker)
  - `GET /backend/ui/driver` (Driver app)
  - `GET /backend/ui/driver-sw.js` (Driver PWA service worker)
  - protected business endpoints under `/backend/*` using Cognito JWT + app-layer RBAC

SAM template: `template.yaml`

## Build and run (Java + SAM)
```powershell
mvn clean package
sam build -t template.yaml --use-container
sam local start-api --template template.yaml
```

## Python backend local run
```powershell
cd backend
python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r requirements.txt
uvicorn app:app --reload --port 8000
```

## Mobile app local run (React Native + Expo)
```powershell
cd mobile
npm install
npm run start
```

The mobile app stores:
- API base URL (expected format: `.../dev/backend`)
- JWT token
- workspace mode (`Admin/Dispatcher` or `Driver`)

## Endpoint checks
After `sam local start-api`:

- `curl http://127.0.0.1:3000/dev/health`
- `curl http://127.0.0.1:3000/dev/version`
- `curl http://127.0.0.1:3000/dev/backend/health`
- `curl http://127.0.0.1:3000/dev/backend/version`
- open `http://127.0.0.1:3000/dev/backend/ui`
- open `http://127.0.0.1:3000/dev/backend/ui/admin` (mobile-installable dispatch console)
- open `http://127.0.0.1:3000/dev/backend/ui/driver` (mobile-installable driver app)
- `curl -H "x-admin-token: <ADMIN_TOKEN>" http://127.0.0.1:3000/dev/admin/ping`

### Protected endpoints (JWT required)
- `GET /dev/backend/users/me`
- `POST /dev/backend/users/me/sync`
- `GET /dev/backend/orgs/me`
- `PUT /dev/backend/orgs/me` (Admin only)
- `GET /dev/backend/orders`
- `POST /dev/backend/orders`
- `GET /dev/backend/orders/{orderId}`
- `POST /dev/backend/orders/{orderId}/assign` (Admin/Dispatcher)
- `POST /dev/backend/orders/{orderId}/unassign` (Admin/Dispatcher)
- `POST /dev/backend/orders/{orderId}/status` (Driver/Admin/Dispatcher)
- `GET /dev/backend/orders/driver/inbox` (Driver)
- `POST /dev/backend/pod/presign` (Driver)
- `POST /dev/backend/pod/metadata` (Driver)
- `POST /dev/backend/drivers/location` (Driver)
- `GET /dev/backend/drivers?active_minutes=30` (Admin/Dispatcher)
- `POST /dev/backend/routes/optimize` (Admin/Dispatcher)
- `GET /dev/backend/billing/summary` (Admin)
- `GET /dev/backend/billing/status` (Admin)
- `POST /dev/backend/billing/checkout` (Admin)
- `POST /dev/backend/billing/portal` (Admin)
- `POST /dev/backend/billing/seats` (Admin)
- `GET /dev/backend/billing/invitations` (Admin)
- `POST /dev/backend/billing/invitations` (Admin)
- `POST /dev/backend/billing/invitations/{invitationId}/activate` (Admin)
- `POST /dev/backend/billing/invitations/{invitationId}/cancel` (Admin)
- `POST /dev/backend/webhooks/orders` (public webhook with `x-orders-webhook-token`, optional HMAC headers)
- `POST /dev/backend/webhooks/stripe` (public webhook)

`POST /dev/backend/orders` now requires:
- `reference_number` (number)
- `pick_up_address` (string)
- `delivery` (string)
- `dimensions` (string)
- `weight` (number)

`POST /dev/backend/routes/optimize` accepts optional explicit `stops` (`lat`/`lng`) overrides.
If `stops` is omitted, the backend geocodes assigned order delivery addresses and optimizes automatically.

## Cognito auth parameters
`template.yaml` now expects these deploy parameters:
- `CognitoUserPoolId`
- `CognitoAppClientId`
- `LocationRouteCalculatorName` (optional Amazon Location route calculator for matrix calls)
- `LocationPlaceIndexName` (optional Amazon Location place index for address geocoding)
- `OrdersWebhookToken` (shared secret for `/backend/webhooks/orders`)
- `OrdersWebhookHmacSecret` (optional HMAC secret for signed `/backend/webhooks/orders` payloads)
- `OrdersWebhookMaxSkewSeconds` (optional timestamp skew window for signed payloads; default `300`)
- `CognitoHostedUiDomain` (optional hosted UI helper domain for frontend pages)
- `FrontendMapStyleUrl` (optional MapLibre style JSON URL)

API Gateway HTTP API uses a JWT authorizer for `/backend/{proxy+}`.
`/backend/health` and `/backend/version` remain public for parity checks.

Hosted UI setup notes:
- Configure Cognito app client callback URLs with:
  - `https://<api-domain>/dev/backend/ui/admin`
  - `https://<api-domain>/dev/backend/ui/driver`
- Configure logout URLs with the same page URLs (or your preferred landing page).
- Frontend uses Authorization Code + PKCE flow and exchanges `code` at Cognito `/oauth2/token`.

## Orders webhook signing
- Base auth always requires `x-orders-webhook-token`.
- Optional hardened mode: set `OrdersWebhookHmacSecret` and send:
  - `x-orders-webhook-timestamp` (Unix seconds)
  - `x-orders-webhook-signature` (`sha256=<hex>` or `<hex>`)
- Signature input format: `"{timestamp}.{raw_json_body}"` using HMAC-SHA256.
- Rejects payloads outside `OrdersWebhookMaxSkewSeconds` to reduce replay risk.

## POD upload constraints
- Uploads use short-lived S3 presigned POST policies (default `300` seconds).
- Allowed types:
  - photo: `image/jpeg`, `image/png`, `image/webp` (max 10 MB)
  - signature: `image/png`, `image/jpeg`, `image/webp` (max 2 MB)
- Metadata is persisted in DynamoDB (`PodArtifactsTable` output).

## Audit logging
- Sensitive actions are persisted to DynamoDB (`AuditLogsTable`) with:
  - actor + role
  - org/target/action
  - request id (`x-correlation-id` / generated request id)
  - structured details
- Current audited actions:
  - order assignment/unassignment/reassignment
  - billing seat updates
  - invitation creation/activation
  - Stripe subscription webhook seat sync

## Migration roadmap (incremental PRs)
1. Python backend skeleton + SAM wiring + health/version parity
2. Cognito JWT auth + RBAC + Users/Organizations model
3. Orders + dispatch + driver inbox
4. Proof of delivery presigned uploads + metadata
5. Driver locations + map endpoint
6. Route optimization (Amazon Location matrix + OR-Tools)
7. Stripe billing + seat enforcement
8. Minimal Admin/Dispatcher UI + Driver PWA
9. Orders persistence abstraction + DynamoDB-backed order store
10. External orders webhook hardening (HMAC signature + replay window + batch duplicate checks)
11. Sensitive-action audit logging (billing + seat management + order reassignment)
12. Hosted UI auth-code + PKCE login/logout for Admin/Dispatcher and Driver web apps
13. Mobile-ready Admin/Dispatcher PWA (responsive dispatch cards + installable web app + offline asset cache)
14. Native mobile app baseline (React Native/Expo) for Admin/Dispatcher dispatch + driver tracking and Driver inbox/status/location
15. Mobile hardening: Hosted UI deep-link login/logout and offline queue sync for driver status/location
16. Mobile POD workflow: driver photo + signature capture and upload to `/pod/*` endpoints with delivery completion
17. Mobile map view: in-app Admin/Dispatcher map visualization + route context for active drivers
18. Mobile release hardening: in-app validation, Expo build profiles, smoke-test checklist, and deployment notes
19. Route optimization completeness: remove manual stops requirement via address geocoding + assigned-order route generation
20. Mobile route optimization UX: selected-driver optimization, ordered stop context, and map handoff to Google Maps
21. Admin billing console UX: seat summary, seat limit updates, and invitation create/activate flows
22. Stripe checkout flow: Admin endpoint + UI action to start subscription checkout when no Stripe subscription exists
23. Billing readiness visibility: Admin status endpoint + console indicators for Stripe configuration and linkage
24. Billing invitation lifecycle: list invitations and cancel pending invitations from Admin console
25. Stripe billing self-service: Admin endpoint + console action to open Stripe Billing Portal for linked customers
