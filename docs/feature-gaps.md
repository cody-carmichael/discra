# Feature Gap Analysis — Alpha (Step 4.1)

**Date:** 2026-06-29 · **Scope:** what a last-mile delivery-dispatch pilot customer will expect
vs. what exists. Assessment only — no code. Sources: README migration roadmap (38 items),
`docs/ALPHA.md` §2b feature matrix (~55 routes), and the Phase 3 compliance analyses
([gdpr-readiness.md](gdpr-readiness.md) must-BUILD list folds in here).

Impact = pilot impact (**Must / Should / Could** for alpha). Effort = S / M / L.

## What already exists (don't rebuild)

Order intake ×3 (admin console, signed webhook, Gmail ingest w/ per-org rules + AI parsing) ·
dispatch queue w/ server-side filters + bulk assign/unassign · driver inbox → status flow →
POD (photo + signature, idempotent) w/ admin viewer · live driver map + roster · route
optimization + directions (assigned-order geocoding) · Stripe seat billing e2e (checkout,
portal, webhooks, invitations) · tenant onboarding w/ approver review · audit log + viewer ·
dispatch KPI summary · web push · PWA installs + native Expo app · profile management
(`/users/me` + photo) · **password reset** (Cognito Hosted UI built-in — verify in UAT) ·
session expiry (12h web cookie TTL, JWT exp, mobile expiry watchdog).

## Gap table

| # | Gap | Impact | Effort | Notes |
|---|-----|--------|--------|-------|
| G-1 | **Invited users don't receive a working role** — seat-invite activation writes the app record + consumes the seat but never sets the Cognito group, so the invitee's JWT carries no role (ledger **I-1**, Sev2) | **Must** | M | The invitation feature is functionally incomplete for real users; reuse `ensure_admin_access(..., role_name=...)`. Pilot workaround (console group assignment) exists but doesn't scale past day one |
| G-2 | **Failed-delivery reasons are lost** — `StatusUpdateRequest.notes` is accepted and **silently dropped** by `update_order_status` (verified: only `create_order` persists notes); no structured reason codes, nothing surfaces to dispatch | **Must** | S | Drivers *will* fail deliveries in week one. Persist a status-note/reason on the order (+ audit event — also closes the SOC-2 status-transition audit gap), show it on the admin card |
| G-3 | **Privacy policy page** (web + linked from mobile) | **Must** | S | GDPR art. 13 — pre-pilot ([gdpr-readiness.md](gdpr-readiness.md)) |
| G-4 | **Driver-location transparency notice** (PWA + Expo, acknowledged on first use) | **Must** | S | GDPR 6(1)(f) transparency obligation — pre-pilot |
| G-5 | Customer delivery notifications (email on assignment/en-route/delivered) | Should | M | Table-stakes for delivery SaaS; pilot can operate without. Start email-only via existing SES plumbing; **SMS = Could/later** (new vendor) |
| G-6 | POD sharing with the end customer (share link / attach to delivered email) | Should | M | Admin-only viewer today (10-min presigned URLs). Natural companion to G-5 |
| G-7 | Per-order history timeline | Should | S/M | Audit events exist for assign/update but **not status transitions** (G-2 adds them); needs `target_id` filter + a simple order-detail timeline |
| G-8 | Order + report CSV export | Should | S | Dispatchers live in spreadsheets; queue + dispatch-summary → CSV |
| G-9 | Driver ETA surfaced per order | Should | M | Route durations already computed internally (`/routes/*`); not shown per order to dispatch or customers |
| G-10 | DSAR export / erasure admin actions | Should | M | GDPR art. 15/17 — build before meaningful data accumulates; org-scoped model makes it tractable |
| G-11 | Mobile offline queue (status/location/POD while offline → sync) | Should | M/L | README over-claimed this (M-3, corrected); drivers hit dead zones. NetInfo + AsyncStorage queue + drain |
| G-12 | Search/filter at scale — orders list has **no pagination** (full org list per request) | Should | M | Fine at pilot volume; **verify with 200+ seeded orders in Step 4.2** before building pagination |
| G-13 | Retention policy + scheduled purge (orders/POD) | Could | M | GDPR 5(1)(e); define the policy now (doc), build the job before data ages |
| G-14 | Manual multi-stop route reordering (drag to override optimizer) | Could | M | Auto-optimize exists; manual override is power-user polish |
| G-15 | Idle session timeout (absolute 12h TTL only today) | Could | S | Lower the web-session TTL or add idle logout; weigh dispatcher annoyance |
| G-16 | CSV order import | Could | S/M | Webhook + email + manual already cover intake for the pilot |
| G-17 | Mobile admin dispatch actions (assign/status from Expo AdminScreen — read-only today, F-3) | Could | M | Scope decision: web console is the dispatch surface for alpha |
| G-18 | SMS notifications | Could | M | After G-5 email proves the flow; adds Twilio/SNS vendor + cost |

## Recommended "Must-have for alpha" shortlist

Build order (highest pilot impact ÷ effort first):

1. **G-2 — persist + surface failed-delivery reasons** (S): fixes a silent data-loss bug, closes an
   audit gap, and covers the most common day-one operational event.
2. **G-1 — Cognito group on invite activation** (M): without it, invited dispatchers/drivers can't
   actually use the product. Blocks multi-user pilot.
3. **G-3 + G-4 — privacy policy + location notice** (S+S): legal pre-pilot gate; two small static/UI
   items, shippable together in one PR.

Everything else is **Should/Could** for alpha. Strong candidates for the first post-alpha batch:
G-5+G-6 (customer email w/ POD link — the highest-delight pair), G-7+G-8 (dispatcher quality of
life), G-11 (offline queue).

> Robustness note for Step 4.2: G-12 (no pagination) is the main "feels broken at scale" risk —
> exercise with `tools/pilot/seed_orders_webhook.py --count 200` before deciding whether pagination
> makes the alpha bar.
