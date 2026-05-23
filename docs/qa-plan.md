# Discra QA Plan — Mobile + Desktop (Web PWA)

**QA lead:** embedded QA specialist (Claude-assisted)
**Cycle target:** ~2 weeks active QA + bug-fix, then stabilization
**Branch strategy:** one branch + PR per defect (small batches OK for cosmetic clusters)
**Stack under test:**
- Web PWAs served by FastAPI (`backend/frontend/`) — admin + driver + public + simulator
- Mobile Expo app (`mobile/`) — `App.tsx` + `screens/AdminScreen.tsx` + `screens/DriverScreen.tsx`
- Two satellite Lambdas — `email_poller_fn/` (Gmail polling) + `ws_handler_fn/` (WebSocket fan-out)

---

## 1. Scope

| Surface | Artifact | Roles | Auth modes |
|---|---|---|---|
| Web — Admin/Dispatcher PWA | `backend/frontend/admin.html` + `backend/frontend/assets/admin.js` (~4.3k LOC) | Admin, Dispatcher | Hosted UI, dev quick sign-in |
| Web — Driver PWA | `backend/frontend/driver.html` + `backend/frontend/assets/driver.js` (~1.3k LOC) | Driver | Hosted UI, dev quick sign-in |
| Web — Public | `index/landing.html`, `login.html`, `register.html`, `review.html`, `simulator.html` | anon, Admin (review + simulator) | n/a + Admin JWT + simulator allow-list |
| Mobile — App shell | `mobile/App.tsx` (~1k LOC) | all roles | SRP via `amazon-cognito-identity-js` (primary), Hosted UI deep-link (fallback) |
| Mobile — Admin/Dispatcher screen | `mobile/screens/AdminScreen.tsx` (~2.1k LOC) | Admin, Dispatcher | inherited |
| Mobile — Driver screen | `mobile/screens/DriverScreen.tsx` (~1.6k LOC) | Driver | inherited |
| Email poller Lambda | `email_poller_fn/email_poller.py` | system (scheduled) | Gmail OAuth refresh token |
| WebSocket handler Lambda | `ws_handler_fn/ws_handler.py` | all authed roles | Cognito JWT |

Backend Python is **not** the QA target — 19 pytest files (including 5 dedicated email tests) already cover it. Treat backend as a fixed system-under-test; defects found via UI that root-cause to backend get a backend fix in the same PR.

## 2. Test environment

- **Dev stack** — deployed AWS dev at `https://m50fjhgrn7.execute-api.us-east-1.amazonaws.com/dev`. Use `tools/pilot/export-pilot-summary.ps1` to refresh URL list each session.
- **Local fallback** — `uvicorn` on `:8000` for fast iteration when a defect doesn't need Cognito/Stripe/Gmail. The mobile app auto-points to `http://127.0.0.1:8000/dev/backend` when running on `expo start --web` from localhost (see `App.tsx` `DEFAULT_API_BASE`).
- **Test users** — `EnableUiDevAuth=true` gives one-click Admin/Dispatcher/Driver buttons. Pair with at least one real Cognito user per role for SRP and Hosted UI paths.
- **Gmail test account** — one dedicated test Google account with the OAuth app added as a test user; used for connect/disconnect/reauth scenarios. **Note:** in Google Cloud Console "Testing" status, refresh tokens expire after 7 days — `README.md` documents the publish-to-production workaround.
- **Test data** — `tools/pilot/seed_orders_webhook.py --count 25` for baseline; `seed_orders_webhook.py --count 75 --batch-size 50` for scale; plus a fixture of "tricky" orders (time-window today, time-window past, no time-window, very long address, unicode customer name, weight=0, max-size photo, duplicate external id).
- **Browser matrix** — Chrome (primary), Edge, Firefox, Safari (macOS or BrowserStack). Mobile Safari + Chrome Android on physical phones for PWA install path and Web Push.
- **Mobile matrix** — iOS 17 Expo Go, Android 13/14 Expo Go, one EAS preview build per platform before sign-off.
- **Simulator** — `tools/pilot/seed_orders_webhook.py` for inbound orders; `POST /admin/simulator/spawn` (allow-listed username only) to spawn synthetic moving drivers on the map.

## 3. Phases & schedule

| Phase | Days | Output |
|---|---|---|
| **0 — Setup & smoke** | 0.5 | Dev stack URLs captured; smoke endpoints green; all roles sign in on web + mobile via SRP and dev quick |
| **1 — Functional (happy path) by role** | 4 | Per-role checklist passes on web + mobile (§4.1–4.6) |
| **2 — Email ingest + Gmail OAuth** | 1 | §4.7 fully exercised end-to-end including reauth |
| **3 — Realtime + push** | 1 | §4.8 WebSocket events and Web Push subscriptions verified |
| **4 — Cross-cutting** | 2 | Auth/session, RBAC, offline, PWA install, error paths (§5) |
| **5 — Regression & known bugs** | 1 | Confirmed retest of items in §6; visual regression sweep |
| **6 — Browser/device matrix** | 1 | Cross-browser + cross-device pass on critical flows only |
| **7 — Bug fix + retest loops** | rolling | Each PR re-runs the affected checklist row before merge |
| **8 — Stabilization & sign-off** | 1 | Exit criteria met (§9); QA report written |

## 4. Functional checklists

Each row = one test case. Tester records **Pass / Fail / Blocked + screenshot or repro steps** in a defect issue using `.github/ISSUE_TEMPLATE/pilot-bug-report.yml`.

### 4.1 Admin — Web PWA (`admin.html`)

| # | Scenario | Verify |
|---|---|---|
| A1 | Login screen renders | Full-screen `#login-screen` with Sign In + Create Account; no console errors |
| A2 | Sign in via Hosted UI | Lands on Dispatch tab; `#auth-state` pill shows authenticated; topbar shows `Logout` |
| A3 | Sign in via dev quick session | Same as A2 but no Cognito round-trip; `discra_dev_session` cookie set |
| A4 | Dispatch tab — 3-column layout | Left: active orders list w/ search + filter chips (All / Dispatched / En Route / Unassigned); center: MapLibre map + overlay stat chips; right: driver list |
| A5 | Stat chips | Active drivers, Orders, Assigned, Unassigned, Due Soon all reflect server state and update on refresh |
| A6 | Driver map | MapLibre tiles load; active drivers plotted; clicking driver focuses + opens route context |
| A7 | Order search + filter chips | Free-text search filters list immediately; chip switches respect current search |
| A8 | Orders tab | Tabular view; sort field+direction work; filters persist across refresh |
| A9 | Create order | All required fields enforced (reference_number, pick_up_address, delivery, dimensions, weight); time-window optional fields accepted |
| A10 | Single assign | Pick driver → click order → assigned; button shows **driver name** not UUID (regression of PRs #141/#142) |
| A11 | Bulk assign | Select 3 orders + driver → Assign Selected; all 3 update; selection clears |
| A12 | Bulk unassign | Same path, unassign |
| A13 | Status transitions | Admin can override any status; terminal statuses (Delivered/Failed) lock further changes appropriately |
| A14 | Route optimize | With ≥2 assigned orders for driver, Optimize produces ordered stops + distance/duration; "Open in Maps" works |
| A15 | Dispatch summary KPI | Counts match Orders tab counts |
| A16 | Audit log viewer | Filters (action, actor, date, limit≤200) work; details preview expands; email rule + Gmail connect/disconnect events appear (verify after §4.7) |
| A17 | Audio alerts toggle | `#audio-alerts-toggle` (bottom-right) enables/disables; new-order arrival makes a sound |
| A18 | Admin tab — Session & Auth | Quick test sign-in panel (when dev auth on); Hosted UI section; Debug Token Override hidden by default |
| A19 | Admin tab — Billing & Seats | Seat counts + provider readiness pills render |
| A20 | Billing seats update | Increase/decrease seats persists |
| A21 | Stripe checkout | Click → redirects to Stripe checkout; cancel returns to console without breaking state |
| A22 | Stripe portal | Opens billing portal for linked customer |
| A23 | Invitations create + activate + cancel | Full lifecycle; audit log entries appear |
| A24 | Sign out (topbar Logout) | Cookies cleared; lands on login screen; refresh **does not** restore session (known-bug retest — §6) |
| A25 | PWA install | "Install app" prompt offered; installed app loads from service worker; cache-bust version on `admin.js?v=...` updates after deploy |

### 4.2 Dispatcher — Web PWA

Same as Admin except **A19–A23 (billing)** and email integration (§4.7) **must be denied** with a clean RBAC error, not a 500. Verify in DevTools network tab that the request returned 403.

### 4.3 Driver — Web PWA (`driver.html`)

| # | Scenario | Verify |
|---|---|---|
| D1 | Sign in (Hosted UI + dev quick) | Lands on assigned inbox; non-driver claims rejected with clear message |
| D2 | Inbox loads | Only orders assigned to this driver visible; order details readable; mobile-responsive (`driver-mobile.css`) on phone widths |
| D3 | Status transitions | `Assigned → PickedUp → EnRoute → Delivered`; Failed allowed from non-terminal states |
| D4 | POD photo capture | File picker accepts jpg/png/webp ≤10 MB; rejects >10 MB and other types with clear error |
| D5 | POD signature | Canvas captures; clear button works; data URL sent on submit |
| D6 | POD submit | `/pod/presign` → S3 POST → `/pod/metadata` → status→Delivered; failure mid-flow leaves order recoverable, not half-delivered |
| D7 | Location share | Geolocation prompt; coordinates POST to `/drivers/location`; Admin map sees the point within refresh window |
| D8 | Web Push subscribe | When prompted, accept push perm; `/push/vapid-public-key` + `/push/subscribe` succeed; assignment to this driver triggers a push notification (foreground + background) |
| D9 | Sign out | Same as A24 |

### 4.4 Public + Onboarding — Web

| # | Scenario | Verify |
|---|---|---|
| P1 | Landing/index page | Branding + sign-in/register CTAs present |
| P2 | Register a new tenant | All required fields enforced; submission produces a registration id; status = Pending |
| P3 | Review page (Admin only) | Pending list loads; approve/reject persists; rejected reason captured |
| P4 | Approved tenant flow | Approved user can hosted-UI login and reach admin console with correct org_id claim |
| P5 | Custom in-app login (`login.html`) | SRP flow works for username/password; failed credentials show error without leaking detail |
| P6 | Simulator page (`simulator.html`) | Allow-listed user can spawn drivers; non-allow-listed user gets 403; spawned drivers appear on Admin map |

### 4.5 Mobile — Admin/Dispatcher (`AdminScreen.tsx`)

| # | Scenario | Verify |
|---|---|---|
| MA1 | First-launch — SRP login | Username/password against Cognito works without leaving the app; failed creds show error |
| MA2 | API base auto-default | On localhost web preview points to `127.0.0.1:8000/dev/backend`; on device points to deployed dev API |
| MA3 | Workspace switch | Admin / Driver toggle persisted across launches |
| MA4 | Three top tabs | `dispatch` / `orders` / `admin` render correctly |
| MA5 | Dispatch tab | Map with markers; bottom sheet with active orders; pull-to-refresh works; auto-refresh every 15s |
| MA6 | Orders tab + sub-tabs | `list` / `inflight` / `history` counts match server |
| MA7 | Single + bulk assign | Driver name (not UUID) shown on assign button |
| MA8 | Map view | Pins render; tapping driver opens route context; "Open in Maps" launches Google Maps intent |
| MA9 | Optimize route | Stops list + travel summary populate |
| MA10 | Profile photo | Picker → presign → S3 → URL persisted in `/users/me` |
| MA11 | Audit logs visible | Mobile shows audit feed for org |
| MA12 | Billing summary (mobile) | Seat counts render for Admin role |
| MA13 | Sign out | Token + cookies cleared; relaunch shows SRP login |
| MA14 | Web build of mobile | `expo start --web` runs in browser; `react-native-web` shims (`react-native-maps.web.js`) render without crashing |

### 4.6 Mobile — Driver (`DriverScreen.tsx`)

| # | Scenario | Verify |
|---|---|---|
| MD1 | Inbox refresh | Only own orders |
| MD2 | Status update | Transitions work; offline → queue increments; online + Sync Queue drains |
| MD3 | Location share | Permission requested once; auto-share toggle starts/stops 60s interval |
| MD4 | Offline location | Send location offline → queued; reconnect + Sync drains |
| MD5 | POD photo (camera) | Capture, preview, retake works; iOS + Android both ok |
| MD6 | POD signature pad | Touch responsive; clear works; signature submits to S3 |
| MD7 | POD complete | Order transitions to Delivered after upload; metadata visible in Admin queue |
| MD8 | Push notifications on device | Assignment to this driver triggers push; tapping push opens app to the order |
| MD9 | Deep-link login + logout | `discra-mobile://auth/callback` returns token; logout deep link clears storage |

### 4.7 Email ingest + Gmail OAuth (Admin only)

| # | Scenario | Verify |
|---|---|---|
| E1 | Connect Gmail | `Connect Gmail` button opens Google OAuth popup; consent → `/email/connect` exchanges code; `email-connected-address` shows account |
| E2 | Status display | `Last Poll`, `Status` populate; refresh updates them |
| E3 | Disconnect | `Disconnect` clears stored refresh token; UI returns to `email-not-connected` state; audit event recorded |
| E4 | Reauth banner | Force `invalid_grant` (revoke from Google account permissions) → poller broadcasts `gmail_reauth` over WebSocket → admin sees red banner at top → `Reconnect Gmail` re-runs OAuth → banner disappears; previous `email_rules` are preserved |
| E5 | Classification rules — list | `Refresh` loads existing rules from `/email/rules` |
| E6 | Classification rules — create | `+ Add Rule` modal; name, sender, optional subject, parser dropdown, enabled toggle; save persists; appears in list |
| E7 | Classification rules — edit + disable | Edit existing rule; toggle disabled; saves; disabled rule is skipped during poll |
| E8 | Classification rules — order | Confirm custom rules check before built-in defaults (regression of commit `cb35463`) |
| E9 | Format detection — text | Paste email body → `Detect Format` → suggests parser |
| E10 | Format detection — file | Upload `.eml`/image → `Detect Format` → suggests parser |
| E11 | Skipped emails | `Refresh` loads skipped emails (non-order matches); reason visible; "fall-through and elevate" cases from `fix/email-classifier-fallthrough-and-elevate` arrive here |
| E12 | End-to-end ingest | Send a dispatch email from a known sender matching a rule → poller picks it up → order created → appears in Admin queue with parsed fields |
| E13 | 7-day token expiry guard | Document current OAuth consent screen status (Testing vs In production) in the QA report; if Testing, file a P1 issue tracking the publish step |

### 4.8 Realtime (WebSocket) + Web Push

| # | Scenario | Verify |
|---|---|---|
| W1 | WS connection on login | Admin/Driver web client opens WS to `wss://phdvk8f710.execute-api.us-east-1.amazonaws.com/dev` with JWT; `ws_handler_fn` accepts |
| W2 | Order assignment broadcast | Admin assigns order → Driver web/mobile receives event → driver inbox updates without manual refresh |
| W3 | Driver location broadcast | Driver sends location → Admin map updates marker without manual refresh |
| W4 | Gmail reauth broadcast | Triggers banner (covered by E4) across all open admin tabs |
| W5 | Reconnect after drop | Force network drop; WS reconnects with backoff; events received after reconnect |
| W6 | VAPID key fetch | `/push/vapid-public-key` returns key; if SSM not warmed, fetch retries succeed (regression of `fix/vapid-ssm-runtime-fetch`) |
| W7 | Push subscribe — driver web | Browser prompts; subscription stored; expires in TTL window |
| W8 | Push subscribe — mobile | Native push token registered; subscription stored |
| W9 | Push deliver | Backend dispatches push to driver on assignment; received foreground + background |

## 5. Cross-cutting tests (Phase 4)

- **RBAC negative tests** — for each protected endpoint (`README.md` § Protected endpoints + `/email/*`, `/push/*`, `/admin/simulator/*`), drive the UI with wrong role and confirm 403, not 500. UI must handle 403 gracefully (no infinite spinner, no whitespace screen).
- **Session edge cases** — expired JWT mid-session, network drop during assign, token rotation, two tabs same user, two tabs different roles, SRP login then Hosted UI login on same browser.
- **PWA service workers** — verify `admin.js` and `driver.js` bust cache after backend redeploy. Hard-refresh, soft-refresh, offline reload paths. Confirm new `admin-sw.js`/`driver-sw.js` versions evict old assets.
- **Error display** — every form error returns a user-visible message; every backend 4xx/5xx becomes a `.message` element, never a silent console error.
- **Long-running tabs** — leave Dispatch open 2 hours; auto-refresh + WS continue; map doesn't leak memory; no duplicate driver markers; audio alerts don't pile up.
- **Webhook ingest at scale** — push 75 orders via `seed_orders_webhook.py`; admin queue handles the volume; bulk select 50 works.
- **POD constraints** — max file size enforcement (10 MB photo, 2 MB signature) on web AND mobile.
- **Concurrent assignment** — two dispatchers assign the same order simultaneously; second one gets a clean conflict error, not silent overwrite.
- **Simulator interactions** — spawn 20 sim drivers; assign real orders to them; confirm map performance and that real driver data isn't corrupted by sim data.

## 6. Known-bug retest list

Pull these to the top of regression and confirm before sign-off:

1. **Logout/session race** — Sign in → Sign out → hard refresh must stay signed out (single click). Sign in → Sign out → click Sign In must enter on first click. Repeat on dev session AND web session AND mixed (dev then hosted). Verify against current `backend/auth.py:_resolve_claims` and `admin.js:launchHostedLogout`. (Memory note: 46 days old, two prior attempted fixes did not fully resolve.)
2. **Driver name vs UUID on assign button** (PRs #141, #142) — covered by A10 / MA7.
3. **Admin.js cache-bust version** (PR #143) — confirm latest version string ships and old SW evicts on redeploy.
4. **Custom classification rules ignored** (commit `cb35463`) — covered by E8.
5. **Email classifier fallthrough + elevate** (branch `fix/email-classifier-fallthrough-and-elevate`) — confirm skipped emails surface with elevated context (E11).
6. **VAPID SSM runtime fetch** (branch `fix/vapid-ssm-runtime-fetch`) — covered by W6.
7. **Email-poller list-connected-orgs permission** (branch `fix/email-poller-list-connected-orgs`) — verify poller iterates all connected orgs without IAM error.
8. **Beautifulsoup4 backend requirement** (branch `fix/backend-beautifulsoup4-requirement`) — verify `requirements.txt` includes it and email_parser HTML extraction works in deployed Lambda.

## 7. Defect tracking

- **Issue template:** `.github/ISSUE_TEMPLATE/pilot-bug-report.yml`
- **Required fields:** role, surface (web admin / web driver / mobile admin / mobile driver / email / push / ws), browser/device, steps, expected, actual, severity, screenshot/HAR.
- **Severity rubric:**
  - **P0** — data loss, security, auth bypass, broken auth for any role, Gmail token leak.
  - **P1** — a role cannot complete its core flow (assign, deliver, login); email ingest stops; push not delivered.
  - **P2** — workaround exists; non-core feature broken; cross-browser only.
  - **P3** — cosmetic, copy, alignment.
- **SLA inside QA cycle:** P0 same-day, P1 next-day, P2 within phase, P3 batched at end.

## 8. Bug-fix workflow

For every defect filed:
1. Create branch `fix/<area>-<short-slug>` off latest `main`.
2. Add or update the test that would have caught it (pytest for backend, manual checklist row for UI — note in PR which row).
3. Implement the fix; keep PR ≤ ~300 LOC where possible.
4. PR title: `fix(<area>): <imperative summary>` matching the project's recent commit style.
5. Open PR, link the defect issue, request review.
6. Tester reruns the affected checklist row on the merged commit before closing the defect.
7. Trivial cosmetic clusters (copy fixes, padding) may be bundled into a single PR.

## 9. Exit criteria

- All P0 + P1 defects closed.
- P2 defects either closed or explicitly deferred with a written justification.
- Every row in §4.1–4.8 passes on the dev stack against latest `main`.
- §6 known-bug retests all green.
- Smoke endpoints (`/backend/health`, `/backend/version`, UI routes) return 200 against dev.
- Mobile `npm run typecheck` and backend pytest both green in CI.
- Gmail OAuth consent screen is **In production** (or explicit pilot-only acknowledgment of the 7-day refresh-token expiry).
- A short QA sign-off report (1 page) summarizing: tested versions, browsers/devices used, defect counts by severity, residual risk.

## 10. Deliverables

- This plan (this document).
- Filled-in defect issues using the existing template.
- Per-defect PRs.
- A `docs/qa-signoff-report.md` at the end with the residual risk register.

---

**Out of QA scope but flagged:** production cold-start (~10–30s) needs provisioned concurrency on `BackendApiFunction` — infra change, not a code defect, but should land before any prod traffic.
