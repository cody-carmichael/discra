"""Email classification: determines whether an email is an order dispatch.

All classification rules are per-org config (see `/email/rules` CRUD). The
classifier matches forwarded-email headers against each org's configured
sender/subject patterns. There are no built-in, company-specific rules — any
new org configures their own vendors via the Admin console.

Inspects forwarded email headers since dispatch emails typically arrive as
forwards from a relay inbox.
"""

import re
import logging
from dataclasses import dataclass
from enum import Enum
from typing import Optional, Tuple

logger = logging.getLogger(__name__)


def _redact_email(value: str) -> str:
    """Mask the local-part of an email for logging, keeping the (org-level) domain
    for classification debugging (S-5). 'john.doe@acme.com' -> '***@acme.com';
    a value without '@' -> '***'; empty -> ''."""
    value = (value or "").strip()
    if not value:
        return ""
    if "@" not in value:
        return "***"
    _, _, domain = value.partition("@")
    return f"***@{domain}" if domain else "***"


def _redact_text(value: str) -> str:
    """Never log free-text headers (subjects can carry customer PII) — log only a
    length indicator so the line stays useful for ops without exposing content."""
    return f"<{len(value or '')} chars>"


class SkipReason(str, Enum):
    NO_SENDER_MATCH = "no_sender_match"
    NO_SUBJECT_MATCH = "no_subject_match"
    ALREADY_PROCESSED = "already_processed"


@dataclass
class ClassificationResult:
    is_order: bool
    # Parser key as a plain string, equal to the matched rule's parser_type.
    source: Optional[str] = None
    skip_reason: Optional[SkipReason] = None
    original_sender: str = ""
    original_subject: str = ""

# Pattern to extract forwarded email headers from the HTML body
_FWD_FROM_PATTERN = re.compile(
    r"<b>From:</b>\s*(?:.*?&lt;)?([^<>&\s]+@[^<>&\s]+?)(?:&gt;)?(?:</b>)?\s*<br",
    re.IGNORECASE | re.DOTALL,
)
_FWD_SUBJECT_PATTERN = re.compile(
    r"<b>Subject:</b>\s*(?:<b>)?\s*(.*?)(?:</b>)?\s*<br",
    re.IGNORECASE | re.DOTALL,
)

# Also handle plain-text forwarded headers
_FWD_FROM_PLAIN = re.compile(r"From:\s*(?:.*?<)?([^<>\s]+@[^<>\s]+)>?", re.IGNORECASE)
_FWD_SUBJECT_PLAIN = re.compile(r"Subject:\s*(.*?)(?:\n|$)", re.IGNORECASE)


def _extract_forwarded_headers(html_body: str, text_body: str) -> Tuple[str, str]:
    """Extract the original From and Subject from a forwarded email.

    Looks in both the HTML body and plain text body for forwarded header blocks.
    Returns (original_sender_email, original_subject).
    """
    original_sender = ""
    original_subject = ""

    # Try HTML body first
    if html_body:
        from_match = _FWD_FROM_PATTERN.search(html_body)
        if from_match:
            original_sender = from_match.group(1).strip()

        subject_match = _FWD_SUBJECT_PATTERN.search(html_body)
        if subject_match:
            raw = subject_match.group(1)
            # Strip HTML tags from extracted subject
            original_subject = re.sub(r"<[^>]+>", "", raw).strip()
            # Decode HTML entities
            original_subject = (
                original_subject.replace("&amp;", "&")
                .replace("&lt;", "<")
                .replace("&gt;", ">")
                .replace("&nbsp;", " ")
                .replace("&#39;", "'")
                .replace("&quot;", '"')
            )

    # Fallback to plain text body
    if not original_sender and text_body:
        from_match = _FWD_FROM_PLAIN.search(text_body)
        if from_match:
            original_sender = from_match.group(1).strip()

    if not original_subject and text_body:
        subject_match = _FWD_SUBJECT_PLAIN.search(text_body)
        if subject_match:
            original_subject = subject_match.group(1).strip()

    return original_sender, original_subject


def classify_email(
    subject: str,
    sender: str,
    html_body: str = "",
    text_body: str = "",
    custom_rules=None,
) -> ClassificationResult:
    """Classify an email as an order or non-order.

    First extracts forwarded headers from the body (since emails are forwarded).
    Then matches custom org rules (checked first), then the built-in sender allowlist.

    Args:
        subject: The envelope subject line of the email.
        sender: The envelope From header.
        html_body: The HTML body of the email.
        text_body: The plain text body of the email.
        custom_rules: Optional list of org-defined rule dicts (checked before built-in rules).

    Returns:
        ClassificationResult indicating whether this is an order and which source.
    """
    # Extract the original sender/subject from forwarded content
    original_sender, original_subject = _extract_forwarded_headers(html_body, text_body)

    # If we couldn't extract forwarded headers, use the envelope values
    if not original_sender:
        original_sender = sender
    if not original_subject:
        original_subject = subject

    # Also check the envelope subject (it often contains "Fwd: <original subject>")
    fwd_subject = subject
    if fwd_subject.lower().startswith("fwd:"):
        fwd_subject = fwd_subject[4:].strip()

    # All classification comes from per-org config. Rules with a specific
    # subject_pattern are tried before empty-subject catch-alls so a catch-all
    # can't shadow more specific parsers regardless of saved order.
    if not custom_rules:
        logger.debug("Unknown sender: %s (no rules configured)", _redact_email(original_sender))
        return ClassificationResult(
            is_order=False,
            skip_reason=SkipReason.NO_SENDER_MATCH,
            original_sender=original_sender,
            original_subject=original_subject,
        )

    ordered_rules = sorted(
        custom_rules,
        key=lambda r: not r.get("subject_pattern", "").strip(),
    )
    sender_matched = False
    for rule in ordered_rules:
        if not rule.get("enabled", True):
            continue
        sp = rule.get("sender_pattern", "").lower()
        if not sp or sp not in original_sender.lower():
            continue
        sender_matched = True
        subj_pat = rule.get("subject_pattern", "").lower()
        if (
            not subj_pat
            or subj_pat in original_subject.lower()
            or subj_pat in fwd_subject.lower()
        ):
            logger.info(
                "Rule '%s' matched sender %s",
                rule.get("name", ""),
                _redact_email(original_sender),
            )
            return ClassificationResult(
                is_order=True,
                source=rule.get("parser_type", ""),
                original_sender=original_sender,
                original_subject=original_subject,
            )
    if sender_matched:
        logger.info(
            "Rules matched sender %s but no subject_pattern accepted %s",
            _redact_email(original_sender),
            _redact_text(original_subject),
        )
        return ClassificationResult(
            is_order=False,
            skip_reason=SkipReason.NO_SUBJECT_MATCH,
            original_sender=original_sender,
            original_subject=original_subject,
        )

    logger.debug("Unknown sender: %s (subject: %s)", _redact_email(original_sender), _redact_text(original_subject))
    return ClassificationResult(
        is_order=False,
        skip_reason=SkipReason.NO_SENDER_MATCH,
        original_sender=original_sender,
        original_subject=original_subject,
    )
