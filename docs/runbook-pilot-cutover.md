# Discra Pilot Cutover Runbook

> Step 6.2. What is verified ready, what blocks cutover, and the exact steps to run.
>
> Every "verified" line below was checked against the live `discra-api-dev` stack on
> **2026-07-26**. Anything not verified is labelled. Complements
> [`pilot-uat-checklist.md`](pilot-uat-checklist.md) (what testers do) and
> [`runbook-ops.md`](runbook-ops.md) (what you do when it breaks).

---

## 1. Environment — verified ready

| Item | State |
|---|---|
| Stack | `discra-api-dev`, `us-east-1`, acct `422814825143` |
| API base | `https://m50fjhgrn7.execute-api.us-east-1.amazonaws.com/dev` |
| Health / version | `/backend/health` 200 · `/backend/version` = deployed SHA |
| Deploy pipeline | `deploy-dev.yml` auto-deploys `main` → SAM build → deploy → smoke |
| **Dev-auth (A-6)** | **Disabled and verified closed** — login 404s for all three roles, `dev_auth_enabled:false`, pre-existing dev sessions rejected 401 |
| Cognito groups | `Admin`, `Dispatcher`, `Driver` all exist |
| Onboarding | Enabled; approver allowlist + SES sender configured; review link TTL 48h |
| Backups | PITR on 9 persistent tables; **restore drill PASSED** (see ops runbook §6) |
| Monitoring | 8 alarms + dashboard + 30-day log retention, live |

Because dev-auth is now off, **every pilot login goes through the Cognito Hosted UI.**
There is no credential-free path any more — which is the point, but it means tester
accounts must exist before anyone can do anything.

---

## 2. Blockers — resolve before cutover

### B-1. SES is in sandbox — external testers get no email **(has lead time)**

`ProductionAccessEnabled: false`; quota 200/day, 1/sec. Only `pdahs1@gmail.com` is a
verified identity, and **sandbox mode rejects any recipient that is not verified.**

Effect on the onboarding flow:

| Email | Recipient | Sandbox result |
|---|---|---|
| Approver notification ("registration pending") | `pdahs1@gmail.com` | ✅ delivered |
| Approve / reject decision | the **external tester** | ❌ **not delivered** |

The approval itself still succeeds — the send is best-effort inside a `try` — so the
tester's org and Cognito group are set correctly, they just never hear about it. Until
this session the failure was also swallowed with no log at all; it now logs a warning.

**Action:** request SES production access (~24h turnaround). **Start this first** — it is
the only cutover item you cannot do on the day. Interim workaround: verify each tester's
address individually as an SES identity, or tell them out-of-band once approved.

### B-2. No single-role test users — RBAC cannot be validated

`cody.carmichael` is a member of **all three groups** simultaneously. `require_roles`
authorises on set intersection, so that account passes **every** role check and also
counts as privileged for driver-scoped object guards.

That means a UAT walk driven by this account **cannot detect a role-separation failure** —
every per-role section of the checklist passes trivially, including the cases that are
supposed to be denied. It would have masked exactly the class of bug R-1 was.

Current membership:

| Group | Members |
|---|---|
| Admin | `cody.carmichael`, `cody.t.carmichael` |
| Dispatcher | `cody.carmichael` *(only)* |
| Driver | `cody.carmichael` *(only)* |

**Action:** create one **single-role** user per role — see §3.1. Do not run the UAT walk
without them.

### B-3. Demo data is thin and inconsistent

22 orders in `org-pilot-1`, 5 in `org-smoke`. Status spread: 22 `Assigned`, 3 `EnRoute`,
1 `Created`, **1 `Delivered`, 0 `Failed`**.

- With one Delivered and no Failed order, the **history view and the G-2 failure-reason
  feature are effectively undemonstrated** — those were built this cycle specifically to
  make failed deliveries visible.
- Two different field shapes coexist: 22 orders use `reference_id` / `pick_up_street` /
  `delivery_street` (admin-UI shape), 5 use `reference_number` / `pick_up_address` /
  `delivery` (webhook shape). Worth knowing before a tester reports it as a bug.

**Action:** seed a realistic spread (§3.2), including at least two `Failed` orders with
reasons and several `Delivered`.

---

## 3. Steps that need credentials — run these yourself

These need secrets that live in GitHub Actions / your password manager. They are written
out so they can be run without further research.

### 3.1 Create single-role test users

For each role, create the user, set a password, and add exactly **one** group. Substitute
your own values; do not paste passwords into shared channels.

```bash
aws cognito-idp admin-create-user --user-pool-id us-east-1_vMav7IRF7 --username pilot.dispatcher --user-attributes Name=email,Value=<address> Name=email_verified,Value=true Name=custom:org_id,Value=org-pilot-1 --desired-delivery-mediums EMAIL
```

Then add the single group (repeat per user with `Admin` / `Dispatcher` / `Driver`):

```bash
aws cognito-idp admin-add-user-to-group --user-pool-id us-east-1_vMav7IRF7 --username pilot.dispatcher --group-name Dispatcher
```

**Verify the isolation is real before trusting the UAT run** — each user must be in exactly
one group:

```bash
aws cognito-idp admin-list-groups-for-user --user-pool-id us-east-1_vMav7IRF7 --username pilot.dispatcher --query 'Groups[].GroupName'
```

> While SES is in sandbox (B-1), `--desired-delivery-mediums EMAIL` will not reach an
> unverified address. Either verify the address first or set the password yourself with
> `admin-set-user-password`.

### 3.2 Seed demo data

Uses the orders webhook, so it needs `ORDERS_WEBHOOK_TOKEN` (a GitHub secret — not stored
in this repo or in any local `.env`):

```bash
python tools/pilot/seed_orders_webhook.py --endpoint "https://m50fjhgrn7.execute-api.us-east-1.amazonaws.com/dev/backend/webhooks/orders" --token "<ORDERS_WEBHOOK_TOKEN>" --org-id "org-pilot-1" --count 25
```

Re-sending the same external ids should upsert, not duplicate — worth confirming, since
it is the ingest property a pilot is most likely to stress.

Then drive a few orders to `Delivered` and at least two to `Failed` **with reasons**, so
the history view and failure-reason feature have something to show.

### 3.3 Generate the tester handover pack

```bash
pwsh tools/pilot/export-pilot-summary.ps1 -StackName "discra-api-dev" -Region "us-east-1"
```

The dead `HealthUrl` / `VersionUrl` entries were removed from this pack (O-1); it now emits
`BackendHealthUrl`, `BackendVersionUrl`, the UI URLs, the webhook URL, and the ops
dashboard.

---

## 4. Cutover-day verification

Run after the blockers are cleared, in this order.

1. **Deploy is current** — `/backend/version` equals the `main` tip.
2. **Dev-auth stays shut** — must be `404`:
   ```bash
   curl -s -o /dev/null -w "%{http_code}\n" -X POST https://m50fjhgrn7.execute-api.us-east-1.amazonaws.com/dev/backend/ui/dev-auth/login -H 'content-type: application/json' -d '{"role":"Admin"}'
   ```
3. **Smoke** — `pwsh tools/smoke/run-smoke.ps1 -ApiBaseUrl ... -AdminToken ...`
4. **Role separation** — sign in as the single-role Driver and confirm the admin console
   is refused. **If this passes trivially, check group membership before believing it.**
5. **Alarms are quiet** — all 8 `OK`, no stale `ALARM` from cutover activity.
6. **Walk `pilot-uat-checklist.md`** per role, with the single-role accounts.

---

## 5. Known limitations to tell testers

- **First request after idle is slow (~7s).** The API Lambda is container-image based and
  cold-starts at ~7.2–7.3 s; warm requests are 5–130 ms. Provisioned concurrency was
  deferred as a cost decision. Tell testers, or they will file it as a bug.
- **No offline queue in the mobile app** — offline writes error rather than queueing.
- **No per-IP rate limiting** — only aggregate stage throttling (100 req/s). WAF deferred.
- Route optimisation quality depends on Amazon Location / geocoding data.
- Webhook ingest requires the shared token (plus HMAC headers when enabled).
- Gmail ingest tokens expire after 7 days and need reconnecting.
