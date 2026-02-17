import json
import os
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


def _as_bool(value: Optional[str], default: bool = False) -> bool:
    if value is None:
        return default
    return value.strip().lower() in {"1", "true", "yes", "on"}


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


def _claims_to_user(claims: Dict[str, Any]) -> Dict[str, Any]:
    groups = _normalize_groups(claims.get("cognito:groups") or claims.get("groups"))
    org_id = _extract_org_id(claims)
    if not org_id:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Missing org_id claim")

    sub = claims.get("sub") or claims.get("username")
    if not sub:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Missing sub claim")

    return {
        "sub": sub,
        "username": claims.get("cognito:username") or claims.get("username"),
        "email": claims.get("email"),
        "org_id": org_id,
        "groups": groups,
        "claims": claims,
    }


async def get_current_user(request: Request) -> Dict[str, Any]:
    claims = _extract_claims_from_request_context(request)
    if claims is None:
        token = _get_bearer_token(request)
        if not token:
            raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Missing Authorization header")
        claims = _decode_jwt(token)
    return _claims_to_user(claims)


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
