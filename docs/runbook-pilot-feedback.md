# Pilot Feedback & Triage

> Step 6.3. How feedback gets in, where it lands, and the cadence for acting on it.
> Companion to [`runbook-pilot-cutover.md`](runbook-pilot-cutover.md) (getting the pilot
> started) and [`pilot-uat-checklist.md`](pilot-uat-checklist.md) (what testers walk).

---

## 1. The two intake paths, and why there are two

| Path | Who uses it | Where it lands |
|---|---|---|
| **In-app feedback** | Pilot testers — drivers, dispatchers, admins | `discra-feedback-*` table, visible in the admin console |
| **GitHub issue templates** | You, and any technically-inclined tester | GitHub Issues, labelled `pilot` |

In-app is the primary path. A driver mid-shift will not open GitHub, find a repo, create
an account, and fill in reproduction steps — they will say nothing at all, and you will
mistake silence for satisfaction. The in-app form asks for one thing (what happened) and
captures the rest automatically.

GitHub remains the triage queue: it has the labels, assignment, and history. In-app
feedback that turns out to be a real defect gets **promoted** to an issue (§4).

---

## 2. In-app feedback

**Submit:** any signed-in role, from the driver PWA topbar ("Feedback") or the admin
console's Pilot Feedback panel.

**Read:** Admin and Dispatcher only. **Drivers cannot list feedback** — a driver reading
every colleague's complaints is a privacy problem, not a feature. This is enforced
server-side and locked by the RBAC matrix, not just hidden in the UI.

**Captured automatically**, so the tester doesn't have to describe their context:
category, surface (`driver-pwa` / `admin-console`), page path, app version, user agent,
submitter id + email + roles, and timestamp.

**Tenant-scoped:** `org_id` comes from the verified JWT, never the request body, so
feedback cannot be filed into another tenant.

**Bounds:** message ≤ 4000 chars, context fields ≤ 400, list ≤ 200 rows.

**Retention:** the table has PITR but **no TTL** — feedback is kept until deleted by hand.
Free-text feedback can contain personal data (a tester describing a customer interaction),
so it is in scope for a DSAR. Purge it when the pilot ends.

---

## 3. Severity

Use the same rubric as the ledger, so pilot findings and internal findings are comparable.

| Label | Meaning | Response |
|---|---|---|
| `P0-blocking` | Testing cannot continue; data loss; auth bypass | Same day. Stop feature work. |
| `P1-high` | Core flow broken, workaround exists | Within the sprint |
| `P2-medium` | Degraded or confusing, flow completes | Batch into the next cycle |
| `P3-low` | Polish, wording, nice-to-have | Backlog |

A tester's own severity is **input, not verdict.** Testers systematically over-rate what
blocks them personally and under-rate silent data problems, which are the ones that
actually matter. Re-rate on triage.

---

## 4. Cadence

**Daily, while the pilot is live (~10 min).** Open the admin console's Pilot Feedback
panel and the `label:pilot` issue list. For each new item: reproduce or discard, assign a
severity label, and either fix, file, or reply. Promote anything that is a real defect
from in-app feedback into a GitHub issue using the bug template — in-app feedback is an
inbox, not a tracker.

**Weekly (~30 min).** Re-rate everything still open, close what is fixed or won't-fix
(saying which, in a sentence — an unexplained close teaches testers not to bother), and
check for patterns. Three testers reporting the same confusion is a design defect, not
three P3s.

**At pilot end.** Fold anything unresolved into `docs/ALPHA.md` §3 with a real severity,
then purge the feedback table (§2 retention).

**The rule that makes this work:** every submission gets a human response within one
working day, even if that response is "seen, it's a P3, not this week." Silence is the
fastest way to stop receiving feedback — and a pilot that stops reporting looks identical
to a pilot with no problems.

---

## 5. GitHub setup

Labels used by triage — all created 2026-07-26, because the templates referenced `pilot`
and `uat` while **neither label existed**, so pilot issues were being filed unlabelled and
any `label:pilot` filter returned nothing:

`pilot` · `uat` · `P0-blocking` · `P1-high` · `P2-medium` · `P3-low`

Templates: `.github/ISSUE_TEMPLATE/pilot-bug-report.yml` (auto-labels `bug`, `pilot`) and
`pilot-uat-result.yml` (auto-labels `pilot`, `uat`).

> The severity dropdown in the bug template is a **form field**, not a label. Apply the
> matching `P*` label on triage or severity stays unfilterable.

Useful filters:

```bash
gh issue list --label pilot --state open
```

---

## 6. Known gaps

- **No notification on new in-app feedback.** It is pull-only — someone must open the
  panel. Wiring it to the ops SNS topic would fix that; deferred as scope.
- **No status field on in-app feedback.** There is no "triaged / resolved" marker, which
  is deliberate: the tracker is GitHub, and duplicating workflow state in two systems
  guarantees they disagree. Promote real defects to issues.
- **No in-app feedback in the Expo mobile app** — web PWA and admin console only. Mobile
  testers should use the driver PWA or report out-of-band.
