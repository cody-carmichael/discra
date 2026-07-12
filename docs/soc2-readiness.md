# SOC 2 Readiness — Gap Analysis

**Date:** 2026-06-29 · **Scope:** Security, Availability, Confidentiality trust criteria
**Goal:** not certification now — get as close as practical cheaply, and avoid controls that are
expensive to retrofit later. Statuses: **Met / Partial / Gap**.

Companion doc: [gdpr-readiness.md](gdpr-readiness.md) (PII handling). Security remediation
history: PRs #184–#187 (RBAC matrix, invitation hardening, S-1…S-9 backlog).

> Items marked *(#187)* are implemented on the open PR `fix/security-hardening-s3-s5` and count
> as Met once it merges and deploys.

## Control assessment

### 1. Access control & least privilege — **Partial (mostly Met)**

| Aspect | Status | Evidence |
|---|---|---|
| App-layer RBAC (Admin/Dispatcher/Driver) | Met | `backend/auth.py` `require_roles`; 48-endpoint × 3-role deny matrix in `backend/tests/test_rbac_matrix.py` (PR #184) |
| Object-level authorization (IDOR) | Met | driver-own-order/POD/route guards + cross-org 404s, all matrix-tested (#184) |
| Tenant isolation | Met | every store keyed by `org_id` from the verified JWT; `_require_tenant_order` |
| JWT verification | Met | RS256-only, issuer+audience+exp enforced (`auth.py:_decode_jwt`); startup guard refuses `JWT_VERIFY_SIGNATURE=false` when deployed *(#187, S-8)* |
| Lambda IAM least privilege | Met *(#187)* | all grants scoped to ARNs; zero bare `Resource: "*"` after S-4/S-6 |
| Human AWS-account access | **Gap** | not managed in-repo: no documented IAM user/MFA/root-lockdown policy |
| Cognito password/MFA policy | **Gap** | user pool is provisioned outside `template.yaml`; policy not codified or evidenced |

**Smallest changes:** document the AWS account access policy (root MFA, no long-lived keys,
admin via SSO/MFA); export the Cognito pool's password/MFA config into the repo (or manage the
pool in the template) so it is evidenced and reviewable.

### 2. Audit logging — **Partial**

| Aspect | Status | Evidence |
|---|---|---|
| Sensitive actions logged w/ actor + roles + request id | Partial | `AuditLogRecord` written for order assign/unassign/bulk/update, all billing actions, onboarding decisions (`routers/*.py` `_audit_event`) |
| Coverage gaps | **Gap** | order **status transitions** (`orders.py:update_order_status`) and **POD metadata creation** (`pod.py:create_pod_metadata`) write no audit event; auth events (login/logout/dev-auth) not audited |
| Tamper evidence | **Gap** | the function role has `dynamodb:DeleteItem`/`UpdateItem` on `AuditLogsTable` (`template.yaml` DynamoDB policy) — a compromised function could erase its own trail |
| Retention | Partial | no TTL on `AuditLogsTable` → retained indefinitely (good), but retention is implicit, not a stated policy; PITR enabled *(#187, S-9)* |
| Review | **Gap** | Admin/Dispatcher audit viewer exists (`/audit/logs` + console panel) but no periodic-review practice defined |

**Smallest changes (cheap-now):** (1) split the IAM policy so the audit table gets
**put/query-only** (no delete/update) — one template statement; (2) add `_audit_event` calls to
`update_order_status` and `create_pod_metadata`; (3) one sentence of stated retention policy in
this doc or the ledger.

### 3. Encryption — **Met** (in transit and at rest)

| Aspect | Status | Evidence |
|---|---|---|
| In transit | Met | HTTPS-only API Gateway; AWS SDK calls over TLS; HSTS sent over HTTPS (S-1, merged) |
| DynamoDB at rest | Met *(#187)* | `SSEEnabled: true` on all 13 tables (AWS-managed `aws/dynamodb` KMS key, CloudTrail-auditable) — S-7 |
| S3 at rest | Met | `AES256` SSE + full PublicAccessBlock; versioning + lifecycle *(#187, S-9)* |
| Key management | Partial | AWS-managed keys only — no customer-managed CMK (no rotation control / key-policy audit) |

**Cheap-now / expensive-later:** CMK is a **later** item — switching DynamoDB/S3 to a CMK is a
non-destructive property update, so deferring it does not create rework. Adopt only if an
auditor/customer requires key-policy control.

### 4. Change management — **Partial**

| Aspect | Status | Evidence |
|---|---|---|
| PR-based workflow | Met (practice) | all changes land via reviewed PRs (#180–#187 history) |
| CI gates | Met | `python-backend-ci.yml`: Ruff (E9,F63,F7,F82) + pytest (397 tests) + `sam build`; `validate-openapi.yml` (Spectral); `mobile-ci.yml` (typecheck) |
| Enforcement | **Gap** | **`main` has no branch protection** (verified via GitHub API 2026-06-29) — direct pushes and merges without review/green CI are possible |
| Deploy traceability | Met | `deploy-dev.yml` deploys via CI with Version=Git SHA + post-deploy smoke |

**Smallest change (cheap-now, 5 minutes):** enable branch protection on `main` — require PR,
require `python-backend-ci` green, no force pushes. This is the single highest-value SOC-2 item
in this document.

### 5. Monitoring & alerting — **Gap**

| Aspect | Status | Evidence |
|---|---|---|
| Structured request logs + correlation ids | Met | `app.py` request middleware (`x-request-id`, JSON logs) |
| No PII in logs | Met *(#187)* | S-5 redaction + `test_email_log_redaction.py` |
| Alarms (5xx, latency, throttles, DLQ) | **Gap** | no CloudWatch alarms or dashboard in `template.yaml` |
| Log retention | **Gap** | no explicit `AWS::Logs::LogGroup` resources → default never-expire, unmanaged |
| Error tracking (web/mobile) | **Gap** | none (planned in playbook 6.1) |

**Smallest changes:** add explicit log groups with `RetentionInDays` (e.g. 90) and two alarms
(API 5xx rate, Lambda errors) to the template — small YAML, big audit value. Full observability
is scheduled as Phase 6.1.

### 6. Incident response — **Gap**

No runbook, severity definitions, contact list, or customer-notification path exists.
**Smallest change:** a one-page `docs/incident-response.md`: severity ladder, first-hour steps
(revoke keys, rotate secrets, disable dev flags, snapshot logs), owner contacts, and the
customer/breach notification decision point (links to GDPR breach section). Cheap-now.

### 7. Backup & restore — **Partial → Met *(#187)* pending one doc**

| Aspect | Status | Evidence |
|---|---|---|
| DynamoDB PITR | Met *(#187)* | enabled on the 9 persistent business tables (S-9); ephemeral TTL'd tables deliberately excluded |
| S3 versioning | Met *(#187)* | POD bucket versioning + 90d noncurrent lifecycle (S-9) |
| Restore procedure | **Gap** | never documented or exercised |

**Smallest change:** document + one dry-run of a PITR table restore and an S3 version
retrieval on the dev stack (fits Phase 6.1); record the evidence in the ledger.

### 8. Vendor management — **Partial**

Subprocessors in the data path (full table with data categories in
[gdpr-readiness.md](gdpr-readiness.md)): **AWS** (all data), **Stripe** (billing), **Google**
(Gmail read for order ingest), **Anthropic** (email content for AI parsing/format detection),
**OpenRouteService** (route coordinates), **CARTO** (map tiles, client-side). All are
standard-DPA vendors; nothing is evidenced.

**Smallest change:** the vendor register in the GDPR doc (done there) + link each vendor's
DPA/terms; review annually. Cheap-now.

## Prioritized remediation list

| # | Item | Criterion | Effort | Timing |
|---|------|-----------|--------|--------|
| 1 | **Branch protection on `main`** (require PR + green CI) | Change mgmt | 5 min | **Cheap-now** |
| 2 | Audit table IAM → put/query-only (no delete/update) | Audit | XS (template) | **Cheap-now** |
| 3 | Audit coverage: status transitions + POD creation | Audit | S | **Cheap-now** |
| 4 | Explicit log groups w/ retention + 5xx/error alarms | Monitoring | S (template) | Cheap-now / 6.1 |
| 5 | `docs/incident-response.md` one-pager | IR | S | **Cheap-now** |
| 6 | Documented + dry-run restore procedure | Backup | S | 6.1 |
| 7 | AWS human-access + Cognito password/MFA policy evidenced | Access | S (doc) | Cheap-now |
| 8 | Error tracking + dashboard | Monitoring | M | 6.1 |
| 9 | Customer-managed CMK for tables/bucket | Encryption | M | **Later, only if required** (non-destructive to defer) |

**Expensive-later watchlist:** none of the current gaps get materially harder with time —
the classic traps (no audit trail, no encryption, unmanaged log retention) are already
covered or queued above. The one to not postpone past real-customer data is #2
(audit tamper-evidence), since it cannot retroactively protect events written before it.
