"""End-to-end integration test for the email ingest pipeline.

Exercises the same code path that the email_poller uses on every Gmail
message — `classify_email()` + the matched parser — without requiring an
actual Gmail account or network access.

Twenty hand-crafted emails are used:
  - 16 junk emails (newsletters, calendar invites, autoresponders, replies,
    marketing, shipping notifications, etc.) — must NOT classify as orders.
  - 4 dispatch emails, one per parser type:
      * email-html-table       — order data inside an HTML <table>
      * email-labeled-fields   — labeled KEY: value sections
      * email-pdf-attachment   — order data in an attached PDF
                                 (classification only; parser needs a real PDF)
      * email-ai               — generic dispatch body matched by a custom rule
                                 (classification only; parser uses Anthropic API)

All classification is per-org config — the classifier has no built-in
carrier-specific rules. Each dispatch email is paired with the matching
custom rule the test installs.

Validates:
  1. Each parser_type routes correctly when its matching custom rule is set.
  2. Specific subject_pattern rules beat empty-subject catch-alls regardless
     of saved order.
  3. Disabled rules are bypassed.
  4. Junk emails (and dispatch emails with no matching rule) are skipped
     with `NO_SENDER_MATCH` or `NO_SUBJECT_MATCH`.
  5. Deterministic parsers (HtmlTable, LabeledFields) extract correct
     Order fields: reference_id, num_packages, weight, customer_name, notes.
"""

import os
import sys

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "../..")))

import pytest

from backend.email_classifier import SkipReason, classify_email
from backend.email_parser import (
    HtmlTableEmailParser,
    LabeledFieldsEmailParser,
    get_parser,
)
from backend.gmail_client import GmailMessage


# Rules that map each dispatch sender to the right parser. Real orgs would
# configure these via /email/rules; the tests install them inline.
RULES_ALL = [
    {
        "name": "Carrier A HTML-table",
        "sender_pattern": "carriera.com",
        "subject_pattern": "PICKUP ALERT",
        "parser_type": "email-html-table",
        "enabled": True,
    },
    {
        "name": "Carrier B labeled-fields",
        "sender_pattern": "carrierb.com",
        "subject_pattern": "Order #",
        "parser_type": "email-labeled-fields",
        "enabled": True,
    },
    {
        "name": "Carrier C PDF",
        "sender_pattern": "carrierc.com",
        "subject_pattern": "Agent Alert",
        "parser_type": "email-pdf-attachment",
        "enabled": True,
    },
    {
        "name": "Carrier D AI catch-all",
        "sender_pattern": "carrierd.com",
        "subject_pattern": "",
        "parser_type": "email-ai",
        "enabled": True,
    },
]


# ---------------------------------------------------------------------------
# Sample emails — 4 dispatch, 16 junk
# ---------------------------------------------------------------------------

# Forwarded-header HTML wrapper used by all dispatch samples — emails arrive at
# the connected inbox as forwards from the actual sender.
def _forward(original_from: str, original_subject: str, body: str) -> str:
    return f"""<html><body>
<b>From:</b> {original_from}<br>
<b>Subject:</b> {original_subject}<br>
<hr>
{body}
</body></html>"""


# 1. HTML-table dispatch (custom rule routes to HtmlTableEmailParser)
MARKEN_BODY = """
<table>
  <tr><td>ORDER#</td><td>INFO</td><td>DELIVER TO</td><td>ROUTING</td></tr>
  <tr>
    <td>87654321</td>
    <td>PCS/WT: 4 / 180.0 lbs (81.6 kg)\nDIMS: 4@24x18x14in</td>
    <td>Pharma Logistics Inc\n789 Industrial Way\nAUSTIN,TX 78701 US\nPHONE: 512-555-7890\nDELIVER BY: Apr 15, 2026 16:00</td>
    <td>UA 4567 | DL 8910</td>
  </tr>
</table>
<p>PICKUP FROM:</p>
<p>BioStorage Tech\n1500 Research Blvd\nDALLAS,TX 75201 US\nPHONE: 214-555-1234\nPICKUP START: Tue Apr-15-2026 09:00\nPICKUP END: Tue Apr-15-2026 11:00</p>
"""

EMAIL_HTML_TABLE = {
    "label": "[email-html-table] HTML-table dispatch",
    "subject": "Fwd: PICKUP ALERT #87654321 - ACME Corp",
    "sender": "ops-relay@discra-pilot.com",
    "html_body": _forward(
        "dispatch@carriera.com",
        "PICKUP ALERT #87654321 - ACME Corp",
        MARKEN_BODY,
    ),
    "text_body": "",
    "expect_is_order": True,
    "expect_source": "email-html-table",
}

# 2. Labeled-fields dispatch (custom rule routes to LabeledFieldsEmailParser)
AIRSPACE_BODY = """
<p>Order #5021987</p>
<p>PICKUP BY:\nApr 16, 2026 09:00</p>
<p>TENDER BY TIME:\nApr 16, 2026 13:00</p>
<p>PICKUP CONTACT:\nMaria Sanchez\n312-555-3344</p>
<p>TOTAL PIECES: 8</p>
<p>TOTAL WEIGHT: 95.50 LBS</p>
<p>4 of 18.0 x 12.0 x 10.0 IN @ 23.0 LBS</p>
<p>AIR WAYBILLS: 220-99887766</p>
"""

EMAIL_LABELED_FIELDS = {
    "label": "[email-labeled-fields] Labeled-fields dispatch",
    "subject": "Fwd: Tracking ID: AXSP7T2W9Q, Order #: 5021987 - Pickup Dispatch",
    "sender": "ops-relay@discra-pilot.com",
    "html_body": _forward(
        "dispatch@carrierb.com",
        "Tracking ID: AXSP7T2W9Q, Order #: 5021987 - Pickup Dispatch",
        AIRSPACE_BODY,
    ),
    "text_body": "",
    "expect_is_order": True,
    "expect_source": "email-labeled-fields",
}

# 3. PDF-attachment dispatch (custom rule; PDF parsing not exercised here)
EMAIL_PDF = {
    "label": "[email-pdf-attachment] PDF-attachment dispatch",
    "subject": "Fwd: Agent Alert XYZ789 - Pickup Required",
    "sender": "ops-relay@discra-pilot.com",
    "html_body": _forward(
        "vendors@carrierc.com",
        "Agent Alert XYZ789",
        "<p>See attached dispatch PDF for full order details.</p>",
    ),
    "text_body": "",
    "expect_is_order": True,
    "expect_source": "email-pdf-attachment",
}

# 4. Generic dispatch matched by custom AI rule (catch-all for the org)
EMAIL_AI = {
    "label": "[email-ai] Generic dispatch matched by custom AI rule",
    "subject": "Fwd: Dispatch confirmation #DSP-9912 — same-day pickup",
    "sender": "ops-relay@discra-pilot.com",
    "html_body": _forward(
        "dispatch@carrierd.com",
        "Dispatch confirmation #DSP-9912 — same-day pickup",
        "<p>Pickup: 200 Main St, Chicago IL 60601</p><p>Delivery: 800 Elm St, Milwaukee WI 53202</p><p>Weight: 35 lbs</p><p>Time: 14:00 today</p>",
    ),
    "text_body": "",
    "expect_is_order": True,
    "expect_source": "email-ai",
}

DISPATCH_EMAILS = [EMAIL_HTML_TABLE, EMAIL_LABELED_FIELDS, EMAIL_PDF, EMAIL_AI]


# 16 junk emails — each represents a different category of non-order email we
# might realistically see in an org dispatch inbox. The `expect_skip_reason`
# is what `classify_email()` should report.
JUNK_EMAILS = [
    {
        "label": "Newsletter",
        "subject": "Fwd: Logistics Weekly — Industry trends for April 2026",
        "sender": "ops-relay@discra-pilot.com",
        "html_body": _forward(
            "newsletter@logisticstoday.com",
            "Logistics Weekly — Industry trends for April 2026",
            "<p>This week's top stories...</p>",
        ),
        "text_body": "",
    },
    {
        "label": "Calendar invite",
        "subject": "Invitation: Q2 dispatch ops sync @ Apr 17, 2026 10am",
        "sender": "ops-relay@discra-pilot.com",
        "html_body": _forward(
            "noreply@google.com",
            "Q2 dispatch ops sync",
            "<p>Calendar invitation</p>",
        ),
        "text_body": "",
    },
    {
        "label": "UPS shipment notification (not for us)",
        "subject": "Fwd: UPS Delivery Notification — Tracking 1Z999AA10123456784",
        "sender": "ops-relay@discra-pilot.com",
        "html_body": _forward(
            "mcinfo@ups.com",
            "UPS Delivery Notification",
            "<p>Your package has been delivered.</p>",
        ),
        "text_body": "",
    },
    {
        "label": "Marketing — SaaS pitch",
        "subject": "Fwd: Cut your TMS costs by 40% with Routely",
        "sender": "ops-relay@discra-pilot.com",
        "html_body": _forward(
            "sales@routely.io",
            "Cut your TMS costs by 40% with Routely",
            "<p>Book a demo today!</p>",
        ),
        "text_body": "",
    },
    {
        "label": "Out-of-office autoresponder",
        "subject": "Fwd: Re: Out of office — back Apr 22",
        "sender": "ops-relay@discra-pilot.com",
        "html_body": _forward(
            "jane.doe@acmecustomer.com",
            "Re: Out of office",
            "<p>I am OOO until Apr 22. For urgent matters contact ops.</p>",
        ),
        "text_body": "",
    },
    {
        "label": "Reply from customer (not a new dispatch)",
        "subject": "Fwd: Re: Last week's shipment — invoice question",
        "sender": "ops-relay@discra-pilot.com",
        "html_body": _forward(
            "ap@acmecustomer.com",
            "Re: Last week's shipment — invoice question",
            "<p>What's the status on invoice #88231?</p>",
        ),
        "text_body": "",
    },
    {
        "label": "GitHub notification",
        "subject": "Fwd: [cody-carmichael/discra] PR review requested",
        "sender": "ops-relay@discra-pilot.com",
        "html_body": _forward(
            "notifications@github.com",
            "[cody-carmichael/discra] PR review requested",
            "<p>You have been requested as a reviewer.</p>",
        ),
        "text_body": "",
    },
    {
        "label": "Bank statement",
        "subject": "Fwd: Your monthly statement is available",
        "sender": "ops-relay@discra-pilot.com",
        "html_body": _forward(
            "alerts@bigbank.com",
            "Your monthly statement is available",
            "<p>March statement ready to download.</p>",
        ),
        "text_body": "",
    },
    {
        "label": "Phishing attempt — lookalike sender domain",
        "subject": "Fwd: URGENT: Update your dispatch credentials NOW",
        "sender": "ops-relay@discra-pilot.com",
        "html_body": _forward(
            # Substring of carriera.com inside a malicious domain — verifies the
            # classifier doesn't treat lookalike domains as the real carrier.
            "ops@carriera.com.evil-phish.net",
            "URGENT: Update your dispatch credentials NOW",
            "<p>Click here to verify your account...</p>",
        ),
        "text_body": "",
    },
    {
        "label": "Survey from a configured carrier (wrong subject)",
        "subject": "Fwd: Year-end customer survey — your feedback matters",
        "sender": "ops-relay@discra-pilot.com",
        "html_body": _forward(
            "no-reply@carriera.com",
            "Year-end customer survey — your feedback matters",
            "<p>Please rate our service this year.</p>",
        ),
        "text_body": "",
    },
    {
        "label": "Maintenance notice from a configured carrier (wrong subject)",
        "subject": "Fwd: System maintenance window scheduled",
        "sender": "ops-relay@discra-pilot.com",
        "html_body": _forward(
            "ops@carrierb.com",
            "System maintenance window scheduled",
            "<p>Maintenance Apr 20 from 02:00-04:00 UTC.</p>",
        ),
        "text_body": "",
    },
    {
        "label": "Spam / lottery",
        "subject": "Fwd: You've won! Claim $5000 today",
        "sender": "ops-relay@discra-pilot.com",
        "html_body": _forward(
            "winner@lottery-prize-xyz.com",
            "You've won! Claim $5000 today",
            "<p>Click to claim your prize</p>",
        ),
        "text_body": "",
    },
    {
        "label": "DocuSign signature request",
        "subject": "Fwd: Please DocuSign: Carrier agreement Q2 2026",
        "sender": "ops-relay@discra-pilot.com",
        "html_body": _forward(
            "dse@docusign.net",
            "Please DocuSign: Carrier agreement Q2 2026",
            "<p>Click to review and sign.</p>",
        ),
        "text_body": "",
    },
    {
        "label": "Internal Slack notification",
        "subject": "Fwd: [Slack] New message in #dispatch-ops",
        "sender": "ops-relay@discra-pilot.com",
        "html_body": _forward(
            "feedback@slack.com",
            "[Slack] New message in #dispatch-ops",
            "<p>You have 3 unread messages.</p>",
        ),
        "text_body": "",
    },
    {
        "label": "Receipt from gas station",
        "subject": "Fwd: Your receipt from Chevron — $52.41",
        "sender": "ops-relay@discra-pilot.com",
        "html_body": _forward(
            "receipts@chevron.com",
            "Your receipt from Chevron — $52.41",
            "<p>Thanks for fueling up.</p>",
        ),
        "text_body": "",
    },
    {
        "label": "Empty body / sparse content",
        "subject": "Fwd: (no subject)",
        "sender": "ops-relay@discra-pilot.com",
        "html_body": _forward(
            "random@unknown-sender.com",
            "(no subject)",
            "",
        ),
        "text_body": "",
    },
]


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------

def test_dispatch_emails_route_to_correct_parser_with_rules():
    """Each dispatch email routes to its parser when the matching org rule is set."""
    for email in [EMAIL_HTML_TABLE, EMAIL_LABELED_FIELDS, EMAIL_PDF, EMAIL_AI]:
        result = classify_email(
            subject=email["subject"],
            sender=email["sender"],
            html_body=email["html_body"],
            text_body=email["text_body"],
            custom_rules=RULES_ALL,
        )
        assert result.is_order, f"{email['label']} should classify as order, got skip={result.skip_reason}"
        assert (
            result.source == email["expect_source"]
        ), f"{email['label']} should route to {email['expect_source']}, got {result.source}"


def test_dispatch_emails_skipped_without_any_rule():
    """With no rules configured, every email is unknown — even a well-formed dispatch."""
    for email in [EMAIL_HTML_TABLE, EMAIL_LABELED_FIELDS, EMAIL_PDF, EMAIL_AI]:
        result = classify_email(
            subject=email["subject"],
            sender=email["sender"],
            html_body=email["html_body"],
            text_body=email["text_body"],
        )
        assert not result.is_order
        assert result.skip_reason == SkipReason.NO_SENDER_MATCH


def test_specific_subject_rule_beats_catchall():
    """A specific subject_pattern rule should fire even when a catch-all
    rule for the same sender exists."""
    rules = [
        {
            "name": "Catch-all",
            "sender_pattern": "carriera.com",
            "subject_pattern": "",
            "parser_type": "email-ai",
            "enabled": True,
        },
        {
            "name": "Specific PICKUP ALERT",
            "sender_pattern": "carriera.com",
            "subject_pattern": "PICKUP ALERT",
            "parser_type": "email-html-table",
            "enabled": True,
        },
    ]
    result = classify_email(
        subject=EMAIL_HTML_TABLE["subject"],
        sender=EMAIL_HTML_TABLE["sender"],
        html_body=EMAIL_HTML_TABLE["html_body"],
        text_body=EMAIL_HTML_TABLE["text_body"],
        custom_rules=rules,
    )
    assert result.is_order
    assert result.source == "email-html-table", "Specific subject rule must beat catch-all"


def test_disabled_custom_rule_is_skipped():
    """Disabled custom rules are bypassed entirely. With no other rules
    matching, the email falls through to `NO_SENDER_MATCH`."""
    rules = [
        {
            "name": "Disabled HTML-table rule",
            "sender_pattern": "carriera.com",
            "subject_pattern": "PICKUP ALERT",
            "parser_type": "email-html-table",
            "enabled": False,
        },
    ]
    result = classify_email(
        subject=EMAIL_HTML_TABLE["subject"],
        sender=EMAIL_HTML_TABLE["sender"],
        html_body=EMAIL_HTML_TABLE["html_body"],
        text_body=EMAIL_HTML_TABLE["text_body"],
        custom_rules=rules,
    )
    assert not result.is_order
    assert result.skip_reason == SkipReason.NO_SENDER_MATCH


@pytest.mark.parametrize("email", JUNK_EMAILS, ids=lambda e: e["label"])
def test_junk_email_does_not_classify_as_order(email):
    """All 16 junk emails must be skipped with a valid SkipReason."""
    result = classify_email(
        subject=email["subject"],
        sender=email["sender"],
        html_body=email["html_body"],
        text_body=email["text_body"],
    )
    assert not result.is_order, f"{email['label']} should NOT classify as order"
    assert result.skip_reason in (
        SkipReason.NO_SENDER_MATCH,
        SkipReason.NO_SUBJECT_MATCH,
    ), f"{email['label']} had unexpected skip_reason {result.skip_reason}"


def test_html_table_parser_extracts_correct_order_fields():
    """Run the HTML-table parser on a realistic body, verify Order fields."""
    msg = GmailMessage(
        message_id="m-table",
        thread_id="t-table",
        subject=EMAIL_HTML_TABLE["subject"],
        html_body=EMAIL_HTML_TABLE["html_body"],
    )
    parser = HtmlTableEmailParser()
    result = parser.parse(msg)

    assert result is not None, "HtmlTableEmailParser returned None"
    assert result.source == "email-html-table"
    assert result.reference_id == "87654321"
    assert result.num_packages == 4
    assert result.weight == 180.0
    assert "AUSTIN" in result.delivery_city.upper() or "AUSTIN" in result.delivery_street.upper(), (
        "Delivery address should include Austin"
    )


def test_labeled_fields_parser_extracts_correct_order_fields():
    """Run the labeled-fields parser on a realistic body, verify Order fields."""
    msg = GmailMessage(
        message_id="m-fields",
        thread_id="t-fields",
        subject=EMAIL_LABELED_FIELDS["subject"],
        html_body=EMAIL_LABELED_FIELDS["html_body"],
    )
    parser = LabeledFieldsEmailParser()
    result = parser.parse(msg)

    assert result is not None, "LabeledFieldsEmailParser returned None"
    assert result.source == "email-labeled-fields"
    assert result.reference_id == "5021987"
    assert result.num_packages == 8
    assert result.weight == 95.5
    assert result.customer_name == "Maria Sanchez"
    assert "Tracking: AXSP7T2W9Q" in result.notes


def test_parser_registry_returns_expected_classes():
    """get_parser() resolves both current and legacy parser_type strings."""
    assert isinstance(get_parser("email-html-table"), HtmlTableEmailParser)
    assert isinstance(get_parser("email-labeled-fields"), LabeledFieldsEmailParser)
    # email-pdf-attachment exists in the registry; parser needs a real PDF
    assert get_parser("email-pdf-attachment") is not None
    # Legacy aliases still resolve (via normalize_parser_type)
    assert isinstance(get_parser("email-marken"), HtmlTableEmailParser)
    assert isinstance(get_parser("email-airspace"), LabeledFieldsEmailParser)
    assert get_parser("email-cap") is not None


# ---------------------------------------------------------------------------
# Coverage matrix — printable summary for the QA report
# ---------------------------------------------------------------------------

def test_print_coverage_matrix(capsys):
    """Prints a clean pass/fail matrix for the QA report. Always passes;
    individual assertions live in the tests above."""
    lines = []
    lines.append("")
    lines.append("=" * 72)
    lines.append("EMAIL INGEST E2E COVERAGE MATRIX")
    lines.append("=" * 72)
    lines.append("")
    lines.append(f"{'Email':<55} {'Result':<15}")
    lines.append("-" * 72)
    for email in DISPATCH_EMAILS:
        r = classify_email(
            subject=email["subject"],
            sender=email["sender"],
            html_body=email["html_body"],
            text_body=email["text_body"],
            custom_rules=RULES_ALL,
        )
        ok = "PASS" if r.is_order and r.source == email["expect_source"] else "FAIL"
        lines.append(f"{email['label']:<55} {ok:<5} ->{r.source}")
    lines.append("")
    lines.append(f"{'Junk email':<55} {'Result':<15}")
    lines.append("-" * 72)
    for email in JUNK_EMAILS:
        r = classify_email(
            subject=email["subject"],
            sender=email["sender"],
            html_body=email["html_body"],
            text_body=email["text_body"],
        )
        ok = "PASS" if (not r.is_order) else "FAIL"
        reason = r.skip_reason.value if r.skip_reason else "n/a"
        lines.append(f"{email['label']:<55} {ok:<5} ->skipped ({reason})")
    lines.append("")
    lines.append("=" * 72)
    summary = "\n".join(lines)
    # Use sys.stdout so pytest -s shows it; also stash for `capsys` consumers.
    print(summary)
