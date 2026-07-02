# GDPR Readiness — Gap Analysis

**Date:** 2026-06-29 · **Scope:** personal-data handling across backend, web, mobile, and infra.
Statuses: **Met / Partial / Gap**. Companion: [soc2-readiness.md](soc2-readiness.md).

**Roles:** for tenant business data (their customers' orders, their drivers' locations) Discra
acts as **processor** on the tenant's instructions; for onboarding/registration and account data
Discra is the **controller**. A Discra↔tenant DPA does not yet exist (see Build list).

## 1. Data inventory — what PII we hold, and where

| Data | Subjects | Store | Retention today | Lawful basis (art. 6) |
|---|---|---|---|---|
| Staff identity: name, email, phone, profile photo, TSA flag | Tenant staff | Cognito; `UsersTable`; S3 `profile-photos/` | Indefinite | 6(1)(b) contract — account/service provision via the tenant |
| Customer order PII: name, pickup/delivery address, phone, email, free-text notes | Tenant's customers | `OrdersTable` (sources: admin console, orders webhook, Gmail ingest, AI parse) | Indefinite | Tenant's basis: 6(1)(b) delivery contract / 6(1)(f) fulfillment; Discra processes on instruction (art. 28) |
| Driver geolocation (lat/lng/heading, timestamped) | Drivers | `DriverLocationsTable` | **TTL'd** (`expires_at_epoch`) ✓ | 6(1)(f) legitimate interest (dispatch ops, employment context) — **not consent** (invalid under employer–employee imbalance); transparency notice required |
| POD artifacts: delivery photos, **recipient signature images**, capture location, notes | Customers + drivers | S3 `pod/{org}/{order}/{driver}/`; `PodArtifactsTable` | Indefinite (+ 90d noncurrent versions) | 6(1)(b)/(f) proof of delivery. Signature images are ordinary PII here (not art. 9 biometric — no identification processing) |
| Gmail integration: connected mailbox address, **OAuth refresh token** (mailbox credential), rules | Tenant + email senders | `EmailConfigTable` | Until disconnect | Tenant admin's OAuth authorization + 6(1)(b); third-party sender data: tenant's 6(1)(f) order processing |
| Skipped-email log: sender, subject, reason | Email senders | `SkippedEmailsTable` | **TTL'd** ✓ | 6(1)(f) ops triage (short-lived) |
| Invitations / onboarding: invitee email+role; requester email, contact name, tenant, notes | Staff / prospects | `SeatInvitationsTable`; `OnboardingRegistrationsTable` | Indefinite | 6(1)(b) contract / pre-contractual steps at the data subject's request |
| Audit trail: actor id, roles, action, details (may embed invitee emails) | Staff | `AuditLogsTable` | Indefinite (deliberate) | 6(1)(f) security & accountability (supports art. 32 obligations) |
| Push subscriptions: endpoint URL + crypto keys | Drivers/staff | `PushSubscriptionsTable` | **TTL'd** ✓ | 6(1)(b) — notifications are a requested service function |
| Application logs | — | CloudWatch | **PII-redacted** (S-5, #187) ✓; retention unmanaged | 6(1)(f) security/ops (minimized by design) |
| Backups | all of the above | DynamoDB PITR (35d rolling) + S3 versions (90d) | rolls off automatically | Same basis as the underlying data (availability/integrity) |

At rest all stores are encrypted (SSE-KMS on tables, SSE-S3 + versioning on the bucket — #187);
access is org-scoped + RBAC/IDOR-tested (#184).

## 2. Sub-processors and data flows

| Vendor | Personal data sent | Notes / action |
|---|---|---|
| AWS (us-east-1) | all stored data | standard AWS DPA applies automatically |
| Stripe | tenant billing contact, org linkage | standard Stripe DPA |
| Google (Gmail API) | reads the tenant-connected inbox (email content incl. third-party PII); refresh token held by us | scope is read+label; user-consented OAuth. **Action:** confirm scope minimization + record terms |
| **Anthropic** | **full email content** (subject/body/PDF text, capped ~12k chars; screenshots for detect-format) for AI order parsing | **Action:** execute/record DPA and confirm zero-data-retention API terms |
| OpenRouteService | route waypoints (lat/lng only — no names/addresses) | low sensitivity; EU-based |
| Amazon Location | delivery address text (geocoding), coordinates (matrix) | covered by AWS DPA |
| CARTO | map-tile requests from the browser (IP, viewport) | client-side; note in privacy policy |

**Gap:** no vendor/DPA register existed before this table. This table is now it — link each
vendor's DPA and review annually.

## 3. Assessment

| # | Requirement | Status | Evidence / gap | Smallest fix |
|---|---|---|---|---|
| 1 | Lawful basis & roles | Partial | Processing is on tenant instructions (contract); driver location = employment context; no Discra↔tenant **DPA** exists | DPA template as part of the pilot contract (**build**) |
| 2 | Transparency / privacy policy | **Gap** | no privacy policy anywhere (web, mobile, onboarding) | publish policy page; link from login/register + app settings (**build**) |
| 3 | Transparency for driver location tracking | **Gap** | driver PWA + mobile app send location with no notice or in-app disclosure. Basis is 6(1)(f) legitimate interest (employment context — consent would be invalid there), which makes **transparency** the binding obligation | one-time in-app notice ("location is shared with your dispatcher while on shift") in PWA + Expo, acknowledged on first use; documented in the privacy policy (**build**) |
| 4 | Data minimization | Partial | good: TTLs on location/push/skipped-email; POD size caps; log redaction (S-5). Weak: full email bodies sent to AI parsing; indefinite orders/POD | scope AI parse to matched-rule emails only (already the case for the poller — verify elevate path); retention below |
| 5 | Retention & deletion policy | **Gap** | no policy or job for orders / POD / invitations / onboarding records | define policy (e.g. orders+POD N months post-delivery, configurable per tenant) + a scheduled purge job (**build**) |
| 6 | Right of access (export) | **Gap** | no per-person export; data is org-scoped, not person-scoped | admin "export person data" action: given email/driver-id, export matching rows (users, orders-by-customer-contact, PODs, invitations, audit refs) (**build**) |
| 7 | Right to erasure | **Gap** | no per-person delete; spans UsersTable + Cognito + S3 photos + order PII fields + POD artifacts; PITR/S3 versions age out (35d/90d) — document that caveat | admin "erase person" action (delete or field-level anonymize orders); document backup roll-off (**build**) |
| 8 | Security of processing (art. 32) | Met | encryption at rest/in transit, RBAC+IDOR tested, tenant isolation, secrets not logged, headers/CORS/throttling — see SOC-2 doc §1–3 | — |
| 9 | Breach notification readiness | **Gap** | no runbook; as processor we must notify tenant controllers without undue delay (their 72h clock) | shared IR runbook w/ breach decision point ([soc2-readiness.md](soc2-readiness.md) §6) |
| 10 | International transfers | Met (n/a) | hosting + subprocessors in US; pilot tenant US-based; revisit if EU data subjects appear | note in privacy policy |

## 4. What must be BUILT (feeds Phase 4/6 backlogs)

| Build item | GDPR hook | Effort | Priority |
|---|---|---|---|
| Privacy policy page (web + mobile links) | Art. 13 | S | **High — before pilot users** |
| Driver location notice/consent (PWA + Expo) | Art. 13 / employment transparency | S | **High — before pilot drivers** |
| Discra↔tenant DPA in the pilot agreement | Art. 28 | S (doc) | High |
| Retention policy + scheduled purge job (orders/POD) | Art. 5(1)(e) | M | Medium — before data accumulates |
| Person-data export (DSAR) admin action | Art. 15 | M | Medium |
| Person-data erasure/anonymize admin action | Art. 17 | M | Medium |
| Breach/IR runbook (shared with SOC-2) | Art. 33/34 | S | High |
| Anthropic + Google DPA/terms recorded in §2 register | Art. 28 | XS | High (paperwork) |

**Bottom line:** technical/security measures (art. 32) are in good shape after Phases 2–3; the
gaps are almost entirely **subject-rights plumbing and paperwork** (policy, notices, DPAs,
retention, DSAR). None require re-architecture — the org-scoped data model makes export/erasure
tractable — but the two **High** UI items (privacy policy, location notice) should land before
real pilot users sign in.
