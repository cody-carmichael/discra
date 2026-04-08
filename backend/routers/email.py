"""REST endpoints for email integration: connect, disconnect, status, skipped emails, rules."""

import base64
import email as _email_stdlib
import os
import uuid
from datetime import datetime, timezone
from typing import List, Optional

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile, status
from pydantic import BaseModel, Field

try:
    from backend.auth import ROLE_ADMIN, ROLE_DISPATCHER, get_current_user, require_roles
    from backend.email_store import get_email_config_store, get_skipped_email_store
    from backend.email_parser import PARSERS
    from backend.gmail_client import exchange_auth_code
    from backend.schemas import EmailConfig, EmailRule
except ModuleNotFoundError:  # local run from backend/ directory
    from auth import ROLE_ADMIN, ROLE_DISPATCHER, get_current_user, require_roles
    from email_store import get_email_config_store, get_skipped_email_store
    from email_parser import PARSERS
    from gmail_client import exchange_auth_code
    from schemas import EmailConfig, EmailRule

router = APIRouter(prefix="/email", tags=["email"])


class EmailConnectRequest(BaseModel):
    code: str
    redirect_uri: str


class EmailConnectResponse(BaseModel):
    ok: bool
    email: str = ""


class EmailStatusResponse(BaseModel):
    connected: bool
    email: str = ""
    last_poll_at: str = ""
    last_error: str = ""


class SkippedEmailItem(BaseModel):
    email_message_id: str
    sender: str = ""
    subject: str = ""
    skip_reason: str = ""
    created_at: str = ""


class SkippedEmailsResponse(BaseModel):
    items: list = []


@router.post("/connect", response_model=EmailConnectResponse)
async def connect_email(
    body: EmailConnectRequest,
    user=Depends(require_roles([ROLE_ADMIN])),
    config_store=Depends(get_email_config_store),
):
    """Exchange a Google OAuth auth code for a refresh token and connect the org's email."""
    org_id = user["org_id"]

    client_id = os.environ.get("GOOGLE_OAUTH_CLIENT_ID", "")
    client_secret = os.environ.get("GOOGLE_OAUTH_CLIENT_SECRET", "")

    try:
        tokens = exchange_auth_code(
            code=body.code,
            redirect_uri=body.redirect_uri,
            client_id=client_id,
            client_secret=client_secret,
        )
    except Exception as e:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Failed to exchange auth code: {e}",
        )

    refresh_token = tokens.get("refresh_token", "")
    if not refresh_token:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="No refresh token received. Ensure access_type=offline and prompt=consent.",
        )

    email_address = tokens.get("email", "")

    config = EmailConfig(
        org_id=org_id,
        gmail_email=email_address,
        gmail_refresh_token=refresh_token,
        email_connected=True,
        connected_at=datetime.now(timezone.utc),
    )
    config_store.put_config(config)

    return EmailConnectResponse(ok=True, email=email_address)


@router.get("/status", response_model=EmailStatusResponse)
async def email_status(
    user=Depends(require_roles([ROLE_ADMIN, ROLE_DISPATCHER])),
    config_store=Depends(get_email_config_store),
):
    """Get the email connection status for the current org."""
    org_id = user["org_id"]
    config = config_store.get_config(org_id)

    if not config or not config.email_connected:
        return EmailStatusResponse(connected=False)

    return EmailStatusResponse(
        connected=True,
        email=config.gmail_email,
        last_poll_at=config.last_poll_at.isoformat() if config.last_poll_at else "",
        last_error=config.last_error or "",
    )


@router.get("/skipped", response_model=SkippedEmailsResponse)
async def list_skipped_emails(
    limit: int = 50,
    user=Depends(require_roles([ROLE_ADMIN, ROLE_DISPATCHER])),
    skipped_store=Depends(get_skipped_email_store),
):
    """List recently skipped (non-order) emails for the current org."""
    org_id = user["org_id"]
    records = skipped_store.list_skipped(org_id, limit=min(limit, 200))

    items = [
        SkippedEmailItem(
            email_message_id=r.email_message_id,
            sender=r.sender,
            subject=r.subject,
            skip_reason=r.skip_reason,
            created_at=r.created_at.isoformat() if r.created_at else "",
        )
        for r in records
    ]
    return SkippedEmailsResponse(items=items)


@router.post("/disconnect")
async def disconnect_email(
    user=Depends(require_roles([ROLE_ADMIN])),
    config_store=Depends(get_email_config_store),
):
    """Disconnect the org's email integration."""
    org_id = user["org_id"]
    config_store.delete_config(org_id)
    return {"ok": True}


# ── Email Classification Rules ────────────────────────────────────

_MAX_RULES = 50


class EmailRuleCreateRequest(BaseModel):
    name: str = Field(..., min_length=1, max_length=120)
    sender_pattern: str = Field(..., min_length=1, max_length=200)
    subject_pattern: str = Field(default="", max_length=200)
    parser_type: str = Field(..., min_length=1, max_length=40)
    enabled: bool = True


class EmailRuleUpdateRequest(BaseModel):
    name: Optional[str] = Field(default=None, min_length=1, max_length=120)
    sender_pattern: Optional[str] = Field(default=None, min_length=1, max_length=200)
    subject_pattern: Optional[str] = Field(default=None, max_length=200)
    parser_type: Optional[str] = Field(default=None, min_length=1, max_length=40)
    enabled: Optional[bool] = None


class EmailRuleResponse(BaseModel):
    rule_id: str
    name: str
    sender_pattern: str
    subject_pattern: str
    parser_type: str
    enabled: bool
    created_at: str
    updated_at: str


class EmailRulesListResponse(BaseModel):
    items: List[EmailRuleResponse]
    available_parsers: List[str]


def _utc_now() -> datetime:
    return datetime.now(timezone.utc)


def _rule_to_response(rule: EmailRule) -> EmailRuleResponse:
    return EmailRuleResponse(
        rule_id=rule.rule_id,
        name=rule.name,
        sender_pattern=rule.sender_pattern,
        subject_pattern=rule.subject_pattern,
        parser_type=rule.parser_type,
        enabled=rule.enabled,
        created_at=rule.created_at.isoformat(),
        updated_at=rule.updated_at.isoformat(),
    )


@router.get("/rules", response_model=EmailRulesListResponse)
async def list_email_rules(
    user=Depends(require_roles([ROLE_ADMIN])),
    config_store=Depends(get_email_config_store),
):
    """List custom classification rules for the org, plus available parser types."""
    org_id = user["org_id"]
    config = config_store.get_config(org_id)
    rules = config.email_rules if config else []
    return EmailRulesListResponse(
        items=[_rule_to_response(r) for r in rules],
        available_parsers=list(PARSERS.keys()),
    )


@router.post("/rules", response_model=EmailRuleResponse, status_code=status.HTTP_201_CREATED)
async def create_email_rule(
    body: EmailRuleCreateRequest,
    user=Depends(require_roles([ROLE_ADMIN])),
    config_store=Depends(get_email_config_store),
):
    """Create a new custom classification rule for the org."""
    org_id = user["org_id"]

    if "." not in body.sender_pattern and "@" not in body.sender_pattern:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="sender_pattern must contain '.' or '@' (e.g. 'example.com' or 'user@example.com')",
        )
    if body.parser_type not in PARSERS:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"parser_type '{body.parser_type}' is not valid. Choose from: {list(PARSERS.keys())}",
        )

    config = config_store.get_config(org_id)
    if not config:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="No email connected for this org",
        )
    if len(config.email_rules) >= _MAX_RULES:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=f"Maximum of {_MAX_RULES} rules per org reached",
        )

    now = _utc_now()
    rule = EmailRule(
        rule_id=str(uuid.uuid4()),
        name=body.name,
        sender_pattern=body.sender_pattern,
        subject_pattern=body.subject_pattern,
        parser_type=body.parser_type,
        enabled=body.enabled,
        created_at=now,
        updated_at=now,
    )
    config.email_rules.append(rule)
    config_store.put_config(config)
    return _rule_to_response(rule)


@router.put("/rules/{rule_id}", response_model=EmailRuleResponse)
async def update_email_rule(
    rule_id: str,
    body: EmailRuleUpdateRequest,
    user=Depends(require_roles([ROLE_ADMIN])),
    config_store=Depends(get_email_config_store),
):
    """Update an existing classification rule (partial update)."""
    org_id = user["org_id"]

    if body.parser_type is not None and body.parser_type not in PARSERS:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"parser_type '{body.parser_type}' is not valid. Choose from: {list(PARSERS.keys())}",
        )
    if body.sender_pattern is not None and "." not in body.sender_pattern and "@" not in body.sender_pattern:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="sender_pattern must contain '.' or '@'",
        )

    config = config_store.get_config(org_id)
    if not config:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="No email connected for this org")

    rule = next((r for r in config.email_rules if r.rule_id == rule_id), None)
    if not rule:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Rule not found")

    if body.name is not None:
        rule.name = body.name
    if body.sender_pattern is not None:
        rule.sender_pattern = body.sender_pattern
    if body.subject_pattern is not None:
        rule.subject_pattern = body.subject_pattern
    if body.parser_type is not None:
        rule.parser_type = body.parser_type
    if body.enabled is not None:
        rule.enabled = body.enabled
    rule.updated_at = _utc_now()

    config_store.put_config(config)
    return _rule_to_response(rule)


@router.delete("/rules/{rule_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_email_rule(
    rule_id: str,
    user=Depends(require_roles([ROLE_ADMIN])),
    config_store=Depends(get_email_config_store),
):
    """Delete a classification rule."""
    org_id = user["org_id"]
    config = config_store.get_config(org_id)
    if not config:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="No email connected for this org")

    original_count = len(config.email_rules)
    config.email_rules = [r for r in config.email_rules if r.rule_id != rule_id]
    if len(config.email_rules) == original_count:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Rule not found")

    config_store.put_config(config)
    return None


# ── AI Format Detection ───────────────────────────────────────────

_DETECT_PROMPT = """You are helping a logistics dispatcher configure an email integration.

The system supports three email formats. Your job is to read the provided email content
and determine which format it matches.

FORMAT OPTIONS:
1. "email-marken"
   - HTML table with columns: ORDER#, INFO, DELIVER TO, ROUTING
   - Contains "PICKUP FROM:" section with name/address/phone
   - Fields like "PCS/WT:", "DIMS:", "PICKUP START:", "PICKUP END:", "DELIVER BY:"
   - Subject typically contains "PICKUP ALERT #"

2. "email-airspace"
   - Structured sections with clear labels on their own lines:
     PICKUP ADDRESS, DELIVERY ADDRESS, PICKUP BY / PICKUP TIME,
     TENDER BY TIME / DELIVER BY, PICKUP CONTACT / DELIVERY CONTACT,
     TOTAL PIECES, TOTAL WEIGHT, AIR WAYBILLS, FLIGHT INFO
   - Subject typically contains "Tracking ID" and "Order #" and "Dispatch"

3. "email-cap"
   - The email body has minimal order detail
   - The actual order is in a PDF attachment
   - Subject typically contains "Agent Alert"

Respond with JSON only — no explanation, no markdown, just the object:
{
  "parser_type": "email-marken" | "email-airspace" | "email-cap" | "unknown",
  "confidence": "high" | "medium" | "low",
  "reason": "one sentence explaining what you found that led to this choice"
}"""


class DetectFormatResponse(BaseModel):
    parser_type: str
    confidence: str
    reason: str


def _extract_eml_text(raw_bytes: bytes) -> str:
    """Extract readable text from a raw .eml file."""
    msg = _email_stdlib.message_from_bytes(raw_bytes)
    parts = []
    subject = msg.get("Subject", "")
    if subject:
        parts.append(f"Subject: {subject}")
    sender = msg.get("From", "")
    if sender:
        parts.append(f"From: {sender}")

    for part in msg.walk():
        ct = part.get_content_type()
        if ct in ("text/plain", "text/html"):
            try:
                payload = part.get_payload(decode=True)
                if payload:
                    parts.append(payload.decode(part.get_content_charset() or "utf-8", errors="replace"))
            except Exception:
                pass
        elif part.get_filename():
            parts.append(f"[Attachment: {part.get_filename()}]")

    return "\n\n".join(parts)[:12000]  # cap at ~12k chars to stay within token budget


@router.post("/rules/detect-format", response_model=DetectFormatResponse)
async def detect_email_format(
    file: Optional[UploadFile] = File(default=None),
    text: Optional[str] = Form(default=None),
    user=Depends(require_roles([ROLE_ADMIN])),
):
    """
    Use Claude to classify an email's format from a screenshot, .eml file, or pasted text.
    Returns the best-matching parser_type, confidence, and a short reason.
    """
    api_key = os.environ.get("ANTHROPIC_API_KEY", "")
    if not api_key:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="AI format detection is not configured (missing ANTHROPIC_API_KEY)",
        )

    try:
        import anthropic
    except ImportError:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="anthropic package not available",
        )

    if not file and not text:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Provide either a file upload or pasted text",
        )

    client = anthropic.Anthropic(api_key=api_key)
    messages: list = []

    if file:
        raw = await file.read()
        filename = (file.filename or "").lower()
        content_type = (file.content_type or "").lower()

        is_image = content_type.startswith("image/") or any(
            filename.endswith(ext) for ext in (".png", ".jpg", ".jpeg", ".gif", ".webp")
        )
        is_eml = filename.endswith(".eml") or content_type in ("message/rfc822", "application/octet-stream")

        if is_image:
            # Vision: send image to Claude
            media_type = content_type if content_type.startswith("image/") else "image/png"
            messages = [
                {
                    "role": "user",
                    "content": [
                        {
                            "type": "image",
                            "source": {
                                "type": "base64",
                                "media_type": media_type,
                                "data": base64.standard_b64encode(raw).decode(),
                            },
                        },
                        {
                            "type": "text",
                            "text": "This is a screenshot of a dispatch email. " + _DETECT_PROMPT,
                        },
                    ],
                }
            ]
        elif is_eml:
            email_text = _extract_eml_text(raw)
            messages = [{"role": "user", "content": f"Email content:\n\n{email_text}\n\n{_DETECT_PROMPT}"}]
        else:
            # Unknown file type — try treating as text
            try:
                email_text = raw.decode("utf-8", errors="replace")[:12000]
            except Exception:
                raise HTTPException(status_code=400, detail="Could not read file. Upload a PNG/JPG screenshot or .eml file.")
            messages = [{"role": "user", "content": f"Email content:\n\n{email_text}\n\n{_DETECT_PROMPT}"}]
    else:
        messages = [{"role": "user", "content": f"Email content:\n\n{text[:12000]}\n\n{_DETECT_PROMPT}"}]

    try:
        response = client.messages.create(
            model="claude-haiku-4-5",
            max_tokens=256,
            messages=messages,
        )
        raw_text = response.content[0].text.strip()
        # Strip markdown code fences if present
        if raw_text.startswith("```"):
            raw_text = raw_text.split("```")[1]
            if raw_text.startswith("json"):
                raw_text = raw_text[4:]
        import json
        result = json.loads(raw_text)
    except Exception as e:
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail=f"AI classification failed: {e}",
        )

    parser_type = result.get("parser_type", "unknown")
    # Validate — if AI returned something not in our list, mark as unknown
    if parser_type not in list(PARSERS.keys()) + ["unknown"]:
        parser_type = "unknown"

    return DetectFormatResponse(
        parser_type=parser_type,
        confidence=result.get("confidence", "low"),
        reason=result.get("reason", ""),
    )
