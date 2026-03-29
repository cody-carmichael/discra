import json
import os
from abc import ABC, abstractmethod
from datetime import datetime, timedelta, timezone
from decimal import Decimal
from typing import Dict, Optional, Tuple

try:
    import boto3
except ImportError:  # pragma: no cover - boto3 available in Lambda
    boto3 = None

try:
    from backend.schemas import PushSubscriptionRecord
except ModuleNotFoundError:  # local run from backend/ directory
    from schemas import PushSubscriptionRecord


SUBSCRIPTION_TTL_DAYS = 30


def utc_now() -> datetime:
    return datetime.now(timezone.utc)


class PushSubscriptionStore(ABC):
    @abstractmethod
    def upsert_subscription(self, record: PushSubscriptionRecord) -> PushSubscriptionRecord:
        raise NotImplementedError

    @abstractmethod
    def get_subscription(self, org_id: str, driver_id: str) -> Optional[PushSubscriptionRecord]:
        raise NotImplementedError

    @abstractmethod
    def delete_subscription(self, org_id: str, driver_id: str) -> None:
        raise NotImplementedError


class InMemoryPushSubscriptionStore(PushSubscriptionStore):
    def __init__(self):
        self.items: Dict[Tuple[str, str], PushSubscriptionRecord] = {}

    def upsert_subscription(self, record: PushSubscriptionRecord) -> PushSubscriptionRecord:
        self.items[(record.org_id, record.driver_id)] = record
        return record

    def get_subscription(self, org_id: str, driver_id: str) -> Optional[PushSubscriptionRecord]:
        return self.items.get((org_id, driver_id))

    def delete_subscription(self, org_id: str, driver_id: str) -> None:
        self.items.pop((org_id, driver_id), None)


class DynamoPushSubscriptionStore(PushSubscriptionStore):
    def __init__(self, table_name: str):
        if boto3 is None:
            raise RuntimeError("boto3 not available")
        self.table = boto3.resource("dynamodb").Table(table_name)

    def upsert_subscription(self, record: PushSubscriptionRecord) -> PushSubscriptionRecord:
        item = json.loads(json.dumps(record.model_dump(mode="json")), parse_float=Decimal)
        self.table.put_item(Item=item)
        return record

    def get_subscription(self, org_id: str, driver_id: str) -> Optional[PushSubscriptionRecord]:
        response = self.table.get_item(Key={"org_id": org_id, "driver_id": driver_id})
        item = response.get("Item")
        if not item:
            return None
        return PushSubscriptionRecord.model_validate(item)

    def delete_subscription(self, org_id: str, driver_id: str) -> None:
        self.table.delete_item(Key={"org_id": org_id, "driver_id": driver_id})


_IN_MEMORY_PUSH_SUBSCRIPTION_STORE = InMemoryPushSubscriptionStore()


def get_push_subscription_store() -> PushSubscriptionStore:
    table_name = os.environ.get("PUSH_SUBSCRIPTIONS_TABLE")
    if not table_name:
        return _IN_MEMORY_PUSH_SUBSCRIPTION_STORE
    try:
        return DynamoPushSubscriptionStore(table_name=table_name)
    except Exception:
        return _IN_MEMORY_PUSH_SUBSCRIPTION_STORE


def reset_in_memory_push_subscription_store():
    _IN_MEMORY_PUSH_SUBSCRIPTION_STORE.items.clear()
