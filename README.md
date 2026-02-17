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

## Endpoint checks
After `sam local start-api`:

- `curl http://127.0.0.1:3000/dev/health`
- `curl http://127.0.0.1:3000/dev/version`
- `curl http://127.0.0.1:3000/dev/backend/health`
- `curl http://127.0.0.1:3000/dev/backend/version`
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
- `POST /dev/backend/billing/seats` (Admin)
- `POST /dev/backend/billing/invitations` (Admin)
- `POST /dev/backend/billing/invitations/{invitationId}/activate` (Admin)
- `POST /dev/backend/webhooks/orders` (public webhook with `x-orders-webhook-token`)
- `POST /dev/backend/webhooks/stripe` (public webhook)

## Cognito auth parameters
`template.yaml` now expects these deploy parameters:
- `CognitoUserPoolId`
- `CognitoAppClientId`
- `OrdersWebhookToken` (shared secret for `/backend/webhooks/orders`)

API Gateway HTTP API uses a JWT authorizer for `/backend/{proxy+}`.
`/backend/health` and `/backend/version` remain public for parity checks.

## POD upload constraints
- Uploads use short-lived S3 presigned POST policies (default `300` seconds).
- Allowed types:
  - photo: `image/jpeg`, `image/png`, `image/webp` (max 10 MB)
  - signature: `image/png`, `image/jpeg`, `image/webp` (max 2 MB)
- Metadata is persisted in DynamoDB (`PodArtifactsTable` output).

## Migration roadmap (incremental PRs)
1. Python backend skeleton + SAM wiring + health/version parity
2. Cognito JWT auth + RBAC + Users/Organizations model
3. Orders + dispatch + driver inbox
4. Proof of delivery presigned uploads + metadata
5. Driver locations + map endpoint
6. Route optimization (Amazon Location matrix + OR-Tools)
7. Stripe billing + seat enforcement
8. Minimal Admin/Dispatcher UI + Driver PWA
