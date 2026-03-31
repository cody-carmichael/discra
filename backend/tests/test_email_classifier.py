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
