"""WebSocket Lambda handlers for $connect, $disconnect, and $default routes.

Deployed as a separate Lambda behind API Gateway WebSocket API.
Auth is validated via a token query string parameter on $connect.
"""

import json
import logging
import os
from urllib.parse import parse_qs

logger = logging.getLogger(__name__)

try:
    import jwt as pyjwt
    from jwt.exceptions import InvalidTokenError
except ImportError:  # pragma: no cover
    pyjwt = None
    InvalidTokenError = Exception

from ws_store import WsConnection, get_ws_connection_store


def _validate_token(token: str) -> dict:
    """Validate a JWT or dev-auth token and return user claims.

    Supports both Cognito JWT and dev-auth cookie-style tokens.
    Returns dict with 'sub', 'org_id', 'groups'.
    """
    if not token:
        return {}

    # Try dev-auth HMAC token first (simple base64-encoded JSON signed with HMAC)
    dev_auth_enabled = os.environ.get("ENABLE_UI_DEV_AUTH", "").strip().lower() in {"1", "true", "yes", "on"}
    if dev_auth_enabled:
        dev_secret = os.environ.get("DEV_AUTH_SECRET", "").strip()
        if dev_secret:
            try:
                import base64
                import hashlib
                import hmac

                parts = token.split(".")
                if len(parts) == 2:
                    payload_b64, sig_b64 = parts
                    padded = payload_b64 + "=" * ((4 - (len(payload_b64) % 4)) % 4)
                    payload_bytes = base64.urlsafe_b64decode(padded)
                    expected_sig = hmac.new(
                        dev_secret.encode("utf-8"), payload_bytes, hashlib.sha256
                    ).digest()
                    sig_padded = sig_b64 + "=" * ((4 - (len(sig_b64) % 4)) % 4)
                    actual_sig = base64.urlsafe_b64decode(sig_padded)
                    if hmac.compare_digest(expected_sig, actual_sig):
                        claims = json.loads(payload_bytes)
                        return {
                            "sub": claims.get("sub", ""),
                            "org_id": claims.get("org_id", ""),
                            "groups": claims.get("groups", []),
                        }
            except Exception:
                pass  # Fall through to JWT validation

    # Try Cognito JWT
    if pyjwt is None:
        logger.warning("PyJWT not available for token validation")
        return {}

    verify_signature = os.environ.get("JWT_VERIFY_SIGNATURE", "true").strip().lower() in {"1", "true", "yes", "on"}

    try:
        if not verify_signature:
            claims = pyjwt.decode(
                token,
                options={"verify_signature": False, "verify_aud": False, "verify_exp": False},
            )
        else:
            issuer = os.environ.get("COGNITO_ISSUER", "")
            if not issuer:
                logger.warning("COGNITO_ISSUER not set, cannot validate JWT")
                return {}
            jwks_url = f"{issuer.rstrip('/')}/.well-known/jwks.json"
            jwk_client = pyjwt.PyJWKClient(jwks_url)
            signing_key = jwk_client.get_signing_key_from_jwt(token)
            claims = pyjwt.decode(
                token,
                signing_key.key,
                algorithms=["RS256"],
                issuer=issuer,
                options={"require": ["exp", "iat", "sub"], "verify_aud": False},
            )

        # Extract org_id from Cognito custom attribute
        org_id = (
            claims.get("custom:org_id")
            or claims.get("org_id")
            or ""
        )
        groups = claims.get("cognito:groups", [])

        return {
            "sub": claims.get("sub", ""),
            "org_id": org_id,
            "groups": groups,
        }
    except Exception as e:
        logger.warning("Token validation failed: %s", e)
        return {}


def _on_connect(event, context):
    """Handle $connect: validate token, store connection."""
    connection_id = event["requestContext"]["connectionId"]

    # Extract token from query string
    qs = event.get("queryStringParameters") or {}
    token = qs.get("token", "")

    if not token:
        # Also check multiValueQueryStringParameters
        raw_qs = event.get("rawQueryString", "")
        if raw_qs:
            parsed = parse_qs(raw_qs)
            token = parsed.get("token", [""])[0]

    user = _validate_token(token)
    if not user or not user.get("org_id"):
        logger.warning("WebSocket connect rejected: invalid or missing token (connection=%s)", connection_id)
        return {"statusCode": 401, "body": "Unauthorized"}

    # Only allow Admin and Dispatcher roles
    groups = user.get("groups", [])
    if groups and not any(g in ("Admin", "Dispatcher") for g in groups):
        logger.warning("WebSocket connect rejected: insufficient role (connection=%s, groups=%s)", connection_id, groups)
        return {"statusCode": 403, "body": "Forbidden"}

    store = get_ws_connection_store()
    conn = WsConnection(
        connection_id=connection_id,
        org_id=user["org_id"],
        user_id=user.get("sub", ""),
    )
    store.put_connection(conn)

    logger.info("WebSocket connected: %s (org=%s, user=%s)", connection_id, conn.org_id, conn.user_id)
    return {"statusCode": 200, "body": "Connected"}


def _on_disconnect(event, context):
    """Handle $disconnect: remove connection from store."""
    connection_id = event["requestContext"]["connectionId"]

    store = get_ws_connection_store()
    store.delete_connection(connection_id)

    logger.info("WebSocket disconnected: %s", connection_id)
    return {"statusCode": 200, "body": "Disconnected"}


def _on_default(event, context):
    """Handle $default: heartbeat / ping-pong."""
    return {"statusCode": 200, "body": "ok"}


def handler(event, context):
    """Main WebSocket Lambda handler - routes by routeKey."""
    route_key = event.get("requestContext", {}).get("routeKey", "$default")

    if route_key == "$connect":
        return _on_connect(event, context)
    elif route_key == "$disconnect":
        return _on_disconnect(event, context)
    else:
        return _on_default(event, context)
