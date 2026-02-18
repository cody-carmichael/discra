import os
from abc import ABC, abstractmethod
from datetime import datetime, timezone
from typing import Dict, List, Optional, Tuple

try:
    import boto3
    from boto3.dynamodb.conditions import Key
except ImportError:  # pragma: no cover - boto3 available in Lambda
    boto3 = None
    Key = None

try:
    from backend.schemas import AuditLogRecord
except ModuleNotFoundError:  # local run from backend/ directory
    from schemas import AuditLogRecord


def _as_bool(value: Optional[str], default: bool = False) -> bool:
    if value is None:
        return default
    return value.strip().lower() in {"1", "true", "yes", "on"}


class AuditLogStore(ABC):
    @abstractmethod
    def put_event(self, event: AuditLogRecord) -> AuditLogRecord:
        raise NotImplementedError

    @abstractmethod
    def list_events(self, org_id: str, limit: int = 100) -> List[AuditLogRecord]:
        raise NotImplementedError


class InMemoryAuditLogStore(AuditLogStore):
    def __init__(self):
        self.items: Dict[Tuple[str, str], AuditLogRecord] = {}

    def put_event(self, event: AuditLogRecord) -> AuditLogRecord:
        self.items[(event.org_id, event.event_id)] = event
        return event

    def list_events(self, org_id: str, limit: int = 100) -> List[AuditLogRecord]:
        events = [event for (item_org_id, _), event in self.items.items() if item_org_id == org_id]
        events.sort(key=lambda item: item.created_at, reverse=True)
        return events[: max(limit, 0)]


class DynamoAuditLogStore(AuditLogStore):
    def __init__(self, table_name: str):
        if boto3 is None:
            raise RuntimeError("boto3 not available")
        self._table = boto3.resource("dynamodb").Table(table_name)

    def put_event(self, event: AuditLogRecord) -> AuditLogRecord:
        self._table.put_item(Item=event.model_dump(mode="json"))
        return event

    def list_events(self, org_id: str, limit: int = 100) -> List[AuditLogRecord]:
        safe_limit = max(min(limit, 500), 1)
        response = self._table.query(
            KeyConditionExpression=Key("org_id").eq(org_id),
            ScanIndexForward=False,
            Limit=safe_limit,
        )
        return [AuditLogRecord.model_validate(item) for item in response.get("Items", [])]


_IN_MEMORY_AUDIT_LOG_STORE = InMemoryAuditLogStore()


def get_audit_log_store() -> AuditLogStore:
    force_memory = _as_bool(os.environ.get("USE_IN_MEMORY_AUDIT_LOG_STORE"), default=False)
    if force_memory:
        return _IN_MEMORY_AUDIT_LOG_STORE

    table_name = (os.environ.get("AUDIT_LOGS_TABLE") or "").strip()
    if not table_name:
        return _IN_MEMORY_AUDIT_LOG_STORE

    try:
        return DynamoAuditLogStore(table_name=table_name)
    except Exception:
        return _IN_MEMORY_AUDIT_LOG_STORE


def reset_in_memory_audit_log_store():
    _IN_MEMORY_AUDIT_LOG_STORE.items.clear()


def new_event_id(now: Optional[datetime] = None) -> str:
    event_time = now or datetime.now(timezone.utc)
    millis = int(event_time.timestamp() * 1000)
    # Prefix event ID with epoch millis so sort order follows creation time.
    return f"{millis:013d}#{os.urandom(8).hex()}"
