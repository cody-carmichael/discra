# Discra Pilot UAT Checklist

Use this checklist when handing Discra to an external tester for MVP validation.

> **Run [`runbook-pilot-cutover.md`](runbook-pilot-cutover.md) first.** It covers the
> environment prep and the blockers that must be cleared before this checklist means
> anything — in particular SES sandbox (tester emails are not delivered) and single-role
> test accounts (without them, every role check below passes trivially).

## 1) Environment prep

- Confirm latest `main` is deployed: `/backend/version` must equal the `main` tip.
- Generate stack summary:
  - `tools\pilot\export-pilot-summary.ps1 -StackName "discra-api-dev" -Region "us-east-1"`
- Run smoke checks:
  - `tools\smoke\run-smoke.ps1 -ApiBaseUrl "https://<api-id>.execute-api.us-east-1.amazonaws.com/dev" -AdminToken "<ADMIN_TOKEN>" -OrdersWebhookToken "<ORDERS_WEBHOOK_TOKEN>"`
- Verify Cognito groups exist: `Admin`, `Dispatcher`, `Driver`.
- **Confirm dev-auth is disabled** — this must return `404`:
  - `POST <api-base>/backend/ui/dev-auth/login {"role":"Admin"}`
  - A `200` here means the stack is serving a credential-free Admin login (ledger A-6).
    Stop and fix before going further.
- **Confirm each test user is in exactly ONE group** (`admin-list-groups-for-user`). A
  multi-role account passes every check below regardless of whether RBAC works.

> Health checks are `/backend/health` and `/backend/version`. The bare `/health`,
> `/version`, and `/admin/ping` routes no longer exist and return 404 (O-1).

## 2) Tester package to share

- Admin UI URL (`/backend/ui/admin`)
- Driver UI URL (`/backend/ui/driver`)
- Temporary Cognito test users — **one per role, each in a single group**
- Test org id (example: `org-pilot-1`)
- Sign-in is via the **Cognito Hosted UI**; there is no dev/no-password login path.
- Known limitations for pilot:
  - **first request after an idle period takes ~7 s** (container cold start); warm
    requests are 5–130 ms — expected, not a defect
  - mobile app has **no offline queue** — offline writes error rather than queueing
  - route optimization quality depends on Amazon Location data/geocoding quality
  - webhook ingest requires shared token (and HMAC headers if enabled)
  - Gmail ingest tokens expire after 7 days and need reconnecting

## 3) Admin checks

- Log in via hosted UI.
- Open dispatch summary and confirm KPI data loads.
- Create at least 2 orders via the admin console, filling the required fields.
  - Note: the console's create form uses `reference_id` / `pick_up_street` /
    `delivery_street`; the field names `reference_number` / `pick_up_address` /
    `delivery` are the **webhook payload** shape (§6). Both exist in the data today.
- Assign one order to a driver and verify audit log event appears.
- Open billing summary/status and confirm seat counts and provider readiness render.
- Confirm a **Failed** order shows its failure reason in the orders table, and that the
  history view lists both `Delivered` and `Failed` orders.

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
- **Role separation holds:** the single-role Driver is refused the admin console and
  cannot read another driver's order; the Dispatcher is refused billing/org endpoints.
- **Dev-auth returns 404** (re-check at sign-off, not only at prep).
- No P0/P1 defects remain open.

## 8) Feedback capture

- File defects using issue template:
  - `.github/ISSUE_TEMPLATE/pilot-bug-report.yml`
- File run-level UAT result using:
  - `.github/ISSUE_TEMPLATE/pilot-uat-result.yml`
