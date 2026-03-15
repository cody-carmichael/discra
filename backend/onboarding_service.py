import base64
import hashlib
import hmac
import json
import os
import re
from abc import ABC, abstractmethod
from datetime import datetime, timedelta, timezone
from typing import Dict, Iterable, List, Optional, Tuple
from urllib.parse import quote

try:
    import boto3
    from boto3.dynamodb.conditions import Key
except ImportError:  # pragma: no cover - boto3 available in Lambda runtime
    boto3 = None
    Key = None

try:
    from backend.schemas import OnboardingRegistrationRecord, OnboardingRegistrationStatus
except ModuleNotFoundError:  # local run from backend/ directory
    from schemas import OnboardingRegistrationRecord, OnboardingRegistrationStatus


def utc_now() -> datetime:
    return datetime.now(timezone.utc)


def _base64url_encode(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).decode("utf-8").rstrip("=")


def _base64url_decode(encoded: str) -> bytes:
    padded = encoded + "=" * ((4 - (len(encoded) % 4)) % 4)
    return base64.urlsafe_b64decode(padded.encode("utf-8"))


def _as_bool(value: Optional[str], default: bool = False) -> bool:
    if value is None:
        return default
    return value.strip().lower() in {"1", "true", "yes", "on"}


def _as_int(value: Optional[str], default: int) -> int:
    if value is None:
        return default
    try:
        return int(value)
    except ValueError:
        return default


def _clean_optional_text(value: Optional[str]) -> Optional[str]:
    if value is None:
        return None
    text = value.strip()
    return text or None


def registration_id_for_identity(identity_sub: str) -> str:
    digest = hashlib.sha256(identity_sub.encode("utf-8")).hexdigest()
    return f"reg-{digest[:20]}"


def generate_org_id(tenant_name: str, registration_id: str) -> str:
    normalized = re.sub(r"[^a-z0-9]+", "-", tenant_name.lower()).strip("-")
    prefix = normalized[:24] or "tenant"
    suffix = registration_id.replace("reg-", "")[:8]
    return f"org-{prefix}-{suffix}"


def onboarding_review_signing_secret() -> str:
    explicit = (os.environ.get("ONBOARDING_LINK_SIGNING_SECRET") or "").strip()
    if explicit:
        return explicit
    fallback = (os.environ.get("DEV_AUTH_SECRET") or "").strip()
    return fallback


def onboarding_link_ttl_seconds() -> int:
    raw = (os.environ.get("ONBOARDING_LINK_TTL_SECONDS") or "").strip()
    parsed = _as_int(raw, default=172800)
    return max(300, min(parsed, 1209600))


def onboarding_cognito_org_attribute_key() -> str:
    value = (os.environ.get("ONBOARDING_COGNITO_ORG_ATTRIBUTE_KEY") or "").strip()
    return value or "custom:org_id"


def onboarding_approver_allowlist() -> set[str]:
    raw = (os.environ.get("ONBOARDING_APPROVER_EMAIL_ALLOWLIST") or "").strip()
    if not raw:
        return set()
    pieces = re.split(r"[,;\s]+", raw)
    return {piece.lower() for piece in pieces if piece and "@" in piece}


def onboarding_review_url_base() -> str:
    return (os.environ.get("ONBOARDING_APP_REVIEW_URL_BASE") or "").strip()


def onboarding_register_url_base() -> str:
    explicit = (os.environ.get("ONBOARDING_APP_REGISTER_URL_BASE") or "").strip()
    if explicit:
        return explicit
    review_base = onboarding_review_url_base()
    if review_base.endswith("/review"):
        return review_base[:-7] + "/register"
    return review_base


def _optional_userpool_id() -> str:
    return (os.environ.get("COGNITO_USER_POOL_ID") or "").strip()


def _optional_frontend_cognito_domain() -> str:
    return (os.environ.get("COGNITO_HOSTED_UI_DOMAIN") or "").strip()


def _optional_frontend_cognito_client_id() -> str:
    client_id = (os.environ.get("FRONTEND_COGNITO_CLIENT_ID") or "").strip()
    if client_id:
        return client_id
    return (os.environ.get("COGNITO_AUDIENCE") or "").strip()


def build_hosted_ui_login_link() -> str:
    domain = _optional_frontend_cognito_domain().replace("https://", "").replace("http://", "").strip("/")
    client_id = _optional_frontend_cognito_client_id()
    redirect_uri = onboarding_register_url_base()
    if not domain or not client_id or not redirect_uri:
        return ""
    return (
        f"https://{domain}/oauth2/authorize"
        f"?client_id={quote(client_id)}"
        "&response_type=code"
        "&scope=openid+email+profile"
        f"&redirect_uri={quote(redirect_uri, safe='')}"
    )


def build_review_link(review_token: str) -> str:
    base = onboarding_review_url_base()
    if not base:
        return ""
    separator = "&" if "?" in base else "?"
    return f"{base}{separator}token={quote(review_token, safe='')}"


class ReviewTokenError(ValueError):
    pass


def issue_review_token(registration_id: str, now: Optional[datetime] = None) -> Tuple[str, datetime]:
    secret = onboarding_review_signing_secret()
    if not secret:
        raise RuntimeError("ONBOARDING_LINK_SIGNING_SECRET is not configured")
    issued_at = now or utc_now()
    expires_at = issued_at + timedelta(seconds=onboarding_link_ttl_seconds())
    payload = {
        "registration_id": registration_id,
        "iat": int(issued_at.timestamp()),
        "exp": int(expires_at.timestamp()),
    }
    encoded_payload = _base64url_encode(json.dumps(payload, separators=(",", ":")).encode("utf-8"))
    signature = hmac.new(
        secret.encode("utf-8"),
        encoded_payload.encode("utf-8"),
        digestmod=hashlib.sha256,
    ).hexdigest()
    return f"{encoded_payload}.{signature}", expires_at


def resolve_review_token(raw_token: str, now: Optional[datetime] = None) -> Tuple[str, datetime, datetime]:
    token = (raw_token or "").strip()
    if not token or "." not in token:
        raise ReviewTokenError("Invalid review token format")
    encoded_payload, provided_signature = token.rsplit(".", 1)
    if not encoded_payload or not provided_signature:
        raise ReviewTokenError("Invalid review token format")

    secret = onboarding_review_signing_secret()
    if not secret:
        raise ReviewTokenError("Review token signing is not configured")
    expected_signature = hmac.new(
        secret.encode("utf-8"),
        encoded_payload.encode("utf-8"),
        digestmod=hashlib.sha256,
    ).hexdigest()
    if not hmac.compare_digest(provided_signature, expected_signature):
        raise ReviewTokenError("Invalid review token signature")

    try:
        payload = json.loads(_base64url_decode(encoded_payload).decode("utf-8"))
    except Exception as exc:  # pragma: no cover - malformed payload branch
        raise ReviewTokenError("Invalid review token payload") from exc

    if not isinstance(payload, dict):
        raise ReviewTokenError("Invalid review token payload")
    registration_id = str(payload.get("registration_id") or "").strip()
    if not registration_id:
        raise ReviewTokenError("Invalid review token registration id")

    try:
        issued_at = datetime.fromtimestamp(int(payload.get("iat")), tz=timezone.utc)
    except Exception as exc:
        raise ReviewTokenError("Invalid review token issue timestamp") from exc

    try:
        expires_at = datetime.fromtimestamp(int(payload.get("exp")), tz=timezone.utc)
    except Exception as exc:
        raise ReviewTokenError("Invalid review token expiry") from exc

    now_value = now or utc_now()
    if expires_at < now_value:
        raise ReviewTokenError("Review token has expired")

    if issued_at > now_value + timedelta(minutes=5):
        raise ReviewTokenError("Invalid review token issue timestamp")

    return registration_id, issued_at, expires_at


class OnboardingRepository(ABC):
    @abstractmethod
    def get_registration(self, registration_id: str) -> Optional[OnboardingRegistrationRecord]:
        raise NotImplementedError

    @abstractmethod
    def get_registration_for_identity(self, identity_sub: str) -> Optional[OnboardingRegistrationRecord]:
        raise NotImplementedError

    @abstractmethod
    def upsert_registration(self, registration: OnboardingRegistrationRecord) -> OnboardingRegistrationRecord:
        raise NotImplementedError

    @abstractmethod
    def list_by_status(
        self,
        status: OnboardingRegistrationStatus,
        *,
        limit: int = 100,
    ) -> List[OnboardingRegistrationRecord]:
        raise NotImplementedError


class InMemoryOnboardingRepository(OnboardingRepository):
    def __init__(self):
        self._items: Dict[str, OnboardingRegistrationRecord] = {}

    def get_registration(self, registration_id: str) -> Optional[OnboardingRegistrationRecord]:
        return self._items.get(registration_id)

    def get_registration_for_identity(self, identity_sub: str) -> Optional[OnboardingRegistrationRecord]:
        return self.get_registration(registration_id_for_identity(identity_sub))

    def upsert_registration(self, registration: OnboardingRegistrationRecord) -> OnboardingRegistrationRecord:
        self._items[registration.registration_id] = registration
        return registration

    def list_by_status(
        self,
        status: OnboardingRegistrationStatus,
        *,
        limit: int = 100,
    ) -> List[OnboardingRegistrationRecord]:
        filtered = [item for item in self._items.values() if item.status == status]
        filtered.sort(key=lambda item: item.updated_at, reverse=True)
        return filtered[: max(limit, 0)]


class DynamoOnboardingRepository(OnboardingRepository):
    def __init__(self, table_name: str, status_index_name: str):
        if boto3 is None:
            raise RuntimeError("boto3 not available")
        self._table = boto3.resource("dynamodb").Table(table_name)
        self._status_index_name = status_index_name

    def _to_item(self, registration: OnboardingRegistrationRecord) -> Dict[str, object]:
        item = registration.model_dump(mode="json")
        item["updated_at_epoch"] = int(registration.updated_at.timestamp())
        return item

    def _from_item(self, item: Dict[str, object]) -> OnboardingRegistrationRecord:
        return OnboardingRegistrationRecord.model_validate(item)

    def get_registration(self, registration_id: str) -> Optional[OnboardingRegistrationRecord]:
        item = self._table.get_item(Key={"registration_id": registration_id}).get("Item")
        if not item:
            return None
        return self._from_item(item)

    def get_registration_for_identity(self, identity_sub: str) -> Optional[OnboardingRegistrationRecord]:
        return self.get_registration(registration_id_for_identity(identity_sub))

    def upsert_registration(self, registration: OnboardingRegistrationRecord) -> OnboardingRegistrationRecord:
        self._table.put_item(Item=self._to_item(registration))
        return registration

    def list_by_status(
        self,
        status: OnboardingRegistrationStatus,
        *,
        limit: int = 100,
    ) -> List[OnboardingRegistrationRecord]:
        safe_limit = max(1, min(limit, 500))
        response = self._table.query(
            IndexName=self._status_index_name,
            KeyConditionExpression=Key("status").eq(status.value),
            ScanIndexForward=False,
            Limit=safe_limit,
        )
        items = list(response.get("Items", []))
        while "LastEvaluatedKey" in response and len(items) < safe_limit:
            response = self._table.query(
                IndexName=self._status_index_name,
                KeyConditionExpression=Key("status").eq(status.value),
                ScanIndexForward=False,
                Limit=safe_limit - len(items),
                ExclusiveStartKey=response["LastEvaluatedKey"],
            )
            items.extend(response.get("Items", []))
        return [self._from_item(item) for item in items[:safe_limit]]


_IN_MEMORY_ONBOARDING_REPOSITORY = InMemoryOnboardingRepository()


def reset_in_memory_onboarding_repository():
    _IN_MEMORY_ONBOARDING_REPOSITORY._items.clear()


def get_onboarding_repository() -> OnboardingRepository:
    force_memory = _as_bool(os.environ.get("USE_IN_MEMORY_ONBOARDING_STORE"), default=False)
    if force_memory:
        return _IN_MEMORY_ONBOARDING_REPOSITORY

    table_name = (os.environ.get("ONBOARDING_REGISTRATIONS_TABLE") or "").strip()
    status_index = (os.environ.get("ONBOARDING_REGISTRATIONS_STATUS_INDEX") or "").strip() or "registrations_by_status"
    if not table_name:
        return _IN_MEMORY_ONBOARDING_REPOSITORY

    try:
        return DynamoOnboardingRepository(table_name=table_name, status_index_name=status_index)
    except Exception:
        return _IN_MEMORY_ONBOARDING_REPOSITORY


class OnboardingCognitoAdminClient(ABC):
    @abstractmethod
    def ensure_admin_access(self, *, username: str, org_id: str, role_name: str = "Admin") -> None:
        raise NotImplementedError


class DisabledOnboardingCognitoAdminClient(OnboardingCognitoAdminClient):
    def ensure_admin_access(self, *, username: str, org_id: str, role_name: str = "Admin") -> None:
        del username, org_id, role_name
        return


class AwsOnboardingCognitoAdminClient(OnboardingCognitoAdminClient):
    def __init__(self, *, user_pool_id: str):
        if boto3 is None:
            raise RuntimeError("boto3 not available")
        self._client = boto3.client("cognito-idp")
        self._user_pool_id = user_pool_id

    def ensure_admin_access(self, *, username: str, org_id: str, role_name: str = "Admin") -> None:
        attr_key = onboarding_cognito_org_attribute_key()
        self._client.admin_add_user_to_group(
            UserPoolId=self._user_pool_id,
            Username=username,
            GroupName=role_name,
        )
        self._client.admin_update_user_attributes(
            UserPoolId=self._user_pool_id,
            Username=username,
            UserAttributes=[
                {
                    "Name": attr_key,
                    "Value": org_id,
                }
            ],
        )


def get_onboarding_cognito_admin_client() -> OnboardingCognitoAdminClient:
    user_pool_id = _optional_userpool_id()
    if not user_pool_id:
        return DisabledOnboardingCognitoAdminClient()
    try:
        return AwsOnboardingCognitoAdminClient(user_pool_id=user_pool_id)
    except Exception:
        return DisabledOnboardingCognitoAdminClient()


class OnboardingNotifier(ABC):
    @abstractmethod
    def send_email(
        self,
        *,
        to_addresses: Iterable[str],
        subject: str,
        text_body: str,
    ) -> None:
        raise NotImplementedError


class LoggingOnboardingNotifier(OnboardingNotifier):
    def send_email(
        self,
        *,
        to_addresses: Iterable[str],
        subject: str,
        text_body: str,
    ) -> None:
        del to_addresses, subject, text_body
        return


class SesOnboardingNotifier(OnboardingNotifier):
    def __init__(self, *, source_email: str):
        if boto3 is None:
            raise RuntimeError("boto3 not available")
        self._client = boto3.client("ses")
        self._source_email = source_email

    def send_email(
        self,
        *,
        to_addresses: Iterable[str],
        subject: str,
        text_body: str,
    ) -> None:
        recipients = [address for address in to_addresses if address]
        if not recipients:
            return
        self._client.send_email(
            Source=self._source_email,
            Destination={"ToAddresses": recipients},
            Message={
                "Subject": {"Data": subject},
                "Body": {"Text": {"Data": text_body}},
            },
        )


def get_onboarding_notifier() -> OnboardingNotifier:
    source_email = _clean_optional_text(os.environ.get("ONBOARDING_SES_FROM_EMAIL"))
    if not source_email:
        return LoggingOnboardingNotifier()
    try:
        return SesOnboardingNotifier(source_email=source_email)
    except Exception:
        return LoggingOnboardingNotifier()
