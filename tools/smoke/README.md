# Smoke checks

PowerShell smoke checks for a deployed Discra stack live in:

- `tools/smoke/run-smoke.ps1`

The script verifies:

- `GET /health`
- `GET /version`
- `GET /backend/health`
- `GET /backend/version`
- `GET /admin/ping` (when `-AdminToken` is provided)
- `POST /backend/webhooks/orders` (when `-OrdersWebhookToken` is provided, with optional HMAC signing)

Example:

```powershell
tools\smoke\run-smoke.ps1 `
  -ApiBaseUrl "https://<api-id>.execute-api.us-east-1.amazonaws.com/dev" `
  -AdminToken "<ADMIN_TOKEN>" `
  -OrdersWebhookToken "<ORDERS_WEBHOOK_TOKEN>" `
  -OrdersWebhookHmacSecret "<ORDERS_WEBHOOK_HMAC_SECRET>" `
  -OrgId "org-smoke-1"
```

In GitHub Actions, use the `Smoke Dev` workflow (`.github/workflows/smoke-dev.yml`) and pass `api_base_url`.
