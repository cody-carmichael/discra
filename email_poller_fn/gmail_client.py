"""Gmail API client for fetching emails via OAuth2.

Handles token refresh, incremental history sync, message fetching,
and attachment downloading.
"""

import base64
import logging
import os
from dataclasses import dataclass, field
from typing import Dict, List, Optional, Tuple

logger = logging.getLogger(__name__)

try:
    from google.auth.transport.requests import Request as GoogleAuthRequest
    from google.auth.exceptions import RefreshError as _GoogleRefreshError
    from google.oauth2.credentials import Credentials
    from googleapiclient.discovery import build
except ImportError:  # pragma: no cover
    GoogleAuthRequest = None
    _GoogleRefreshError = Exception
    Credentials = None
    build = None

GMAIL_SCOPES = ["https://www.googleapis.com/auth/gmail.modify"]
TOKEN_URI = "https://oauth2.googleapis.com/token"

# Substrings Google returns inside RefreshError messages for hard auth failures
# that mean "the refresh token is no longer usable". We translate any of these
# into a structured GmailAuthError so callers can surface a friendly reauth
# prompt instead of treating it as a transient error.
_HARD_AUTH_ERROR_CODES = (
    "invalid_grant",
    "invalid_client",
    "unauthorized_client",
    "invalid_token",
)


class GmailAuthError(Exception):
    """The user's Gmail OAuth credentials can no longer be refreshed.

    Caller should mark the connection as needing reauth and stop polling
    until the user re-consents via the OAuth flow.
    """

    def __init__(self, code: str, message: str = ""):
        super().__init__(message or code)
        self.code = code


def _classify_refresh_error(err: Exception) -> Optional[str]:
    """Return the matched hard-auth code if `err` is a hard refresh failure, else None."""
    text = str(err).lower()
    for code in _HARD_AUTH_ERROR_CODES:
        if code in text:
            return code
    return None


@dataclass
class GmailAttachment:
    filename: str
    mime_type: str
    data: bytes


@dataclass
class GmailMessage:
    message_id: str
    thread_id: str
    subject: str = ""
    sender: str = ""
    date: str = ""
    html_body: str = ""
    text_body: str = ""
    attachments: List[GmailAttachment] = field(default_factory=list)


class GmailClient:
    """Wraps the Gmail API for fetching new messages incrementally."""

    def __init__(self, refresh_token: str, client_id: str = "", client_secret: str = ""):
        if Credentials is None:
            raise RuntimeError("google-auth and google-api-python-client must be installed")

        self._client_id = client_id or os.environ.get("GOOGLE_OAUTH_CLIENT_ID", "")
        self._client_secret = client_secret or os.environ.get("GOOGLE_OAUTH_CLIENT_SECRET", "")
        self._refresh_token = refresh_token
        self._service = None

    def _get_service(self):
        if self._service is not None:
            return self._service

        creds = Credentials(
            token=None,
            refresh_token=self._refresh_token,
            token_uri=TOKEN_URI,
            client_id=self._client_id,
            client_secret=self._client_secret,
            scopes=GMAIL_SCOPES,
        )
        try:
            creds.refresh(GoogleAuthRequest())
        except _GoogleRefreshError as e:
            code = _classify_refresh_error(e) or "refresh_failed"
            raise GmailAuthError(code=code, message=str(e)) from e
        self._service = build("gmail", "v1", credentials=creds, cache_discovery=False)
        return self._service

    def get_history_id(self) -> str:
        """Get the current historyId from the user's profile."""
        service = self._get_service()
        profile = service.users().getProfile(userId="me").execute()
        return str(profile.get("historyId", ""))

    def list_new_message_ids(self, history_id: str) -> Tuple[List[str], str]:
        """Fetch message IDs added since the given historyId.

        Returns (list_of_message_ids, new_history_id).
        If the historyId is too old, falls back to listing recent messages.
        """
        service = self._get_service()
        message_ids = []
        new_history_id = history_id

        try:
            page_token = None
            while True:
                resp = (
                    service.users()
                    .history()
                    .list(
                        userId="me",
                        startHistoryId=history_id,
                        historyTypes=["messageAdded"],
                        pageToken=page_token,
                    )
                    .execute()
                )

                new_history_id = str(resp.get("historyId", history_id))

                for history_record in resp.get("history", []):
                    for msg_added in history_record.get("messagesAdded", []):
                        msg = msg_added.get("message", {})
                        msg_id = msg.get("id")
                        if msg_id:
                            message_ids.append(msg_id)

                page_token = resp.get("nextPageToken")
                if not page_token:
                    break

        except Exception as e:
            error_str = str(e)
            if "404" in error_str or "historyId" in error_str.lower():
                logger.warning("historyId %s is too old, falling back to messages.list", history_id)
                return self._list_recent_message_ids()
            raise

        return list(dict.fromkeys(message_ids)), new_history_id

    def _list_recent_message_ids(self) -> Tuple[List[str], str]:
        """Fallback: list the 20 most recent messages."""
        service = self._get_service()
        resp = service.users().messages().list(userId="me", maxResults=20).execute()
        messages = resp.get("messages", [])
        message_ids = [m["id"] for m in messages]
        new_history_id = self.get_history_id()
        return message_ids, new_history_id

    def get_message(self, message_id: str) -> GmailMessage:
        """Fetch a full message including body and attachment metadata."""
        service = self._get_service()
        msg = service.users().messages().get(userId="me", id=message_id, format="full").execute()

        headers = {h["name"].lower(): h["value"] for h in msg.get("payload", {}).get("headers", [])}
        subject = headers.get("subject", "")
        sender = headers.get("from", "")
        date = headers.get("date", "")

        html_body, text_body, attachments = self._extract_parts(service, message_id, msg.get("payload", {}))

        return GmailMessage(
            message_id=message_id,
            thread_id=msg.get("threadId", ""),
            subject=subject,
            sender=sender,
            date=date,
            html_body=html_body,
            text_body=text_body,
            attachments=attachments,
        )

    def _extract_parts(self, service, message_id: str, payload: dict) -> Tuple[str, str, List[GmailAttachment]]:
        """Recursively extract HTML body, text body, and attachments from message parts."""
        html_body = ""
        text_body = ""
        attachments = []

        mime_type = payload.get("mimeType", "")
        body = payload.get("body", {})
        parts = payload.get("parts", [])

        if not parts:
            data = body.get("data", "")
            attachment_id = body.get("attachmentId", "")

            if attachment_id:
                filename = payload.get("filename", "attachment")
                att_data = self._download_attachment(service, message_id, attachment_id)
                attachments.append(GmailAttachment(filename=filename, mime_type=mime_type, data=att_data))
            elif data:
                decoded = base64.urlsafe_b64decode(data)
                if mime_type == "text/html":
                    html_body = decoded.decode("utf-8", errors="replace")
                elif mime_type == "text/plain":
                    text_body = decoded.decode("utf-8", errors="replace")
        else:
            for part in parts:
                h, t, a = self._extract_parts(service, message_id, part)
                if h and not html_body:
                    html_body = h
                if t and not text_body:
                    text_body = t
                attachments.extend(a)

        return html_body, text_body, attachments

    def _download_attachment(self, service, message_id: str, attachment_id: str) -> bytes:
        """Download an attachment by its ID."""
        att = (
            service.users()
            .messages()
            .attachments()
            .get(userId="me", messageId=message_id, id=attachment_id)
            .execute()
        )
        data = att.get("data", "")
        return base64.urlsafe_b64decode(data)

    def add_label(self, message_id: str, label_name: str):
        """Add a label to a message. Creates the label if it doesn't exist."""
        service = self._get_service()
        label_id = self._get_or_create_label(service, label_name)
        if label_id:
            try:
                service.users().messages().modify(
                    userId="me",
                    id=message_id,
                    body={"addLabelIds": [label_id]},
                ).execute()
            except Exception as e:
                logger.warning("Failed to add label %s to message %s: %s", label_name, message_id, e)

    def _get_or_create_label(self, service, label_name: str) -> Optional[str]:
        """Get label ID by name, creating it if necessary."""
        try:
            labels_resp = service.users().labels().list(userId="me").execute()
            for label in labels_resp.get("labels", []):
                if label.get("name") == label_name:
                    return label.get("id")

            new_label = service.users().labels().create(
                userId="me",
                body={"name": label_name, "labelListVisibility": "labelShow", "messageListVisibility": "show"},
            ).execute()
            return new_label.get("id")
        except Exception as e:
            logger.warning("Failed to get/create label %s: %s", label_name, e)
            return None

    def has_label(self, message_id: str, label_name: str) -> bool:
        """Check if a message has a specific label."""
        service = self._get_service()
        try:
            msg = service.users().messages().get(userId="me", id=message_id, format="metadata").execute()
            label_ids = msg.get("labelIds", [])
            labels_resp = service.users().labels().list(userId="me").execute()
            for label in labels_resp.get("labels", []):
                if label.get("name") == label_name and label.get("id") in label_ids:
                    return True
        except Exception:
            pass
        return False


def exchange_auth_code(code: str, redirect_uri: str, client_id: str = "", client_secret: str = "") -> Dict:
    """Exchange an OAuth authorization code for tokens.

    Returns a dict with 'refresh_token', 'access_token', 'email'.
    """
    from google_auth_oauthlib.flow import Flow

    cid = client_id or os.environ.get("GOOGLE_OAUTH_CLIENT_ID", "")
    csecret = client_secret or os.environ.get("GOOGLE_OAUTH_CLIENT_SECRET", "")

    flow = Flow.from_client_config(
        {
            "web": {
                "client_id": cid,
                "client_secret": csecret,
                "auth_uri": "https://accounts.google.com/o/oauth2/auth",
                "token_uri": TOKEN_URI,
            }
        },
        scopes=GMAIL_SCOPES,
        redirect_uri=redirect_uri,
    )
    try:
        flow.fetch_token(code=code)
    except Exception as e:
        # Stale/already-used auth codes and revoked clients all surface as
        # OAuth errors here. Translate hard-auth failures so callers can
        # render a clear "please re-authorize" message.
        hard_code = _classify_refresh_error(e)
        if hard_code:
            raise GmailAuthError(code=hard_code, message=str(e)) from e
        raise
    creds = flow.credentials

    service = build("gmail", "v1", credentials=creds, cache_discovery=False)
    profile = service.users().getProfile(userId="me").execute()

    return {
        "refresh_token": creds.refresh_token or "",
        "access_token": creds.token or "",
        "email": profile.get("emailAddress", ""),
    }
