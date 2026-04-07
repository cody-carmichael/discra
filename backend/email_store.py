"""DynamoDB stores for email configuration and skipped emails."""

import logging
import os
from abc import ABC, abstractmethod
from datetime import datetime, timedelta, timezone
from typing import Dict, List, Optional, Tuple

try:
    import boto3
    from boto3.dynamodb.conditions import Attr, Key
except ImportError:  # pragma: no cover - boto3 available in Lambda
    boto3 = None
    Attr = None
    Key = None

try:
    from backend.schemas import EmailConfig, SkippedEmail
except ModuleNotFoundError:  # local run from backend/ directory
    from schemas import EmailConfig, SkippedEmail

logger = logging.getLogger(__name__)

SKIPPED_EMAIL_TTL_DAYS = 30


def utc_now() -> datetime:
    return datetime.now(timezone.utc)


# ---------------------------------------------------------------------------
# EmailConfigStore
# ---------------------------------------------------------------------------

class EmailConfigStore(ABC):
    @abstractmethod
    def get_config(self, org_id: str) -> Optional[EmailConfig]:
        raise NotImplementedError

    @abstractmethod
    def put_config(self, config: EmailConfig) -> EmailConfig:
        raise NotImplementedError

    @abstractmethod
    def delete_config(self, org_id: str) -> None:
        raise NotImplementedError

    @abstractmethod
    def list_connected_orgs(self) -> List[EmailConfig]:
        raise NotImplementedError

    @abstractmethod
    def update_poll_status(self, org_id: str, history_id: str, error: Optional[str] = None) -> None:
        raise NotImplementedError


class InMemoryEmailConfigStore(EmailConfigStore):
    def __init__(self):
        self.items: Dict[str, EmailConfig] = {}

    def get_config(self, org_id: str) -> Optional[EmailConfig]:
        return self.items.get(org_id)

    def put_config(self, config: EmailConfig) -> EmailConfig:
        self.items[config.org_id] = config
        return config

    def delete_config(self, org_id: str) -> None:
        self.items.pop(org_id, None)

    def list_connected_orgs(self) -> List[EmailConfig]:
        return [c for c in self.items.values() if c.email_connected]

    def update_poll_status(self, org_id: str, history_id: str, error: Optional[str] = None) -> None:
        config = self.items.get(org_id)
        if config:
            config.gmail_history_id = history_id
            config.last_poll_at = utc_now()
            config.last_error = error


class DynamoEmailConfigStore(EmailConfigStore):
    def __init__(self, table_name: str):
        if boto3 is None:
            raise RuntimeError("boto3 not available")
        self._table = boto3.resource("dynamodb").Table(table_name)

    def get_config(self, org_id: str) -> Optional[EmailConfig]:
        resp = self._table.get_item(Key={"org_id": org_id})
        item = resp.get("Item")
        if not item:
            return None
        return EmailConfig.model_validate(item)

    def put_config(self, config: EmailConfig) -> EmailConfig:
        self._table.put_item(Item=config.model_dump(mode="json"))
        return config

    def delete_config(self, org_id: str) -> None:
        self._table.delete_item(Key={"org_id": org_id})

    def list_connected_orgs(self) -> List[EmailConfig]:
        resp = self._table.scan(
            FilterExpression=Attr("email_connected").eq(True),
        )
        items = resp.get("Items", [])
        while resp.get("LastEvaluatedKey"):
            resp = self._table.scan(
                FilterExpression=Attr("email_connected").eq(True),
                ExclusiveStartKey=resp["LastEvaluatedKey"],
            )
            items.extend(resp.get("Items", []))
        return [EmailConfig.model_validate(item) for item in items]

    def update_poll_status(self, org_id: str, history_id: str, error: Optional[str] = None) -> None:
        update_expr = "SET gmail_history_id = :hid, last_poll_at = :now"
        expr_values: dict = {
            ":hid": history_id,
            ":now": utc_now().isoformat(),
        }
        if error:
            update_expr += ", last_error = :err"
            expr_values[":err"] = error
        else:
            update_expr += " REMOVE last_error"

        self._table.update_item(
            Key={"org_id": org_id},
            UpdateExpression=update_expr,
            ExpressionAttributeValues=expr_values,
        )


_IN_MEMORY_EMAIL_CONFIG_STORE = InMemoryEmailConfigStore()


def get_email_config_store() -> EmailConfigStore:
    table_name = (os.environ.get("EMAIL_CONFIG_TABLE") or "").strip()
    if not table_name:
        return _IN_MEMORY_EMAIL_CONFIG_STORE
    try:
        return DynamoEmailConfigStore(table_name=table_name)
    except Exception:
        return _IN_MEMORY_EMAIL_CONFIG_STORE


def reset_in_memory_email_config_store():
    _IN_MEMORY_EMAIL_CONFIG_STORE.items.clear()


# ---------------------------------------------------------------------------
# SkippedEmailStore
# ---------------------------------------------------------------------------

class SkippedEmailStore(ABC):
    @abstractmethod
    def put_skipped(self, record: SkippedEmail) -> SkippedEmail:
        raise NotImplementedError

    @abstractmethod
    def list_skipped(self, org_id: str, limit: int = 50) -> List[SkippedEmail]:
        raise NotImplementedError


class InMemorySkippedEmailStore(SkippedEmailStore):
    def __init__(self):
        self.items: Dict[Tuple[str, str], SkippedEmail] = {}

    def put_skipped(self, record: SkippedEmail) -> SkippedEmail:
        self.items[(record.org_id, record.email_message_id)] = record
        return record

    def list_skipped(self, org_id: str, limit: int = 50) -> List[SkippedEmail]:
        results = [r for r in self.items.values() if r.org_id == org_id]
        results.sort(key=lambda r: r.created_at, reverse=True)
        return results[:limit]


class DynamoSkippedEmailStore(SkippedEmailStore):
    def __init__(self, table_name: str):
        if boto3 is None:
            raise RuntimeError("boto3 not available")
        self._table = boto3.resource("dynamodb").Table(table_name)

    def put_skipped(self, record: SkippedEmail) -> SkippedEmail:
        if not record.expires_at_epoch:
            expires = utc_now() + timedelta(days=SKIPPED_EMAIL_TTL_DAYS)
            record.expires_at_epoch = int(expires.timestamp())
        self._table.put_item(Item=record.model_dump(mode="json"))
        return record

    def list_skipped(self, org_id: str, limit: int = 50) -> List[SkippedEmail]:
        resp = self._table.query(
            KeyConditionExpression=Key("org_id").eq(org_id),
            ScanIndexForward=False,
            Limit=limit,
        )
        return [SkippedEmail.model_validate(item) for item in resp.get("Items", [])]


_IN_MEMORY_SKIPPED_EMAIL_STORE = InMemorySkippedEmailStore()


def get_skipped_email_store() -> SkippedEmailStore:
    table_name = (os.environ.get("SKIPPED_EMAILS_TABLE") or "").strip()
    if not table_name:
        return _IN_MEMORY_SKIPPED_EMAIL_STORE
    try:
        return DynamoSkippedEmailStore(table_name=table_name)
    except Exception:
        return _IN_MEMORY_SKIPPED_EMAIL_STORE


def reset_in_memory_skipped_email_store():
    _IN_MEMORY_SKIPPED_EMAIL_STORE.items.clear()
