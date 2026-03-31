"""REST endpoints for email integration: connect, disconnect, status, skipped emails."""

import os
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel

try:
    from backend.auth import ROLE_ADMIN, ROLE_DISPATCHER, get_current_user, require_roles
    from backend.email_store import get_email_config_store, get_skipped_email_store
    from backend.gmail_client import exchange_auth_code
    from backend.schemas import EmailConfig
except ModuleNotFoundError:  # local run from backend/ directory
    from auth import ROLE_ADMIN, ROLE_DISPATCHER, get_current_user, require_roles
    from email_store import get_email_config_store, get_skipped_email_store
    from gmail_client import exchange_auth_code
    from schemas import EmailConfig

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
