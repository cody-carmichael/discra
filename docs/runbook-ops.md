# Discra Ops Runbook

> Operational procedures for the deployed stack: what is protected, how to restore
> it, and what to do when an alarm fires. Written for Phase 6.1 (pilot cutover).
>
> **Scope:** the `discra-api-dev` stack in `us-east-1` (account `422814825143`).
> The same procedures apply to any future stack — substitute the stack name.
>
> Every fact below was verified against the live account on **2026-07-26**. Claims
> that have *not* been exercised end to end are marked **UNDRILLED** — treat those
> as designs, not proven procedures.

---

## 1. What is protected

| Asset | Protection | Verified |
|---|---|---|
| 9 persistent DynamoDB tables | Point-in-time recovery (PITR), 35-day rolling window | ✅ live: all 9 `ENABLED` |
| 4 ephemeral DynamoDB tables | **None, by design** — TTL'd, reconstructable | ✅ live: all 4 `DISABLED` |
| All 13 tables | SSE-KMS with the AWS-managed `aws/dynamodb` key | ✅ live: 13/13 |
| POD photos + signatures (S3) | Bucket versioning + lifecycle | ✅ live: versioning `Enabled`, `expire-noncurrent-versions` rule active |
| Lambda logs | 30-day retention (`LogRetentionDays`) | ⚠️ takes effect on next deploy — see §5 |

**Persistent (PITR on):** `organizations`, `users`, `orders`, `pod-artifacts`,
`seat-subscriptions`, `seat-invitations`, `audit-logs`, `onboarding-registrations`,
`email-config`.

**Ephemeral (PITR deliberately off):** `driver-locations`, `push-subscriptions`,
`skipped-emails`, `ws-connections`. These carry TTLs and rebuild themselves from
live traffic; paying to back them up would protect nothing. If you add a table,
decide which list it belongs to and update both the template and this table.

Current PITR window on `discra-orders-discra-api-dev` (checked 2026-07-26):
earliest restorable `2026-07-12T08:14:56-05:00`. The window grows to 35 days and
then rolls; **PITR was enabled 2026-07-12, so anything before that date is not
recoverable.**

---

## 2. Restoring DynamoDB data (PITR)

### The constraint that shapes every procedure

**PITR cannot restore in place.** `restore-table-to-point-in-time` always creates a
**new** table. The live table names are fixed by the template
(`discra-orders-${AWS::StackName}`), so a restored table never lands on the name the
application reads. Every procedure below is built around that.

A restored table also does **not** inherit: PITR (off), TTL configuration, tags,
stream settings, or auto-scaling. Re-apply what you need afterwards.

### 2a. Scoped repair — the common case **UNDRILLED**

Use when specific records were corrupted or deleted (bad import, mistaken bulk
action) and the rest of the table is healthy. This is the expected pilot scenario.

```bash
aws dynamodb restore-table-to-point-in-time --source-table-name discra-orders-discra-api-dev --target-table-name discra-orders-restore-20260726 --restore-date-time 2026-07-26T12:00:00Z
```

Then wait for `ACTIVE`, read the good records out of the restored table, and write
only those records back into the live table. Delete the restored table when done —
it bills as a normal table until you do.

```bash
aws dynamodb wait table-exists --table-name discra-orders-restore-20260726
```

Because the app is org-scoped, always filter by `org_id` when copying records back
so a repair for one tenant cannot touch another.

### 2b. Whole-table loss **UNDRILLED**

Use when a table is gone or wholly corrupt.

1. Restore to a new name (as above) and verify the item count and a sample of
   records before touching anything live.
2. Bring it back into service. Two options, both with real costs:
   - **Copy back** (preferred at pilot scale): recreate the live table by
     redeploying the stack, then bulk-copy items from the restored table. Keeps
     CloudFormation as the source of truth.
   - **Rename-in-place**: not possible in DynamoDB. Deleting the live table and
     restoring into its exact name works, but CloudFormation no longer owns the
     table — the next `sam deploy` will fail or try to recreate it. Only do this
     with a plan to re-import the resource into the stack.
3. Re-enable PITR on whatever table ends up live — restores do not carry it over,
   and a table without PITR is unprotected from that moment on.

> **Do not skip step 3.** The most likely way to turn one incident into two is to
> finish a restore and leave the new table with backups switched off.

### 2c. Restore drill

The procedures in §2a/§2b are **UNDRILLED** — designed against the AWS API contract
but never executed here. Before the pilot carries real customer data, run §2a once
against `discra-orders-discra-api-dev`, restoring to a throwaway table, and record
the result in §6. A drill that has never run is a guess.

---

## 3. Restoring POD artifacts (S3)

Bucket: `discra-api-dev-podartifactsbucket-qb3smjyzucue` (versioning `Enabled`).

Versioning means deletes are recoverable: a "delete" writes a delete marker rather
than removing data.

**Recover a deleted object** — list its versions, find the delete marker, remove the
marker:

```bash
aws s3api list-object-versions --bucket discra-api-dev-podartifactsbucket-qb3smjyzucue --prefix "<org>/<order>/" --query '{Versions:Versions[].{Key:Key,Id:VersionId,Latest:IsLatest},Markers:DeleteMarkers[].{Key:Key,Id:VersionId}}'
```

Deleting the delete marker (by its version id) makes the previous version current
again. **Recover an overwritten object** by copying the desired older version back
over the current key.

**Retention limit:** the `expire-noncurrent-versions` lifecycle rule permanently
removes noncurrent versions after 90 days, and abandoned multipart uploads after 7.
Recovery beyond 90 days is not possible — this is intentional (storage-limitation),
not a gap.

---

## 4. Alarms — what fires and what to do

All alarms publish to SNS topic `discra-api-dev-ops-alerts`. They fire regardless of
whether anyone is subscribed; set the `OpsAlertEmail` stack parameter to get email
delivery (AWS sends a confirmation link that must be clicked before anything
arrives).

All alarms use `TreatMissingData: notBreaching` — a quiet stack produces no
datapoints, and silence must not read as failure.

| Alarm | Fires when | First move |
|---|---|---|
| `backend-api-errors` | ≥5 Lambda errors in 5 min | Primary "app is broken" signal. Read the backend log group for tracebacks. |
| `backend-api-throttles` | ≥1 throttle in 5 min | Concurrency exhausted — requests are failing outright. Check for a traffic spike or a runaway caller; raise concurrency. |
| `backend-api-duration-p95` | p95 >20s for 10 min | Approaching the 30s timeout. Usually a slow dependency (Stripe, Location, Dynamo scan). |
| `api-5xx` | ≥5 API Gateway 5xx in 5 min | Catches gateway/integration failures that never reach the Lambda error metric. |
| `api-latency-p95` | p95 >5s for 10 min | The console and driver PWA feel broken well before anything errors. |
| `email-poller-errors` | ≥1 error in 15 min | Order intake from email has stopped silently. Check Gmail OAuth token expiry first — the 7-day caveat is documented in the README. |
| `ws-handler-errors` | ≥3 errors in 5 min | Real-time push degraded; app still functions via polling, so this is not user-blocking. |
| `orders-table-throttles` | ≥1 throttled request in 5 min | On-demand tables still throttle when traffic outruns partition auto-scaling. |

Dashboard: `discra-api-dev-ops` (`OpsDashboardUrl` stack output) — API traffic and
latency, per-function invocations/errors/concurrency/duration against the timeout,
and orders-table capacity.

**Alarm count is 8**, deliberately under the 10-alarm free tier. Adding more starts
billing at $0.10/alarm/month — cheap, but keep the set high-signal: an alarm nobody
acts on trains people to ignore the ones that matter.

---

## 5. Log retention **(one-time cleanup owed)**

Before 6.1 every Lambda log group was set to **never expire** — unbounded cost
growth and indefinite retention of request data (a GDPR storage-limitation concern).

The template now declares log groups explicitly with `RetentionInDays` and points
each function at its group via `LoggingConfig`. **This routes logging to new group
names**, so after the next deploy the old groups stop receiving data but remain,
still with no retention:

| Orphaned group | Size | Why |
|---|---|---|
| `/aws/lambda/discra-api-dev-BackendApiFunction-uiGTZYimpFzF` | 11.8 MB | superseded by the managed group |
| `/aws/lambda/discra-api-dev-EmailPollerFunction-q9TfelZpxjGe` | 62.8 MB | superseded by the managed group |
| `/aws/lambda/discra-api-dev-BackendApiFunction-5TL4L3hDRdPl` | 1.2 MB | function long since replaced |
| `/aws/lambda/discra-api-dev-AdminPingFunction-*` | 40 KB | function no longer in the template |
| `/aws/lambda/discra-api-dev-HealthFunction-*` | 54 KB | function no longer in the template |
| `/aws/lambda/discra-api-dev-VersionFunction-*` | 52 KB | function no longer in the template |
| `/aws/lambda/discra-api-health-dev` | 1.7 KB | legacy |

After the deploy that lands 6.1, either set retention on these or delete them —
CloudFormation will not, because it never owned them. Setting retention is the
safer of the two (it preserves recent history and lets the data age out):

```bash
aws logs put-retention-policy --log-group-name /aws/lambda/discra-api-dev-EmailPollerFunction-q9TfelZpxjGe --retention-in-days 30
```

Verify none are left unbounded:

```bash
aws logs describe-log-groups --query 'logGroups[?contains(logGroupName,`discra`) && retentionInDays==null].logGroupName'
```

---

## 6. Drill log

Record every restore drill here. An entry is only valid if the procedure was
actually executed against AWS.

| Date | Procedure | Result | Run by |
|---|---|---|---|
| — | — | *no drill has been run yet* | — |

---

## 7. Known gaps

- **Restore procedures are undrilled** (§2c) — the highest-value next ops action.
- **No per-IP rate limiting.** API Gateway stage throttling (S-3, 100 req/s
  aggregate) is the only limiter; per-IP abuse limiting needs CloudFront + WAF
  (S-3b), deferred by decision.
- **No error-tracking service.** CloudWatch alarms tell you *that* something broke;
  they do not group or de-duplicate stack traces. Sentry was considered and deferred.
- **No cold-start mitigation.** Provisioned concurrency was considered and deferred
  as a cost decision; the first request after idle will be slow.
- **Stale stack outputs.** `HealthUrl`, `VersionUrl`, and `AdminPingUrl` point at
  routes whose functions no longer exist and return 404. Use `BackendHealthUrl` /
  `BackendVersionUrl` instead. Harmless but misleading in the pilot handover pack.
