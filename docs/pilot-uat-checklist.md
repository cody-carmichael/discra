# Discra Pilot UAT Checklist

Use this checklist when handing Discra to an external tester for MVP validation.

## 1) Environment prep

- Confirm latest `main` is deployed to the dev stack.
- Generate stack summary:
  - `tools\pilot\export-pilot-summary.ps1 -StackName "discra-api-dev" -Region "us-east-1"`
- Run smoke checks:
  - `tools\smoke\run-smoke.ps1 -ApiBaseUrl "https://<api-id>.execute-api.us-east-1.amazonaws.com/dev" -AdminToken "<ADMIN_TOKEN>" -OrdersWebhookToken "<ORDERS_WEBHOOK_TOKEN>"`
- Verify Cognito groups exist: `Admin`, `Dispatcher`, `Driver`.

## 2) Tester package to share

- Admin UI URL (`/backend/ui/admin`)
- Driver UI URL (`/backend/ui/driver`)
- Temporary Cognito test users (one per role)
- Test org id (example: `org-pilot-1`)
- Known limitations for pilot:
  - route optimization quality depends on Amazon Location data/geocoding quality
  - webhook ingest requires shared token (and HMAC headers if enabled)

## 3) Admin checks

- Log in via hosted UI.
- Open dispatch summary and confirm KPI data loads.
- Create at least 2 orders with required fields:
  - `reference_number`, `pick_up_address`, `delivery`, `dimensions`, `weight`
- Assign one order to a driver and verify audit log event appears.
- Open billing summary/status and confirm seat counts and provider readiness render.

## 4) Dispatcher checks

- Log in and load order queue.
- Filter queue by status and assigned driver.
- Use bulk assign or bulk unassign on at least 2 orders.
- Verify driver location list/map data is visible.

## 5) Driver checks (web or mobile)

- Log in and open assigned inbox.
- Move one order status through:
  - `Assigned -> PickedUp -> EnRoute -> Delivered`
- Capture POD photo and signature, submit notes, and confirm success response.
- Send location update and verify Admin/Dispatcher can see updated driver point.

## 6) Webhook ingest checks

- Push sample orders:
  - `python tools/pilot/seed_orders_webhook.py --endpoint "<orders-webhook-url>" --token "<ORDERS_WEBHOOK_TOKEN>" --org-id "org-pilot-1" --count 25`
- Confirm ingested orders appear in Admin/Dispatcher queue.
- Re-send same external ids and confirm upsert behavior (no duplicate external IDs within org).

## 7) Exit criteria for pilot sign-off

- All role logins succeed.
- Order create/assign/status flow succeeds.
- POD upload + metadata succeeds for delivered order.
- Driver location flow visible to Admin/Dispatcher.
- Billing summary and seat/invitation flows are reachable by Admin.
- No P0/P1 defects remain open.
