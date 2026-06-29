"""Email classification never logs PII in the clear (security backlog S-5).

Sender local-parts and subject content must not reach the logs; only the
org-level domain and a subject length indicator may. Covers all four log sites
in email_classifier (no-rules, full match, sender-match-no-subject, unknown).
"""

import logging
import os
import sys

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "../..")))

from backend.email_classifier import classify_email

SENDER = "john.doe@acme-logistics.com"
SUBJECT = "Order 5567 for Jane Patient at 12 Private Road"
PII_FRAGMENTS = ("john.doe", "Jane Patient", "Private Road")


def _logs(caplog) -> str:
    return "\n".join(rec.getMessage() for rec in caplog.records)


def _assert_no_pii(caplog):
    blob = _logs(caplog)
    assert blob, "expected at least one log record"
    for fragment in PII_FRAGMENTS:
        assert fragment not in blob, f"PII {fragment!r} leaked into logs: {blob!r}"
    # The redacted, org-level domain is still logged (useful, non-personal).
    assert "***@acme-logistics.com" in blob


def test_no_rules_redacts_sender(caplog):
    caplog.set_level(logging.DEBUG)
    classify_email(subject=SUBJECT, sender=SENDER, custom_rules=None)
    _assert_no_pii(caplog)


def test_unknown_sender_redacts_sender_and_subject(caplog):
    caplog.set_level(logging.DEBUG)
    rules = [{"name": "Other", "sender_pattern": "other-co.com", "subject_pattern": "", "parser_type": "email-ai", "enabled": True}]
    classify_email(subject=SUBJECT, sender=SENDER, custom_rules=rules)
    _assert_no_pii(caplog)


def test_sender_match_no_subject_redacts_subject(caplog):
    caplog.set_level(logging.INFO)
    rules = [{"name": "Acme", "sender_pattern": "acme-logistics.com", "subject_pattern": "NONMATCHING-XYZ", "parser_type": "email-ai", "enabled": True}]
    result = classify_email(subject=SUBJECT, sender=SENDER, custom_rules=rules)
    assert result.is_order is False
    _assert_no_pii(caplog)


def test_full_match_redacts_sender(caplog):
    caplog.set_level(logging.INFO)
    rules = [{"name": "Acme", "sender_pattern": "acme-logistics.com", "subject_pattern": "order", "parser_type": "email-ai", "enabled": True}]
    result = classify_email(subject=SUBJECT, sender=SENDER, custom_rules=rules)
    assert result.is_order is True
    _assert_no_pii(caplog)
