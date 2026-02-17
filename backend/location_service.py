import os
from abc import ABC, abstractmethod
from datetime import datetime, timedelta, timezone
from typing import Dict, List, Optional, Tuple

try:
    import boto3
    from boto3.dynamodb.conditions import Key
except ImportError:  # pragma: no cover - boto3 available in Lambda
    boto3 = None
    Key = None

try:
    from backend.schemas import DriverLocationRecord, LocationUpdate
except ModuleNotFoundError:  # local run from backend/ directory
    from schemas import DriverLocationRecord, LocationUpdate

DEFAULT_LOCATION_TTL_SECONDS = 7200
MIN_LOCATION_TTL_SECONDS = 300
MAX_LOCATION_TTL_SECONDS = 86400


def utc_now() -> datetime:
    return datetime.now(timezone.utc)


def to_utc(value: Optional[datetime]) -> datetime:
    if value is None:
        return utc_now()
    if value.tzinfo is None:
        return value.replace(tzinfo=timezone.utc)
    return value.astimezone(timezone.utc)


def location_ttl_seconds() -> int:
    configured = os.environ.get("DRIVER_LOCATION_TTL_SECONDS")
    if not configured:
        return DEFAULT_LOCATION_TTL_SECONDS
    try:
        parsed = int(configured)
    except ValueError:
        return DEFAULT_LOCATION_TTL_SECONDS
    return max(MIN_LOCATION_TTL_SECONDS, min(parsed, MAX_LOCATION_TTL_SECONDS))


def build_driver_location_record(org_id: str, driver_id: str, payload: LocationUpdate) -> DriverLocationRecord:
    timestamp = to_utc(payload.timestamp)
    expiry = int((timestamp + timedelta(seconds=location_ttl_seconds())).timestamp())
    return DriverLocationRecord(
        org_id=org_id,
        driver_id=driver_id,
        lat=payload.lat,
        lng=payload.lng,
        heading=payload.heading,
        timestamp=timestamp,
        expires_at_epoch=expiry,
    )


class DriverLocationStore(ABC):
    @abstractmethod
    def upsert_location(self, location: DriverLocationRecord) -> DriverLocationRecord:
        raise NotImplementedError

    @abstractmethod
    def list_locations(self, org_id: str) -> List[DriverLocationRecord]:
        raise NotImplementedError


class InMemoryDriverLocationStore(DriverLocationStore):
    def __init__(self):
        self.items: Dict[Tuple[str, str], DriverLocationRecord] = {}

    def upsert_location(self, location: DriverLocationRecord) -> DriverLocationRecord:
        self.items[(location.org_id, location.driver_id)] = location
        return location

    def list_locations(self, org_id: str) -> List[DriverLocationRecord]:
        return [item for (item_org_id, _), item in self.items.items() if item_org_id == org_id]


class DynamoDriverLocationStore(DriverLocationStore):
    def __init__(self, table_name: str):
        if boto3 is None:
            raise RuntimeError("boto3 not available")
        self.table = boto3.resource("dynamodb").Table(table_name)

    def upsert_location(self, location: DriverLocationRecord) -> DriverLocationRecord:
        self.table.put_item(Item=location.model_dump(mode="json"))
        return location

    def list_locations(self, org_id: str) -> List[DriverLocationRecord]:
        response = self.table.query(
            KeyConditionExpression=Key("org_id").eq(org_id)
        )
        items = response.get("Items", [])
        return [DriverLocationRecord.model_validate(item) for item in items]


_IN_MEMORY_DRIVER_LOCATION_STORE = InMemoryDriverLocationStore()


def get_driver_location_store() -> DriverLocationStore:
    force_memory = os.environ.get("USE_IN_MEMORY_DRIVER_LOCATION_STORE", "").strip().lower() in {
        "1",
        "true",
        "yes",
    }
    if force_memory:
        return _IN_MEMORY_DRIVER_LOCATION_STORE

    table_name = os.environ.get("DRIVER_LOCATIONS_TABLE")
    if not table_name:
        return _IN_MEMORY_DRIVER_LOCATION_STORE
    try:
        return DynamoDriverLocationStore(table_name=table_name)
    except Exception:
        return _IN_MEMORY_DRIVER_LOCATION_STORE


def reset_in_memory_driver_location_store():
    _IN_MEMORY_DRIVER_LOCATION_STORE.items.clear()
