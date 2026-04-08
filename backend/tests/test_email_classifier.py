import os, sys
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "../..")))

from backend.email_classifier import (
    EmailSource,
    SkipReason,
    classify_email,
    _extract_forwarded_headers,
)


# --- Forwarded header extraction ---

def test_extract_forwarded_headers_html():
    html = (
        '<div><b>From:</b> Ops &lt;no-reply@marken.com&gt;</b> <br>'
        '<b>Subject:</b> PICKUP ALERT #12345<br>'
    )
    sender, subject = _extract_forwarded_headers(html, "")
    assert sender == "no-reply@marken.com"
    assert subject == "PICKUP ALERT #12345"


def test_extract_forwarded_headers_plain_text():
    text = "From: no-reply@marken.com\nSubject: PICKUP ALERT #99999\n"
    sender, subject = _extract_forwarded_headers("", text)
    assert sender == "no-reply@marken.com"
    assert subject == "PICKUP ALERT #99999"


def test_extract_forwarded_headers_html_entities():
    html = (
        '<b>From:</b> &lt;ops@airspace.com&gt; <br>'
        '<b>Subject:</b> Tracking ID: ABC &amp; Order #: 123<br>'
    )
    sender, subject = _extract_forwarded_headers(html, "")
    assert sender == "ops@airspace.com"
    assert "Tracking ID: ABC & Order #: 123" == subject


def test_extract_no_headers():
    sender, subject = _extract_forwarded_headers("", "")
    assert sender == ""
    assert subject == ""


# --- classify_email: Marken ---

def test_classify_marken_order():
    html = '<b>From:</b> &lt;no-reply@marken.com&gt; <br><b>Subject:</b> PICKUP ALERT #12413656<br>'
    result = classify_email(
        subject="Fwd: PICKUP ALERT #12413656",
        sender="dispatch@vellogistix.com",
        html_body=html,
    )
    assert result.is_order is True
    assert result.source == EmailSource.MARKEN
    assert result.original_sender == "no-reply@marken.com"


def test_classify_marken_non_order_subject():
    html = '<b>From:</b> &lt;no-reply@marken.com&gt; <br><b>Subject:</b> Re: Shipment Confirmation<br>'
    result = classify_email(
        subject="Fwd: Re: Shipment Confirmation",
        sender="dispatch@vellogistix.com",
        html_body=html,
    )
    assert result.is_order is False
    assert result.skip_reason == SkipReason.NO_SUBJECT_MATCH


# --- classify_email: Airspace ---

def test_classify_airspace_order():
    html = (
        '<b>From:</b> &lt;ops@airspace.com&gt; <br>'
        '<b>Subject:</b> Tracking ID: ATDRW32YW7, Order #: 3541972 - Pickup Dispatch<br>'
    )
    result = classify_email(
        subject="Fwd: Tracking ID: ATDRW32YW7, Order #: 3541972 - Pickup Dispatch",
        sender="dispatch@vellogistix.com",
        html_body=html,
    )
    assert result.is_order is True
    assert result.source == EmailSource.AIRSPACE


# --- classify_email: CAP Logistics ---

def test_classify_cap_logistics_order():
    html = '<b>From:</b> &lt;vendors@caplogistics.com&gt; <br><b>Subject:</b> Agent Alert 2603A7308<br>'
    result = classify_email(
        subject="Fwd: Agent Alert 2603A7308",
        sender="dispatch@vellogistix.com",
        html_body=html,
    )
    assert result.is_order is True
    assert result.source == EmailSource.CAP_LOGISTICS


# --- classify_email: Unknown sender ---

def test_classify_unknown_sender():
    result = classify_email(
        subject="Hello there",
        sender="random@gmail.com",
    )
    assert result.is_order is False
    assert result.skip_reason == SkipReason.NO_SENDER_MATCH


# --- Envelope fallback ---

def test_classify_uses_envelope_when_no_forwarded_headers():
    result = classify_email(
        subject="PICKUP ALERT #99999",
        sender="no-reply@marken.com",
        html_body="<p>Simple body with no forwarded headers</p>",
    )
    assert result.is_order is True
    assert result.source == EmailSource.MARKEN
    assert result.original_sender == "no-reply@marken.com"


# --- Fwd: prefix stripping for subject fallback ---

def test_classify_strips_fwd_from_envelope_subject():
    """When forwarded headers aren't found, the classifier should strip Fwd: from envelope subject."""
    result = classify_email(
        subject="Fwd: Agent Alert ABC123",
        sender="vendors@caplogistics.com",
        html_body="",
        text_body="",
    )
    assert result.is_order is True
    assert result.source == EmailSource.CAP_LOGISTICS


# --- Custom rules ---

_VELLOGISTIX_RULE = {
    "rule_id": "rule-1",
    "name": "Vel Logistix Airspace",
    "sender_pattern": "vellogistix.com",
    "subject_pattern": "",
    "parser_type": "email-airspace",
    "enabled": True,
}


def test_custom_rule_matches_sender():
    result = classify_email(
        subject="Fwd: some dispatch",
        sender="dispatch@vellogistix.com",
        custom_rules=[_VELLOGISTIX_RULE],
    )
    assert result.is_order is True
    assert result.source == "email-airspace"
    assert result.original_sender == "dispatch@vellogistix.com"


def test_custom_rule_with_subject_filter():
    rule = {**_VELLOGISTIX_RULE, "subject_pattern": "dispatch"}
    result = classify_email(
        subject="Fwd: Airspace Dispatch Order",
        sender="dispatch@vellogistix.com",
        custom_rules=[rule],
    )
    assert result.is_order is True


def test_custom_rule_subject_mismatch():
    rule = {**_VELLOGISTIX_RULE, "subject_pattern": "dispatch"}
    result = classify_email(
        subject="Fwd: Weekly Summary",
        sender="dispatch@vellogistix.com",
        custom_rules=[rule],
    )
    assert result.is_order is False
    assert result.skip_reason == SkipReason.NO_SUBJECT_MATCH


def test_custom_rule_priority_over_builtin():
    """A custom rule matching a built-in sender should be used instead of the built-in rule."""
    # Custom rule overrides the Marken built-in rule to route to a different parser
    override_rule = {
        "rule_id": "rule-override",
        "name": "Override Marken",
        "sender_pattern": "marken.com",
        "subject_pattern": "",
        "parser_type": "email-cap",
        "enabled": True,
    }
    html = '<b>From:</b> &lt;no-reply@marken.com&gt; <br><b>Subject:</b> PICKUP ALERT #12345<br>'
    result = classify_email(
        subject="Fwd: PICKUP ALERT #12345",
        sender="dispatch@vellogistix.com",
        html_body=html,
        custom_rules=[override_rule],
    )
    assert result.is_order is True
    assert result.source == "email-cap"


def test_disabled_custom_rule_skipped():
    disabled_rule = {**_VELLOGISTIX_RULE, "sender_pattern": "unknown-carrier.com", "enabled": False}
    result = classify_email(
        subject="Fwd: some dispatch",
        sender="ops@unknown-carrier.com",
        custom_rules=[disabled_rule],
    )
    # Falls through to built-in rules; unknown-carrier.com is not in built-ins → NO_SENDER_MATCH
    assert result.is_order is False
    assert result.skip_reason == SkipReason.NO_SENDER_MATCH


def test_no_custom_rules_unchanged():
    """Passing custom_rules=None should produce same result as before."""
    html = '<b>From:</b> &lt;no-reply@marken.com&gt; <br><b>Subject:</b> PICKUP ALERT #12345<br>'
    result = classify_email(
        subject="Fwd: PICKUP ALERT #12345",
        sender="dispatch@vellogistix.com",
        html_body=html,
        custom_rules=None,
    )
    assert result.is_order is True
    assert result.source == EmailSource.MARKEN


def test_custom_rule_case_insensitive():
    rule = {**_VELLOGISTIX_RULE, "sender_pattern": "VelLogistix.COM"}
    result = classify_email(
        subject="Fwd: dispatch",
        sender="Dispatch@VelLogistix.com",
        custom_rules=[rule],
    )
    assert result.is_order is True


def test_custom_rule_domain_only_pattern():
    """Domain without @ should still match as a substring."""
    rule = {**_VELLOGISTIX_RULE, "sender_pattern": "vellogistix.com"}
    result = classify_email(
        subject="Fwd: dispatch",
        sender="ops@vellogistix.com",
        custom_rules=[rule],
    )
    assert result.is_order is True


def test_custom_rule_subject_checked_against_fwd_subject():
    """Subject pattern should also match against the Fwd-stripped envelope subject."""
    rule = {**_VELLOGISTIX_RULE, "subject_pattern": "airspace dispatch"}
    result = classify_email(
        subject="Fwd: Airspace Dispatch",
        sender="ops@vellogistix.com",
        # No HTML body — original_subject will fall back to envelope subject (after Fwd: strip)
        html_body="",
        text_body="",
        custom_rules=[rule],
    )
    assert result.is_order is True
