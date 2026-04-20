import base64
import hashlib
import hmac
import json
import os
import time
from functools import lru_cache
from typing import Any, Dict, List, Optional

import jwt
from fastapi import Depends, HTTPException, Request, status
from jwt import PyJWKClient
from jwt.exceptions import InvalidTokenError

ROLE_ADMIN = "Admin"
ROLE_DISPATCHER = "Dispatcher"
ROLE_DRIVER = "Driver"
ALLOWED_ROLES = {ROLE_ADMIN, ROLE_DISPATCHER, ROLE_DRIVER}
DEV_AUTH_COOKIE_NAME = "discra_dev_session"
WEB_AUTH_COOKIE_NAME = "discra_web_session"


def _as_bool(value: Optional[str], default: bool = False) -> bool:
    if value is None:
        return default
    return value.strip().lower() in {"1", "true", "yes", "on"}


def _base64url_encode(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).decode("utf-8").rstrip("=")


def _base64url_decode(encoded: str) -> bytes:
    padded = encoded + "=" * ((4 - (len(encoded) % 4)) % 4)
    return base64.urlsafe_b64decode(padded.encode("utf-8"))


def _canonical_role(role: Optional[str]) -> Optional[str]:
    if role is None:
        return None
    value = role.strip()
    for allowed in ALLOWED_ROLES:
        if allowed.lower() == value.lower():
            return allowed
    return None


def is_dev_auth_enabled() -> bool:
    return _as_bool(os.environ.get("ENABLE_UI_DEV_AUTH"), default=False)


def dev_auth_cookie_name() -> str:
    return DEV_AUTH_COOKIE_NAME


def web_auth_cookie_name() -> str:
    value = (os.environ.get("WEB_AUTH_COOKIE_NAME") or "").strip()
    return value or WEB_AUTH_COOKIE_NAME


def web_auth_ttl_seconds() -> int:
    raw_value = (os.environ.get("WEB_AUTH_TTL_SECONDS") or "").strip()
    if not raw_value:
        return 43200
    try:
        parsed = int(raw_value)
    except ValueError:
        return 43200
    return max(300, min(parsed, 604800))


def dev_auth_default_org_id() -> str:
    value = (os.environ.get("UI_DEV_AUTH_ORG_ID") or "").strip()
    return value or "org-pilot-1"


def dev_auth_ttl_seconds() -> int:
    raw_value = (os.environ.get("UI_DEV_AUTH_TTL_SECONDS") or "").strip()
    if not raw_value:
        return 43200
    try:
        parsed = int(raw_value)
    except ValueError:
        return 43200
    return max(300, min(parsed, 604800))


def normalize_dev_auth_role(role: Optional[str]) -> str:
    canonical = _canonical_role(role)
    if canonical is None:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Invalid dev-auth role '{role}'",
        )
    return canonical


def _dev_auth_secret() -> str:
    return (os.environ.get("DEV_AUTH_SECRET") or "").strip()


def _require_dev_auth_secret() -> str:
    secret = _dev_auth_secret()
    if not secret:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Dev auth is enabled but DEV_AUTH_SECRET is not configured",
        )
    return secret


def _new_dev_auth_claims(
    *,
    user_id: str,
    role: str,
    org_id: str,
    email: Optional[str] = None,
    ttl_seconds: Optional[int] = None,
) -> Dict[str, Any]:
    canonical_role = normalize_dev_auth_role(role)
    safe_user_id = (user_id or "").strip()
    if not safe_user_id:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="user_id is required")

    safe_org_id = (org_id or "").strip() or dev_auth_default_org_id()
    now_epoch = int(time.time())
    effective_ttl = ttl_seconds if ttl_seconds is not None else dev_auth_ttl_seconds()
    safe_ttl = max(60, min(effective_ttl, 604800))

    claims: Dict[str, Any] = {
        "sub": safe_user_id,
        "username": safe_user_id,
        "org_id": safe_org_id,
        "custom:org_id": safe_org_id,
        "groups": [canonical_role],
        "cognito:groups": [canonical_role],
        "iat": now_epoch,
        "exp": now_epoch + safe_ttl,
    }
    safe_email = (email or "").strip()
    if safe_email:
        claims["email"] = safe_email
    return claims


def build_dev_auth_session_value(
    *,
    user_id: str,
    role: str,
    org_id: str,
    email: Optional[str] = None,
    ttl_seconds: Optional[int] = None,
) -> str:
    claims = _new_dev_auth_claims(
        user_id=user_id,
        role=role,
        org_id=org_id,
        email=email,
        ttl_seconds=ttl_seconds,
    )
    claims_text = json.dumps(claims, separators=(",", ":"))
    encoded = _base64url_encode(claims_text.encode("utf-8"))
    signature = hmac.new(
        _require_dev_auth_secret().encode("utf-8"),
        encoded.encode("utf-8"),
        digestmod=hashlib.sha256,
    ).hexdigest()
    return f"{encoded}.{signature}"


def _decode_dev_auth_session_value(raw_value: str) -> Optional[Dict[str, Any]]:
    value = (raw_value or "").strip()
    if not value or "." not in value:
        return None
    encoded, provided_signature = value.rsplit(".", 1)
    if not encoded or not provided_signature:
        return None

    secret = _dev_auth_secret()
    if not secret:
        return None
    expected_signature = hmac.new(
        secret.encode("utf-8"),
        encoded.encode("utf-8"),
        digestmod=hashlib.sha256,
    ).hexdigest()
    if not hmac.compare_digest(provided_signature, expected_signature):
        return None

    try:
        payload = json.loads(_base64url_decode(encoded).decode("utf-8"))
    except Exception:
        return None

    if not isinstance(payload, dict):
        return None

    try:
        exp_epoch = int(payload.get("exp"))
    except (TypeError, ValueError):
        return None
    if exp_epoch < int(time.time()):
        return None
    return payload


@lru_cache(maxsize=8)
def _jwk_client(jwks_url: str) -> PyJWKClient:
    return PyJWKClient(jwks_url)


def _decode_jwt(token: str) -> Dict[str, Any]:
    verify_signature = _as_bool(os.environ.get("JWT_VERIFY_SIGNATURE"), default=True)
    if not verify_signature:
        try:
            return jwt.decode(
                token,
                options={
                    "verify_signature": False,
                    "verify_aud": False,
                    "verify_exp": False,
                },
            )
        except InvalidTokenError as exc:
            raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid token") from exc

    issuer = os.environ.get("COGNITO_ISSUER")
    audience = os.environ.get("COGNITO_AUDIENCE")
    if not issuer or not audience:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Auth misconfigured: missing COGNITO_ISSUER/COGNITO_AUDIENCE",
        )

    jwks_url = os.environ.get("COGNITO_JWKS_URL", f"{issuer.rstrip('/')}/.well-known/jwks.json")

    try:
        signing_key = _jwk_client(jwks_url).get_signing_key_from_jwt(token)
        claims = jwt.decode(
            token,
            signing_key.key,
            algorithms=["RS256"],
            issuer=issuer,
            options={"require": ["exp", "iat", "sub"], "verify_aud": False},
        )
        token_audience = claims.get("aud") or claims.get("client_id")
        if token_audience != audience:
            raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid token audience")
        return claims
    except InvalidTokenError as exc:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid token") from exc
    except Exception as exc:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Unable to validate token",
        ) from exc


def _get_bearer_token(request: Request) -> Optional[str]:
    auth_header = request.headers.get("authorization") or request.headers.get("Authorization")
    if not auth_header:
        return None
    parts = auth_header.split()
    if len(parts) != 2 or parts[0].lower() != "bearer":
        return None
    return parts[1]


def _get_web_auth_token(request: Request) -> Optional[str]:
    value = (request.cookies.get(web_auth_cookie_name()) or "").strip()
    if not value:
        return None
    return value


def _extract_claims_from_request_context(request: Request) -> Optional[Dict[str, Any]]:
    event = request.scope.get("aws.event")
    if not isinstance(event, dict):
        return None
    claims = (
        event.get("requestContext", {})
        .get("authorizer", {})
        .get("jwt", {})
        .get("claims")
    )
    if isinstance(claims, dict) and claims:
        return claims
    return None


def _extract_dev_auth_claims_from_headers(request: Request) -> Optional[Dict[str, Any]]:
    user_id = (request.headers.get("x-dev-user-id") or "").strip()
    role = (request.headers.get("x-dev-role") or "").strip()
    if not user_id and not role:
        return None
    if not user_id or not role:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid dev-auth headers",
        )

    org_id = (request.headers.get("x-dev-org-id") or "").strip() or dev_auth_default_org_id()
    email = (request.headers.get("x-dev-email") or "").strip() or None
    return _new_dev_auth_claims(
        user_id=user_id,
        role=role,
        org_id=org_id,
        email=email,
        ttl_seconds=3600,
    )


def _extract_dev_auth_claims(request: Request) -> Optional[Dict[str, Any]]:
    if not is_dev_auth_enabled():
        return None

    cookie_value = request.cookies.get(dev_auth_cookie_name())
    if cookie_value:
        decoded = _decode_dev_auth_session_value(cookie_value)
        if decoded is not None:
            return decoded

    return _extract_dev_auth_claims_from_headers(request)


def _normalize_groups(raw_groups: Any) -> List[str]:
    if raw_groups is None:
        return []
    if isinstance(raw_groups, list):
        return [str(group).strip() for group in raw_groups if str(group).strip()]
    if isinstance(raw_groups, str):
        value = raw_groups.strip()
        if not value:
            return []
        if value.startswith("[") and value.endswith("]"):
            try:
                parsed = json.loads(value)
                if isinstance(parsed, list):
                    return [str(group).strip() for group in parsed if str(group).strip()]
            except json.JSONDecodeError:
                pass
        return [group.strip() for group in value.split(",") if group.strip()]
    return []


def _extract_org_id(claims: Dict[str, Any]) -> Optional[str]:
    for key in ("custom:org_id", "org_id", "custom:tenant_id", "tenant_id"):
        value = claims.get(key)
        if isinstance(value, str) and value.strip():
            return value.strip()
    return None


def _claims_to_identity(claims: Dict[str, Any]) -> Dict[str, Any]:
    groups = _normalize_groups(claims.get("cognito:groups") or claims.get("groups"))
    sub = claims.get("sub") or claims.get("username")
    if not sub:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Missing sub claim")

    return {
        "sub": sub,
        "username": claims.get("cognito:username") or claims.get("username"),
        "email": claims.get("email"),
        "org_id": _extract_org_id(claims),
        "groups": groups,
        "claims": claims,
    }


def _claims_to_user(claims: Dict[str, Any]) -> Dict[str, Any]:
    identity = _claims_to_identity(claims)
    if not identity.get("org_id"):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Missing org_id claim. Ensure the Cognito user has the custom:org_id attribute set.",
        )
    return identity


def _resolve_claims(request: Request, *, allow_missing: bool = False) -> Optional[Dict[str, Any]]:
    claims = _extract_claims_from_request_context(request)
    if claims is None:
        claims = _extract_dev_auth_claims(request)
    if claims is not None:
        return claims

    bearer_token = _get_bearer_token(request)
    if bearer_token:
        return _decode_jwt(bearer_token)

    cookie_token = _get_web_auth_token(request)
    if cookie_token:
        return _decode_jwt(cookie_token)

    if allow_missing:
        return None
    raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Missing authentication session")


def get_dev_auth_user(request: Request) -> Optional[Dict[str, Any]]:
    claims = _extract_dev_auth_claims(request)
    if claims is None:
        return None
    return _claims_to_user(claims)


def _lookup_org_id_for_sub(user_id: str) -> Optional[str]:
    """Look up org_id from the UsersTable by user_id (Cognito sub)."""
    if not user_id:
        return None
    try:
        from backend.repositories import get_identity_repository
    except ModuleNotFoundError:
        from repositories import get_identity_repository
    try:
        repo = get_identity_repository()
        user_record = repo.find_user_by_sub(user_id)
        if user_record:
            return user_record.org_id
    except Exception:
        pass
    return None


async def get_current_user(request: Request) -> Dict[str, Any]:
    claims = _resolve_claims(request)
    identity = _claims_to_identity(claims)
    if not identity.get("org_id"):
        org_id = _lookup_org_id_for_sub(identity.get("sub", ""))
        if org_id:
            identity["org_id"] = org_id
        else:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="Missing org_id claim. Ensure the Cognito user has the custom:org_id attribute set.",
            )
    return identity


async def get_authenticated_identity(request: Request) -> Dict[str, Any]:
    claims = _resolve_claims(request)
    return _claims_to_identity(claims)


async def get_optional_authenticated_identity(request: Request) -> Optional[Dict[str, Any]]:
    claims = _resolve_claims(request, allow_missing=True)
    if claims is None:
        return None
    return _claims_to_identity(claims)


def validate_id_token(token: str) -> Dict[str, Any]:
    """Validate a Cognito ID token and return its claims. Raises HTTPException on failure."""
    return _decode_jwt(token)


def _normalized_role_set(roles: List[str]) -> set[str]:
    return {role.strip().lower() for role in roles if isinstance(role, str) and role.strip()}


def require_roles(allowed: List[str]):
    allowed_roles = _normalized_role_set(allowed)

    async def dep(user=Depends(get_current_user)):
        group_roles = _normalized_role_set(user.get("groups") or [])
        if not group_roles.intersection(allowed_roles):
            raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Forbidden: insufficient role")
        return user

    return dep
