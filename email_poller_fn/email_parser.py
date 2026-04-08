"""Email parsers for extracting order data from dispatch emails.

Each parser handles a specific email format (Marken, Airspace, CAP Logistics)
and extracts structured order fields from HTML bodies or PDF attachments.
"""

import io
import logging
import re
from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Dict, List, Optional

from bs4 import BeautifulSoup

logger = logging.getLogger(__name__)

from gmail_client import GmailMessage


@dataclass
class ParsedOrder:
    """Structured order data extracted from an email."""

    reference_id: str = ""
    customer_name: str = ""
    pick_up_street: str = ""
    pick_up_city: str = ""
    pick_up_state: str = ""
    pick_up_zip: str = ""
    pickup_phone: str = ""
    delivery_street: str = ""
    delivery_city: str = ""
    delivery_state: str = ""
    delivery_zip: str = ""
    delivery_phone: str = ""
    pickup_deadline: Optional[datetime] = None
    dropoff_deadline: Optional[datetime] = None
    dimensions: str = ""
    weight: Optional[float] = None
    num_packages: int = 1
    notes: str = ""
    source: str = ""
    external_order_id: str = ""


class EmailParser(ABC):
    """Base class for email parsers."""

    @abstractmethod
    def parse(self, message: GmailMessage) -> Optional[ParsedOrder]:
        """Parse a Gmail message into a ParsedOrder, or None if parsing fails."""
        raise NotImplementedError


def _clean_text(text: str) -> str:
    """Strip whitespace, decode common HTML entities, remove extra spaces."""
    text = text.replace("\xa0", " ").replace("&nbsp;", " ")
    text = re.sub(r"\s+", " ", text).strip()
    return text


def _parse_datetime_flexible(date_str: str) -> Optional[datetime]:
    """Attempt to parse a date string from various formats found in dispatch emails."""
    if not date_str:
        return None
    date_str = date_str.strip()

    formats = [
        "%a %b-%d-%Y %H:%M",       # MON MAR-30-2026 10:00
        "%b %d, %Y %H:%M",         # Mar 30, 2026 10:00
        "%b %d, %Y, %H:%M %Z",     # Mar 29, 2026, 20:25 CDT
        "%b %d, %Y, %H:%M %z",     # Mar 29, 2026, 20:25 -0500
        "%Y-%m-%d",                 # 2026-03-30
        "%b %d, %Y %I:%M %p",      # Mar 28, 2026 1:41 pm
        "%b %d, %y  %H:%M %Z",     # Mar 30, 26  06:06 CDT
    ]

    # Normalize day abbreviations
    day_abbrevs = {"MON": "Mon", "TUE": "Tue", "WED": "Wed", "THU": "Thu", "FRI": "Fri", "SAT": "Sat", "SUN": "Sun"}
    for abbr, repl in day_abbrevs.items():
        if date_str.upper().startswith(abbr):
            date_str = repl + date_str[3:]

    # Remove timezone abbreviations that Python doesn't understand natively
    tz_stripped = re.sub(r"\s+(CDT|CST|EDT|EST|PDT|PST|MDT|MST)\s*$", "", date_str, flags=re.IGNORECASE)

    for fmt in formats:
        try:
            return datetime.strptime(tz_stripped, fmt).replace(tzinfo=timezone.utc)
        except ValueError:
            continue
        try:
            return datetime.strptime(date_str, fmt).replace(tzinfo=timezone.utc)
        except ValueError:
            continue

    logger.debug("Could not parse date: %s", date_str)
    return None


def _extract_weight(text: str) -> Optional[float]:
    """Extract weight value in lbs from a string like '225.0 lbs' or '40.00 LBS'."""
    match = re.search(r"([\d.]+)\s*(?:lbs?|LBS?|pounds?)", text)
    if match:
        try:
            return float(match.group(1))
        except ValueError:
            pass
    return None


def _parse_address_line(addr_str: str) -> Dict[str, str]:
    """Parse 'CITY,STATE ZIP COUNTRY' or 'CITY, STATE ZIP' into components."""
    result = {"street": "", "city": "", "state": "", "zip": ""}

    # Try pattern: CITY,STATE ZIP [COUNTRY]
    match = re.match(r"^(.+?),\s*(\w{2})\s+(\d{5}(?:-\d{4})?)\s*(?:US|USA)?$", addr_str.strip(), re.IGNORECASE)
    if match:
        result["city"] = match.group(1).strip()
        result["state"] = match.group(2).strip()
        result["zip"] = match.group(3).strip()
        return result

    # Try: State only (2-letter) + zip
    match = re.search(r"(\w{2})\s+(\d{5})", addr_str)
    if match:
        result["state"] = match.group(1)
        result["zip"] = match.group(2)
        before = addr_str[: match.start()].strip().rstrip(",")
        result["city"] = before

    return result


class MarkenEmailParser(EmailParser):
    """Parser for Marken PICKUP ALERT emails.

    These emails contain HTML tables with order details including:
    - ORDER# in the first data row
    - Pickup and delivery addresses in bold text blocks
    - Shipment details (pieces, weight, dimensions) in table cells
    - Routing info (airline, flights)
    """

    def parse(self, message: GmailMessage) -> Optional[ParsedOrder]:
        try:
            return self._parse_inner(message)
        except Exception as e:
            logger.error("MarkenEmailParser failed for message %s: %s", message.message_id, e)
            return None

    def _parse_inner(self, message: GmailMessage) -> Optional[ParsedOrder]:
        soup = BeautifulSoup(message.html_body, "html.parser")
        order = ParsedOrder(source="email-marken")

        # Extract ORDER# from the data table
        # The table has headers: ORDER# | INFO | DELIVER TO | ROUTING
        tables = soup.find_all("table")
        order_table = None
        for table in tables:
            header_row = table.find("tr")
            if header_row:
                headers = [_clean_text(td.get_text()) for td in header_row.find_all(["td", "th"])]
                if any("ORDER" in h.upper() for h in headers):
                    order_table = table
                    break

        if order_table:
            data_rows = order_table.find_all("tr")[1:]  # Skip header
            if data_rows:
                cells = data_rows[0].find_all("td")
                if len(cells) >= 3:
                    order.reference_id = _clean_text(cells[0].get_text())
                    order.external_order_id = order.reference_id

                    # Parse INFO cell for pieces/weight/dimensions
                    info_text = cells[1].get_text(separator="\n")
                    self._parse_info_cell(order, info_text)

                    # Parse DELIVER TO cell
                    deliver_text = cells[2].get_text(separator="\n")
                    self._parse_deliver_to(order, deliver_text)

                    # Parse ROUTING cell for notes
                    if len(cells) >= 4:
                        routing_text = _clean_text(cells[3].get_text(separator=" | "))
                        order.notes = routing_text

        # Extract PICKUP FROM section (bold text block after "PICKUP FROM:")
        body_text = soup.get_text(separator="\n")
        self._parse_pickup_from(order, body_text)

        # Extract AWB from INSTRUCTIONS section
        instructions_match = re.search(r"INSTRUCTIONS:\s*\n?\s*(.*?)(?:\n\n|Hello)", body_text, re.DOTALL)
        if instructions_match:
            awb_info = _clean_text(instructions_match.group(1))
            if order.notes:
                order.notes = f"AWB: {awb_info} | {order.notes}"
            else:
                order.notes = f"AWB: {awb_info}"

        if not order.customer_name:
            order.customer_name = "Marken Pickup"

        return order if order.reference_id else None

    def _parse_info_cell(self, order: ParsedOrder, info_text: str):
        """Parse the INFO cell which contains pieces, weight, dimensions."""
        # PCS/WT: 3 / 225.0 lbs (102.1 kg)
        pcs_match = re.search(r"PCS/WT:\s*(\d+)\s*/\s*([\d.]+)\s*lbs?", info_text, re.IGNORECASE)
        if pcs_match:
            order.num_packages = int(pcs_match.group(1))
            order.weight = float(pcs_match.group(2))

        # DIMS: 1@15x13x12in, 2@30x22x20in
        dims_match = re.search(r"DIMS?:\s*(.*?)(?:\n|$)", info_text, re.IGNORECASE)
        if dims_match:
            order.dimensions = _clean_text(dims_match.group(1))

        # Delivery deadline from info
        ddl_match = re.search(r"DELIVERY DEADLINE DATE.*?=\s*([\d-]+)", info_text)
        if ddl_match:
            order.dropoff_deadline = _parse_datetime_flexible(ddl_match.group(1))

    def _parse_deliver_to(self, order: ParsedOrder, deliver_text: str):
        """Parse the DELIVER TO cell for delivery address."""
        lines = [l.strip() for l in deliver_text.strip().split("\n") if l.strip()]
        if len(lines) >= 3:
            order.delivery_street = lines[1] if len(lines) > 1 else ""
            # Parse city,state zip from line like "VIRGINIA BEACH,VA 23453 US"
            if len(lines) > 2:
                addr = _parse_address_line(lines[2])
                order.delivery_city = addr["city"]
                order.delivery_state = addr["state"]
                order.delivery_zip = addr["zip"]

        # Extract phone
        phone_match = re.search(r"PHONE:\s*([\d\-+() ]+)", deliver_text)
        if phone_match:
            order.delivery_phone = _clean_text(phone_match.group(1))

        # Extract DELIVER BY time
        deliver_by_match = re.search(r"DELIVER BY:\s*(.*?)(?:\n|$)", deliver_text)
        if deliver_by_match:
            order.dropoff_deadline = _parse_datetime_flexible(deliver_by_match.group(1))

    def _parse_pickup_from(self, order: ParsedOrder, body_text: str):
        """Extract pickup address from the PICKUP FROM section."""
        pickup_match = re.search(r"PICKUP FROM:\s*\n(.*?)(?:Distance:|PICKUP THE)", body_text, re.DOTALL)
        if not pickup_match:
            return

        pickup_block = pickup_match.group(1).strip()
        lines = [l.strip() for l in pickup_block.split("\n") if l.strip()]

        if lines:
            order.customer_name = lines[0]
        if len(lines) > 1:
            order.pick_up_street = lines[1]
        if len(lines) > 2:
            addr = _parse_address_line(lines[2])
            order.pick_up_city = addr["city"]
            order.pick_up_state = addr["state"]
            order.pick_up_zip = addr["zip"]

        # Phone
        phone_match = re.search(r"PHONE:\s*([\d\-+() ]+)", pickup_block)
        if phone_match:
            order.pickup_phone = _clean_text(phone_match.group(1))

        # Pickup start/end times
        start_match = re.search(r"PICKUP START:\s*(.*?)(?:\n|$)", pickup_block)
        if start_match:
            order.pickup_deadline = _parse_datetime_flexible(start_match.group(1))

        end_match = re.search(r"PICKUP END:\s*(.*?)(?:\n|$)", pickup_block)
        if end_match:
            order.pickup_deadline = _parse_datetime_flexible(end_match.group(1))


class AirspaceEmailParser(EmailParser):
    """Parser for Airspace Pickup/Delivery Dispatch emails.

    These emails have a well-structured HTML layout with labeled sections:
    ORDER REFERENCES, PICKUP ADDRESS, PICKUP/DELIVERY CONTACT, DELIVERY ADDRESS,
    FLIGHT INFO, VEHICLE TYPE, DANGEROUS GOODS, TOTAL PIECES, TOTAL WEIGHT.
    Handles both "Pickup Dispatch" (PICKUP BY / TENDER BY TIME / PICKUP CONTACT)
    and "Delivery Dispatch" (PICKUP TIME / DELIVER BY / DELIVERY CONTACT) formats.
    """

    def parse(self, message: GmailMessage) -> Optional[ParsedOrder]:
        try:
            return self._parse_inner(message)
        except Exception as e:
            logger.error("AirspaceEmailParser failed for message %s: %s", message.message_id, e)
            return None

    def _parse_inner(self, message: GmailMessage) -> Optional[ParsedOrder]:
        soup = BeautifulSoup(message.html_body, "html.parser")
        order = ParsedOrder(source="email-airspace")
        body_text = soup.get_text(separator="\n")

        # Extract Order # from subject or body
        order_match = re.search(r"Order\s+#[:\s]*(\d+)", message.subject) or re.search(
            r"Order\s+#(\d+)", body_text
        )
        if order_match:
            order.reference_id = order_match.group(1)
            order.external_order_id = order.reference_id

        # Tracking ID
        tracking_match = re.search(r"Tracking\s+ID[:\s]*(\w+)", message.subject) or re.search(
            r"Tracking\s+ID[:\s]*(\w+)", body_text
        )
        tracking_id = tracking_match.group(1) if tracking_match else ""

        # PICKUP BY (Pickup Dispatch) or PICKUP TIME (Delivery Dispatch)
        pickup_by_match = re.search(r"PICKUP(?:\s+BY|TIME):\s*\n?\s*(.+?)(?:\n|$)", body_text)
        if pickup_by_match:
            order.pickup_deadline = _parse_datetime_flexible(pickup_by_match.group(1).strip())

        # TENDER BY TIME (Pickup Dispatch) or DELIVER BY (Delivery Dispatch)
        tender_match = re.search(r"(?:TENDER BY TIME|DELIVER BY):\s*\n?\s*(.+?)(?:\n|$)", body_text)
        if tender_match:
            order.dropoff_deadline = _parse_datetime_flexible(tender_match.group(1).strip())

        # AIR WAYBILLS
        awb_match = re.search(r"AIR WAYBILLS?:\s*\n?\s*(.+?)(?:\n|$)", body_text)
        awb = awb_match.group(1).strip() if awb_match else ""

        # ORDER REFERENCES
        po_match = re.search(r"PO#\s+or\s+MR#:\s*(.*?)(?:\n|$)", body_text)
        po_number = po_match.group(1).strip() if po_match else ""

        # PICKUP ADDRESS - look for labeled section
        self._parse_address_section(order, body_text, "PICKUP ADDRESS:", "pick_up")

        # PICKUP CONTACT (Pickup Dispatch) or DELIVERY CONTACT (Delivery Dispatch)
        contact_match = re.search(r"(?:PICKUP|DELIVERY) CONTACT:\s*\n?\s*(.+?)(?:\n\+|\n[A-Z])", body_text, re.DOTALL)
        if contact_match:
            contact_lines = [l.strip() for l in contact_match.group(1).strip().split("\n") if l.strip()]
            if contact_lines:
                order.customer_name = contact_lines[0]
            if len(contact_lines) > 1:
                order.pickup_phone = contact_lines[1]

        # DELIVERY ADDRESS
        self._parse_address_section(order, body_text, "DELIVERY ADDRESS:", "delivery")

        # TOTAL PIECES
        pieces_match = re.search(r"TOTAL PIECES:\s*(\d+)", body_text)
        if pieces_match:
            order.num_packages = int(pieces_match.group(1))

        # TOTAL WEIGHT
        weight_match = re.search(r"TOTAL WEIGHT:\s*([\d.]+)\s*LBS?", body_text, re.IGNORECASE)
        if weight_match:
            order.weight = float(weight_match.group(1))

        # Dimensions from piece line like "1 of 20.0 x 20.0 x 20.0 IN @ 40.0 LBS"
        dims_match = re.search(r"\d+\s+of\s+([\d.]+\s*x\s*[\d.]+\s*x\s*[\d.]+\s*IN)", body_text, re.IGNORECASE)
        if dims_match:
            order.dimensions = dims_match.group(1).strip()

        # Build notes
        notes_parts = []
        if tracking_id:
            notes_parts.append(f"Tracking: {tracking_id}")
        if awb:
            notes_parts.append(f"AWB: {awb}")
        if po_number:
            notes_parts.append(f"PO: {po_number}")

        # Flight info
        flight_match = re.search(r"FLIGHT INFO:\s*\n?\s*(.+?)(?:\nAIRLINE|VEHICLE|DANGEROUS|TOTAL)", body_text, re.DOTALL)
        if flight_match:
            flight_text = _clean_text(flight_match.group(1))
            notes_parts.append(f"Flight: {flight_text}")

        order.notes = " | ".join(notes_parts)

        if not order.customer_name:
            order.customer_name = "Airspace Dispatch"

        return order if order.reference_id else None

    def _parse_address_section(self, order: ParsedOrder, body_text: str, label: str, prefix: str):
        """Parse a labeled address section from the body text."""
        pattern = rf"{re.escape(label)}\s*\n(.*?)(?:\n[A-Z]{{2,}}|\nPICKUP|DELIVERY|FLIGHT|ORDER|VEHICLE|$)"
        match = re.search(pattern, body_text, re.DOTALL)
        if not match:
            return

        lines = [l.strip() for l in match.group(1).strip().split("\n") if l.strip()]
        # Typical structure: Name, Street, City State Zip, Country
        # Filter out "United States of America" etc.
        addr_lines = [l for l in lines if not re.match(r"^(United States|USA?|Canada)\b", l, re.IGNORECASE)]

        if addr_lines:
            if prefix == "pick_up":
                # First line might be the location name (already captured as customer_name from contact)
                if len(addr_lines) >= 2:
                    order.pick_up_street = addr_lines[1] if len(addr_lines) > 1 else addr_lines[0]
                elif addr_lines:
                    order.pick_up_street = addr_lines[0]

                # Parse city/state/zip from last address-like line
                for line in reversed(addr_lines):
                    addr = _parse_address_line(line)
                    if addr["state"] and addr["zip"]:
                        order.pick_up_city = addr["city"]
                        order.pick_up_state = addr["state"]
                        order.pick_up_zip = addr["zip"]
                        break
            else:
                if len(addr_lines) >= 2:
                    order.delivery_street = addr_lines[1] if len(addr_lines) > 1 else addr_lines[0]
                elif addr_lines:
                    order.delivery_street = addr_lines[0]

                for line in reversed(addr_lines):
                    addr = _parse_address_line(line)
                    if addr["state"] and addr["zip"]:
                        order.delivery_city = addr["city"]
                        order.delivery_state = addr["state"]
                        order.delivery_zip = addr["zip"]
                        break


class CapLogisticsEmailParser(EmailParser):
    """Parser for CAP Logistics Agent Alert emails.

    Order data is in a PDF attachment, not the email body.
    Uses pdfplumber to extract text from the PDF.
    """

    def parse(self, message: GmailMessage) -> Optional[ParsedOrder]:
        try:
            return self._parse_inner(message)
        except Exception as e:
            logger.error("CapLogisticsEmailParser failed for message %s: %s", message.message_id, e)
            return None

    def _parse_inner(self, message: GmailMessage) -> Optional[ParsedOrder]:
        # Find the PDF attachment
        pdf_attachment = None
        for att in message.attachments:
            if att.mime_type == "application/pdf" or att.filename.lower().endswith(".pdf"):
                pdf_attachment = att
                break

        if not pdf_attachment:
            logger.warning("CapLogisticsEmailParser: no PDF attachment found for message %s", message.message_id)
            return None

        # Extract text from PDF
        pdf_text = self._extract_pdf_text(pdf_attachment.data)
        if not pdf_text:
            logger.warning("CapLogisticsEmailParser: could not extract text from PDF for message %s", message.message_id)
            return None

        order = ParsedOrder(source="email-cap")

        # Extract alert/order reference from subject or PDF
        alert_match = re.search(r"Agent\s+Alert\s+(\w+)", message.subject)
        if alert_match:
            order.reference_id = alert_match.group(1)
            order.external_order_id = order.reference_id

        # Parse PDF text for order fields
        self._parse_pdf_text(order, pdf_text)

        if not order.customer_name:
            order.customer_name = f"CAP Logistics Alert {order.reference_id}"

        return order if order.reference_id else None

    def _extract_pdf_text(self, pdf_data: bytes) -> str:
        """Extract text from PDF bytes using pdfplumber."""
        try:
            import pdfplumber

            with pdfplumber.open(io.BytesIO(pdf_data)) as pdf:
                pages_text = []
                for page in pdf.pages:
                    text = page.extract_text()
                    if text:
                        pages_text.append(text)
                return "\n".join(pages_text)
        except ImportError:
            logger.error("pdfplumber not installed, cannot parse PDF attachments")
            return ""
        except Exception as e:
            logger.error("PDF text extraction failed: %s", e)
            return ""

    def _parse_pdf_text(self, order: ParsedOrder, pdf_text: str):
        """Parse structured fields from CAP Logistics PDF text."""
        # Common patterns in logistics dispatch PDFs
        # Pickup address
        pickup_match = re.search(
            r"(?:Pick\s*up|Pickup|Origin|Shipper)\s*(?:Address|Location)?[:\s]*\n?(.*?)(?:Deliver|Destination|Consignee|\n\n)",
            pdf_text,
            re.IGNORECASE | re.DOTALL,
        )
        if pickup_match:
            self._parse_address_block(order, pickup_match.group(1), "pick_up")

        # Delivery address
        delivery_match = re.search(
            r"(?:Deliver|Delivery|Destination|Consignee)\s*(?:Address|Location|To)?[:\s]*\n?(.*?)(?:Pieces|Weight|Special|\n\n|$)",
            pdf_text,
            re.IGNORECASE | re.DOTALL,
        )
        if delivery_match:
            self._parse_address_block(order, delivery_match.group(1), "delivery")

        # Pieces
        pieces_match = re.search(r"(?:Pieces|Pcs|Qty)[:\s]*(\d+)", pdf_text, re.IGNORECASE)
        if pieces_match:
            order.num_packages = int(pieces_match.group(1))

        # Weight
        weight = _extract_weight(pdf_text)
        if weight:
            order.weight = weight

        # Dimensions
        dims_match = re.search(r"(?:Dim|Dimensions?)[:\s]*([\dx. ]+(?:in|IN|cm|CM)?)", pdf_text, re.IGNORECASE)
        if dims_match:
            order.dimensions = dims_match.group(1).strip()

        # Contact/customer name
        contact_match = re.search(r"(?:Contact|Attn|Attention)[:\s]*(.*?)(?:\n|$)", pdf_text, re.IGNORECASE)
        if contact_match:
            order.customer_name = _clean_text(contact_match.group(1))

        # Phone
        phone_match = re.search(r"(?:Phone|Tel|Ph)[:\s]*([\d\-+() .]+)", pdf_text, re.IGNORECASE)
        if phone_match:
            order.pickup_phone = _clean_text(phone_match.group(1))

        # Build notes from any additional reference info
        notes_parts = []
        ref_match = re.search(r"(?:Reference|Ref|AWB|Waybill)[:\s#]*(.*?)(?:\n|$)", pdf_text, re.IGNORECASE)
        if ref_match:
            notes_parts.append(_clean_text(ref_match.group(1)))

        special_match = re.search(r"(?:Special Instructions|Instructions|Notes)[:\s]*(.*?)(?:\n\n|$)", pdf_text, re.IGNORECASE | re.DOTALL)
        if special_match:
            notes_parts.append(_clean_text(special_match.group(1)))

        order.notes = " | ".join(notes_parts)

    def _parse_address_block(self, order: ParsedOrder, block: str, prefix: str):
        """Parse a multi-line address block."""
        lines = [l.strip() for l in block.strip().split("\n") if l.strip()]
        if not lines:
            return

        # Try to find the street line (usually contains a number)
        street = ""
        city_state_zip = ""

        for i, line in enumerate(lines):
            # Skip location/company name (first line usually)
            if i == 0 and not re.match(r"^\d", line):
                if prefix == "pick_up":
                    order.customer_name = order.customer_name or line
                continue

            # Street line (starts with number or contains common street words)
            if re.match(r"^\d", line) and not street:
                street = line
                continue

            # City, State Zip line
            addr = _parse_address_line(line)
            if addr["state"] and addr["zip"]:
                city_state_zip = line
                if prefix == "pick_up":
                    order.pick_up_street = street
                    order.pick_up_city = addr["city"]
                    order.pick_up_state = addr["state"]
                    order.pick_up_zip = addr["zip"]
                else:
                    order.delivery_street = street
                    order.delivery_city = addr["city"]
                    order.delivery_state = addr["state"]
                    order.delivery_zip = addr["zip"]
                break


# Parser registry
PARSERS = {
    "email-marken": MarkenEmailParser(),
    "email-airspace": AirspaceEmailParser(),
    "email-cap": CapLogisticsEmailParser(),
}


def get_parser(source: str) -> Optional[EmailParser]:
    """Get the appropriate parser for an email source."""
    return PARSERS.get(source)
