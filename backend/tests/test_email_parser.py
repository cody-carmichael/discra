import os, sys
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "../..")))

from backend.email_parser import (
    MarkenEmailParser,
    AirspaceEmailParser,
    CapLogisticsEmailParser,
    get_parser,
    _clean_text,
    _extract_weight,
    _parse_address_line,
    _parse_datetime_flexible,
)
from backend.gmail_client import GmailMessage, GmailAttachment


# --- Utility functions ---

def test_clean_text():
    assert _clean_text("  hello   world  ") == "hello world"
    assert _clean_text("no\xa0break") == "no break"
    assert _clean_text("&nbsp;test&nbsp;") == "test"


def test_extract_weight():
    assert _extract_weight("225.0 lbs") == 225.0
    assert _extract_weight("40.00 LBS") == 40.0
    assert _extract_weight("no weight here") is None


def test_parse_address_line():
    result = _parse_address_line("VIRGINIA BEACH,VA 23453 US")
    assert result["city"] == "VIRGINIA BEACH"
    assert result["state"] == "VA"
    assert result["zip"] == "23453"


def test_parse_address_line_simple():
    result = _parse_address_line("Memphis, TN 38118")
    assert result["city"] == "Memphis"
    assert result["state"] == "TN"
    assert result["zip"] == "38118"


def test_parse_datetime_flexible():
    dt = _parse_datetime_flexible("Mar 30, 2026 10:00")
    assert dt is not None
    assert dt.year == 2026
    assert dt.month == 3
    assert dt.day == 30

    assert _parse_datetime_flexible("") is None
    assert _parse_datetime_flexible("not a date") is None


# --- Parser registry ---

def test_get_parser():
    assert isinstance(get_parser("email-marken"), MarkenEmailParser)
    assert isinstance(get_parser("email-airspace"), AirspaceEmailParser)
    assert isinstance(get_parser("email-cap"), CapLogisticsEmailParser)
    assert get_parser("unknown") is None


# --- MarkenEmailParser ---

def test_marken_parser_basic():
    html_body = """
    <html><body>
    <table>
      <tr><td>ORDER#</td><td>INFO</td><td>DELIVER TO</td><td>ROUTING</td></tr>
      <tr>
        <td>12413656</td>
        <td>PCS/WT: 3 / 225.0 lbs (102.1 kg)\nDIMS: 1@15x13x12in, 2@30x22x20in</td>
        <td>ACME Corp\n123 Main St\nVIRGINIA BEACH,VA 23453 US\nPHONE: 555-1234\nDELIVER BY: Mar 30, 2026 10:00</td>
        <td>AA 1234 | DL 5678</td>
      </tr>
    </table>
    <p>PICKUP FROM:</p>
    <p>Fisher BioServices\n456 Lab Pkwy\nROCKVILLE,MD 20850 US\nPHONE: 555-9876\nPICKUP START: Mon Mar-30-2026 08:00\nPICKUP END: Mon Mar-30-2026 10:00</p>
    </body></html>
    """
    msg = GmailMessage(message_id="m1", thread_id="t1", html_body=html_body)
    parser = MarkenEmailParser()
    result = parser.parse(msg)

    assert result is not None
    assert result.reference_id == "12413656"
    assert result.source == "email-marken"
    assert result.num_packages == 3
    assert result.weight == 225.0


def test_marken_parser_returns_none_on_empty():
    msg = GmailMessage(message_id="m1", thread_id="t1", html_body="<html><body>No tables</body></html>")
    parser = MarkenEmailParser()
    result = parser.parse(msg)
    # No ORDER# found, should return None
    assert result is None


# --- AirspaceEmailParser ---

def test_airspace_parser_basic():
    html_body = """
    <html><body>
    <p>Order #3541972</p>
    <p>PICKUP BY:\nMar 30, 2026 10:00</p>
    <p>TENDER BY TIME:\nMar 30, 2026 14:00</p>
    <p>PICKUP CONTACT:\nJohn Smith\n555-4321</p>
    <p>TOTAL PIECES: 5</p>
    <p>TOTAL WEIGHT: 40.00 LBS</p>
    <p>1 of 20.0 x 20.0 x 20.0 IN @ 40.0 LBS</p>
    <p>AIR WAYBILLS: 123-45678901</p>
    </body></html>
    """
    msg = GmailMessage(
        message_id="m2",
        thread_id="t2",
        subject="Tracking ID: ATDRW32YW7, Order #: 3541972 - Pickup Dispatch",
        html_body=html_body,
    )
    parser = AirspaceEmailParser()
    result = parser.parse(msg)

    assert result is not None
    assert result.reference_id == "3541972"
    assert result.source == "email-airspace"
    assert result.num_packages == 5
    assert result.weight == 40.0
    assert result.customer_name == "John Smith"
    assert "Tracking: ATDRW32YW7" in result.notes


def test_airspace_parser_returns_none_without_order_number():
    msg = GmailMessage(
        message_id="m2",
        thread_id="t2",
        subject="Random email",
        html_body="<p>No order info</p>",
    )
    parser = AirspaceEmailParser()
    result = parser.parse(msg)
    assert result is None


# --- CapLogisticsEmailParser ---

def test_cap_logistics_parser_no_pdf():
    msg = GmailMessage(message_id="m3", thread_id="t3", subject="Agent Alert ABC123")
    parser = CapLogisticsEmailParser()
    result = parser.parse(msg)
    # No PDF attachment
    assert result is None


def test_cap_logistics_parser_with_pdf_reference():
    """Test that the parser extracts reference from subject even if PDF parsing produces minimal results."""
    # Create a minimal PDF-like attachment (won't actually parse with pdfplumber,
    # but tests the exception handling path)
    msg = GmailMessage(
        message_id="m3",
        thread_id="t3",
        subject="Agent Alert 2603A7308",
        attachments=[GmailAttachment(filename="dispatch.pdf", mime_type="application/pdf", data=b"not a real pdf")],
    )
    parser = CapLogisticsEmailParser()
    result = parser.parse(msg)
    # The PDF won't parse, so result should be None (no text extracted)
    assert result is None


# --- email_store tests ---

def test_email_config_store_crud():
    from backend.email_store import InMemoryEmailConfigStore
    from backend.schemas import EmailConfig

    store = InMemoryEmailConfigStore()
    config = EmailConfig(org_id="org1", gmail_email="test@gmail.com", email_connected=True)
    store.put_config(config)

    assert store.get_config("org1") is not None
    assert store.get_config("org1").gmail_email == "test@gmail.com"
    assert len(store.list_connected_orgs()) == 1

    store.delete_config("org1")
    assert store.get_config("org1") is None
    assert len(store.list_connected_orgs()) == 0


def test_email_config_store_update_poll_status():
    from backend.email_store import InMemoryEmailConfigStore
    from backend.schemas import EmailConfig

    store = InMemoryEmailConfigStore()
    config = EmailConfig(org_id="org1", email_connected=True)
    store.put_config(config)

    store.update_poll_status("org1", "12345")
    updated = store.get_config("org1")
    assert updated.gmail_history_id == "12345"
    assert updated.last_poll_at is not None
    assert updated.last_error is None

    store.update_poll_status("org1", "12346", error="some error")
    updated = store.get_config("org1")
    assert updated.last_error == "some error"


def test_skipped_email_store_crud():
    from backend.email_store import InMemorySkippedEmailStore
    from backend.schemas import SkippedEmail

    store = InMemorySkippedEmailStore()
    skipped = SkippedEmail(
        org_id="org1",
        email_message_id="msg1",
        sender="test@test.com",
        subject="Test",
        skip_reason="no_sender_match",
    )
    store.put_skipped(skipped)

    results = store.list_skipped("org1")
    assert len(results) == 1
    assert results[0].sender == "test@test.com"

    # Different org returns nothing
    assert len(store.list_skipped("org2")) == 0
