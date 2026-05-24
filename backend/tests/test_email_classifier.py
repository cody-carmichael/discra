"""Tests for the per-org email classifier.

All classification is driven by `custom_rules` (per-org config). Built-in
carrier-specific rules were removed in the 2026 rename — see
`backend/email_classifier.py` for the current contract.
"""

import os, sys
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "../..")))

from backend.email_classifier import (
    SkipReason,
    classify_email,
    _extract_forwarded_headers,
)


# --- Forwarded header extraction ---

def test_extract_forwarded_headers_html():
    html = (
        '<div><b>From:</b> Ops &lt;ops@somecarrier.com&gt;</b> <br>'
        '<b>Subject:</b> PICKUP ALERT #12345<br>'
    )
    sender, subject = _extract_forwarded_headers(html, "")
    assert sender == "ops@somecarrier.com"
    assert subject == "PICKUP ALERT #12345"


def test_extract_forwarded_headers_plain_text():
    text = "From: ops@somecarrier.com\nSubject: PICKUP ALERT #99999\n"
    sender, subject = _extract_forwarded_headers("", text)
    assert sender == "ops@somecarrier.com"
    assert subject == "PICKUP ALERT #99999"


def test_extract_forwarded_headers_html_entities():
    html = (
        '<b>From:</b> &lt;ops@somecarrier.com&gt; <br>'
        '<b>Subject:</b> Tracking ID: ABC &amp; Order #: 123<br>'
    )
    sender, subject = _extract_forwarded_headers(html, "")
    assert sender == "ops@somecarrier.com"
    assert "Tracking ID: ABC & Order #: 123" == subject


def test_extract_no_headers():
    sender, subject = _extract_forwarded_headers("", "")
    assert sender == ""
    assert subject == ""


# --- classify_email: no rules configured ---

def test_classify_with_no_rules_returns_no_sender_match():
    """With no custom rules and no built-ins, every email is unknown."""
    result = classify_email(
        subject="Some Dispatch",
        sender="ops@somecarrier.com",
    )
    assert result.is_order is False
    assert result.skip_reason == SkipReason.NO_SENDER_MATCH


def test_classify_unknown_sender_with_unrelated_rules():
    """A custom rule for a different sender doesn't match an unrelated email."""
    rule = {
        "rule_id": "rule-1",
        "name": "Test rule",
        "sender_pattern": "carrierA.com",
        "subject_pattern": "",
        "parser_type": "email-html-table",
        "enabled": True,
    }
    result = classify_email(
        subject="Hello there",
        sender="random@gmail.com",
        custom_rules=[rule],
    )
    assert result.is_order is False
    assert result.skip_reason == SkipReason.NO_SENDER_MATCH


# --- classify_email: with custom rules ---

_CARRIER_A_RULE = {
    "rule_id": "rule-1",
    "name": "Carrier A → table",
    "sender_pattern": "carriera.com",
    "subject_pattern": "",
    "parser_type": "email-html-table",
    "enabled": True,
}


def test_custom_rule_matches_sender():
    result = classify_email(
        subject="Fwd: some dispatch",
        sender="ops@carriera.com",
        custom_rules=[_CARRIER_A_RULE],
    )
    assert result.is_order is True
    assert result.source == "email-html-table"
    assert result.original_sender == "ops@carriera.com"


def test_custom_rule_with_subject_filter_matches():
    rule = {**_CARRIER_A_RULE, "subject_pattern": "dispatch"}
    result = classify_email(
        subject="Fwd: Dispatch Order #555",
        sender="ops@carriera.com",
        custom_rules=[rule],
    )
    assert result.is_order is True


def test_custom_rule_subject_mismatch():
    rule = {**_CARRIER_A_RULE, "subject_pattern": "dispatch"}
    result = classify_email(
        subject="Fwd: Weekly Summary",
        sender="ops@carriera.com",
        custom_rules=[rule],
    )
    assert result.is_order is False
    assert result.skip_reason == SkipReason.NO_SUBJECT_MATCH


def test_classify_uses_envelope_when_no_forwarded_headers():
    """Without forwarded headers, the envelope sender + subject are used directly."""
    result = classify_email(
        subject="PICKUP ALERT #99999",
        sender="ops@carriera.com",
        html_body="<p>Simple body with no forwarded headers</p>",
        custom_rules=[_CARRIER_A_RULE],
    )
    assert result.is_order is True
    assert result.source == "email-html-table"
    assert result.original_sender == "ops@carriera.com"


def test_classify_strips_fwd_from_envelope_subject():
    rule = {**_CARRIER_A_RULE, "subject_pattern": "Pickup Alert"}
    result = classify_email(
        subject="Fwd: Pickup Alert 2603A7308",
        sender="ops@carriera.com",
        html_body="",
        text_body="",
        custom_rules=[rule],
    )
    assert result.is_order is True


def test_disabled_custom_rule_skipped():
    disabled_rule = {**_CARRIER_A_RULE, "enabled": False}
    result = classify_email(
        subject="Fwd: some dispatch",
        sender="ops@carriera.com",
        custom_rules=[disabled_rule],
    )
    # No other rules, no built-ins → NO_SENDER_MATCH
    assert result.is_order is False
    assert result.skip_reason == SkipReason.NO_SENDER_MATCH


def test_custom_rule_case_insensitive():
    rule = {**_CARRIER_A_RULE, "sender_pattern": "CarrierA.COM"}
    result = classify_email(
        subject="Fwd: dispatch",
        sender="Dispatch@CarrierA.com",
        custom_rules=[rule],
    )
    assert result.is_order is True


def test_custom_rule_domain_only_pattern():
    """Domain without @ should still match as a substring."""
    rule = {**_CARRIER_A_RULE, "sender_pattern": "carriera.com"}
    result = classify_email(
        subject="Fwd: dispatch",
        sender="ops@carriera.com",
        custom_rules=[rule],
    )
    assert result.is_order is True


def test_custom_rule_subject_checked_against_fwd_subject():
    """Subject pattern should also match against the Fwd-stripped envelope subject."""
    rule = {**_CARRIER_A_RULE, "subject_pattern": "labeled dispatch"}
    result = classify_email(
        subject="Fwd: Labeled Dispatch",
        sender="ops@carriera.com",
        # No HTML body — original_subject will fall back to envelope subject (after Fwd: strip)
        html_body="",
        text_body="",
        custom_rules=[rule],
    )
    assert result.is_order is True


# --- Multi-rule iteration ---

def _rule(name, sender, subject_pattern, parser_type="email-labeled-fields", enabled=True):
    return {
        "rule_id": f"rule-{name}",
        "name": name,
        "sender_pattern": sender,
        "subject_pattern": subject_pattern,
        "parser_type": parser_type,
        "enabled": enabled,
    }


def test_multiple_rules_same_sender_first_fails_second_matches():
    """When rule A (subject 'PICKUP ALERT') fails, rule B (subject 'Agent Alert') should still be evaluated."""
    rules = [
        _rule("rule-table", "carriera.com", "PICKUP ALERT", parser_type="email-html-table"),
        _rule("rule-pdf", "carriera.com", "Agent Alert", parser_type="email-pdf-attachment"),
    ]
    result = classify_email(
        subject="Agent Alert 2604A5414",
        sender="dispatch@carriera.com",
        custom_rules=rules,
    )
    assert result.is_order is True
    assert result.source == "email-pdf-attachment"


def test_catchall_rule_after_specific_rules():
    """With an empty-subject catch-all at the end, any sender-matching email should classify as an order."""
    rules = [
        _rule("specific-table", "carriera.com", "PICKUP ALERT", parser_type="email-html-table"),
        _rule("specific-pdf", "carriera.com", "Agent Alert", parser_type="email-pdf-attachment"),
        _rule("catchall-ai", "carriera.com", "", parser_type="email-ai"),
    ]
    result = classify_email(
        subject="Tracking ID: AT4YC6GGW9, Order #: 3607991 - Delivery Dispatch",
        sender="dispatch@carriera.com",
        custom_rules=rules,
    )
    assert result.is_order is True
    assert result.source == "email-ai"


def test_catchall_rule_sorted_last_even_if_saved_first():
    """A catch-all placed first in saved order must not shadow a more specific rule below it."""
    rules = [
        _rule("catchall-ai", "carriera.com", "", parser_type="email-ai"),
        _rule("specific-pdf", "carriera.com", "Agent Alert", parser_type="email-pdf-attachment"),
    ]
    result = classify_email(
        subject="Agent Alert 2604A5414",
        sender="dispatch@carriera.com",
        custom_rules=rules,
    )
    assert result.is_order is True
    assert result.source == "email-pdf-attachment"


def test_all_matching_sender_rules_fail_subject():
    """If every sender-matching rule has a subject filter that fails, return NO_SUBJECT_MATCH."""
    rules = [
        _rule("rule-a", "carriera.com", "PICKUP ALERT"),
        _rule("rule-b", "carriera.com", "Agent Alert"),
    ]
    result = classify_email(
        subject="Weekly Summary",
        sender="dispatch@carriera.com",
        custom_rules=rules,
    )
    assert result.is_order is False
    assert result.skip_reason == SkipReason.NO_SUBJECT_MATCH
