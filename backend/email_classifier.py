"""Email classification: determines whether an email is an order dispatch.

Uses a sender allowlist + subject regex approach. Inspects forwarded email
headers since all emails arrive as forwards from the dispatch inbox.
"""

import re
import logging
from dataclasses import dataclass
from enum import Enum
from typing import Optional, Tuple

logger = logging.getLogger(__name__)


class EmailSource(str, Enum):
    MARKEN = "email-marken"
    AIRSPACE = "email-airspace"
    CAP_LOGISTICS = "email-cap"


class SkipReason(str, Enum):
    NO_SENDER_MATCH = "no_sender_match"
    NO_SUBJECT_MATCH = "no_subject_match"
    ALREADY_PROCESSED = "already_processed"


@dataclass
class ClassificationResult:
    is_order: bool
    source: Optional[EmailSource] = None
    skip_reason: Optional[SkipReason] = None
    original_sender: str = ""
    original_subject: str = ""


# Sender patterns mapped to (source, subject_regex)
_SENDER_RULES = [
    {
        "sender_pattern": re.compile(r"no-reply@marken\.com", re.IGNORECASE),
        "subject_pattern": re.compile(r"PICKUP\s+ALERT\s+#\d+", re.IGNORECASE),
        "source": EmailSource.MARKEN,
    },
    {
        "sender_pattern": re.compile(r"ops@airspace\.com|dispatch@vellogistix\.com", re.IGNORECASE),
        "subject_pattern": re.compile(r"Tracking\s+ID:.*Order\s+#:.*(Pickup|Delivery)\s+Dispatch", re.IGNORECASE),
        "source": EmailSource.AIRSPACE,
    },
    {
        "sender_pattern": re.compile(r"vendors@caplogistics\.com", re.IGNORECASE),
        "subject_pattern": re.compile(r"Agent\s+Alert\s+\w+", re.IGNORECASE),
        "source": EmailSource.CAP_LOGISTICS,
    },
]

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

    # Check org-level custom rules first (highest priority).
    # If a rule's sender matches but its subject does not, continue to the next
    # rule (and ultimately fall through to built-in rules) instead of returning.
    # The user may have multiple rules per sender, and a built-in rule may still
    # match even when no custom rule does.
    custom_sender_matched = False
    if custom_rules:
        for rule in custom_rules:
            if not rule.get("enabled", True):
                continue
            sp = rule.get("sender_pattern", "").lower()
            if not sp or sp not in original_sender.lower():
                continue
            custom_sender_matched = True
            subj_pat = rule.get("subject_pattern", "").lower()
            if subj_pat and subj_pat not in original_subject.lower() and subj_pat not in fwd_subject.lower():
                logger.info(
                    "Custom rule '%s' sender matched but subject did not; trying next rule",
                    rule.get("name", ""),
                )
                continue
            logger.info(
                "Custom rule '%s' matched sender %s",
                rule.get("name", ""),
                original_sender,
            )
            return ClassificationResult(
                is_order=True,
                source=rule.get("parser_type", ""),
                original_sender=original_sender,
                original_subject=original_subject,
            )

    # Fall back to built-in sender rules
    for rule in _SENDER_RULES:
        sender_match = rule["sender_pattern"].search(original_sender)
        if sender_match:
            # Known sender -- check subject
            subject_match = rule["subject_pattern"].search(original_subject) or rule["subject_pattern"].search(
                fwd_subject
            )
            if subject_match:
                return ClassificationResult(
                    is_order=True,
                    source=rule["source"],
                    original_sender=original_sender,
                    original_subject=original_subject,
                )
            else:
                logger.info(
                    "Known sender %s but subject does not match order pattern: %s",
                    original_sender,
                    original_subject,
                )
                return ClassificationResult(
                    is_order=False,
                    skip_reason=SkipReason.NO_SUBJECT_MATCH,
                    original_sender=original_sender,
                    original_subject=original_subject,
                )

    # Nothing matched. If a custom rule sender matched (but subject didn't) and
    # no built-in rule caught it either, report NO_SUBJECT_MATCH so the user
    # knows their rule's subject pattern is the problem.
    if custom_sender_matched:
        logger.info(
            "Custom rule sender(s) matched but no rule fully matched: %s",
            original_subject,
        )
        return ClassificationResult(
            is_order=False,
            skip_reason=SkipReason.NO_SUBJECT_MATCH,
            original_sender=original_sender,
            original_subject=original_subject,
        )

    # Unknown sender
    logger.debug("Unknown sender: %s (subject: %s)", original_sender, original_subject)
    return ClassificationResult(
        is_order=False,
        skip_reason=SkipReason.NO_SENDER_MATCH,
        original_sender=original_sender,
        original_subject=original_subject,
    )
