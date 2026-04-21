"""Tests for the email poller's orchestration of classification + parsing.

Focuses on the wiring between `_process_org`, the classifier, and the Gmail
client — specifically that the org's custom classification rules are forwarded
to `classify_email`.
"""

import os
import sys
from datetime import datetime, timezone
from unittest.mock import MagicMock, patch

import pytest

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "../..")))

from backend import email_poller
from backend.email_classifier import ClassificationResult, SkipReason
from backend.email_store import (
    get_email_config_store,
    get_skipped_email_store,
    reset_in_memory_email_config_store,
)
from backend.schemas import EmailConfig, EmailRule


@pytest.fixture(autouse=True)
def _env(monkeypatch):
    monkeypatch.setenv("USE_IN_MEMORY_EMAIL_STORE", "true")
    reset_in_memory_email_config_store()
    # Clear any skipped rows from prior tests.
    store = get_skipped_email_store()
    if hasattr(store, "items"):
        store.items.clear()


def _seed_with_rule(**rule_overrides) -> EmailConfig:
    now = datetime.now(timezone.utc)
    rule_fields = dict(
        rule_id="rule-1",
        name="Vel Logistix AI",
        sender_pattern="vellogistix.com",
        subject_pattern="",
        parser_type="email-airspace",
        enabled=True,
        created_at=now,
        updated_at=now,
    )
    rule_fields.update(rule_overrides)
    rule = EmailRule(**rule_fields)
    cfg = EmailConfig(
        org_id="org-poll",
        gmail_email="dispatcher@example.com",
        gmail_refresh_token="tok",
        email_connected=True,
        connected_at=now,
        gmail_history_id="100",
        email_rules=[rule],
    )
    get_email_config_store().put_config(cfg)
    return cfg


def _fake_message(sender: str, subject: str):
    msg = MagicMock()
    msg.sender = sender
    msg.subject = subject
    msg.html_body = ""
    msg.text_body = ""
    return msg


def test_process_org_passes_custom_rules_to_classifier():
    """The poller must forward org_config.email_rules to classify_email."""
    cfg = _seed_with_rule(subject_pattern="Agent Alert", parser_type="email-cap")

    fake_gmail = MagicMock()
    fake_gmail.list_new_message_ids.return_value = (["msg-1"], "200")
    fake_gmail.has_label.return_value = False
    fake_gmail.get_message.return_value = _fake_message(
        sender="dispatch@vellogistix.com",
        subject="Agent Alert 2604A5414",
    )

    captured = {}

    def fake_classify(**kwargs):
        captured.update(kwargs)
        # Simulate a skip so the poller doesn't try to parse.
        return ClassificationResult(
            is_order=False,
            skip_reason=SkipReason.NO_SUBJECT_MATCH,
            original_sender=kwargs["sender"],
            original_subject=kwargs["subject"],
        )

    with patch("backend.email_poller.GmailClient", return_value=fake_gmail), \
         patch("backend.email_poller.classify_email", side_effect=fake_classify):
        email_poller._process_org(cfg)

    assert "custom_rules" in captured
    rules = captured["custom_rules"]
    assert len(rules) == 1
    assert rules[0]["sender_pattern"] == "vellogistix.com"
    assert rules[0]["subject_pattern"] == "Agent Alert"
    assert rules[0]["parser_type"] == "email-cap"
    assert rules[0]["enabled"] is True


def test_process_org_passes_empty_list_when_no_rules():
    """Orgs with no rules should still poll — classify_email receives []."""
    now = datetime.now(timezone.utc)
    cfg = EmailConfig(
        org_id="org-poll",
        gmail_email="dispatcher@example.com",
        gmail_refresh_token="tok",
        email_connected=True,
        connected_at=now,
        gmail_history_id="100",
        email_rules=[],
    )
    get_email_config_store().put_config(cfg)

    fake_gmail = MagicMock()
    fake_gmail.list_new_message_ids.return_value = (["msg-1"], "200")
    fake_gmail.has_label.return_value = False
    fake_gmail.get_message.return_value = _fake_message(
        sender="unknown@example.com",
        subject="anything",
    )

    captured = {}

    def fake_classify(**kwargs):
        captured.update(kwargs)
        return ClassificationResult(
            is_order=False,
            skip_reason=SkipReason.NO_SENDER_MATCH,
            original_sender=kwargs["sender"],
            original_subject=kwargs["subject"],
        )

    with patch("backend.email_poller.GmailClient", return_value=fake_gmail), \
         patch("backend.email_poller.classify_email", side_effect=fake_classify):
        email_poller._process_org(cfg)

    assert captured.get("custom_rules") == []
