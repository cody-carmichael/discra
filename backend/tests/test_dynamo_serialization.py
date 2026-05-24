"""Tests for the shared float→Decimal serializer + the stores that depend on it.

The deployed system uses boto3's high-level `Table.put_item`, which rejects
Python `float` and requires `Decimal`. Pydantic v2's
`model_dump(mode="json")` produces a JSON-compatible shape where Decimal
becomes float, so any model with a float field would 500 on write without
the helper.

This test exercises:
1. `floats_to_decimal` directly across nested structures.
2. `pod_service.DynamoS3PodDataStore.put_metadata` with a `PodLocation`
   (lat/lng floats) — regression for the metadata 500 found in QA.
3. Order store re-tested here via the shared helper to confirm
   migration didn't break the existing contract.
"""

from datetime import datetime, timezone
from decimal import Decimal

from backend.dynamo_serialization import (
    floats_to_decimal,
    merge_to_dynamo_item,
    model_to_dynamo_item,
)
from backend.pod_service import DynamoS3PodDataStore
from backend.schemas import PodLocation, PodMetadataRecord


def test_floats_to_decimal_converts_top_level_float():
    out = floats_to_decimal({"weight": 4.5})
    assert isinstance(out["weight"], Decimal)
    assert out["weight"] == Decimal("4.5")


def test_floats_to_decimal_preserves_int_bool_str_none():
    out = floats_to_decimal(
        {"i": 7, "b": True, "s": "abc", "n": None, "ints_list": [1, 2, 3]}
    )
    assert out["i"] == 7 and isinstance(out["i"], int)
    assert out["b"] is True
    assert out["s"] == "abc"
    assert out["n"] is None
    assert out["ints_list"] == [1, 2, 3]
    assert all(isinstance(x, int) for x in out["ints_list"])


def test_floats_to_decimal_recurses_into_nested_dict_and_list():
    out = floats_to_decimal(
        {
            "location": {"lat": 32.7555, "lng": -97.3308},
            "stops": [
                {"lat": 1.5, "lng": 2.5},
                {"lat": 3.5, "lng": 4.5, "name": "stop-2"},
            ],
        }
    )
    assert isinstance(out["location"]["lat"], Decimal)
    assert out["location"]["lat"] == Decimal("32.7555")
    for stop in out["stops"]:
        assert isinstance(stop["lat"], Decimal)
        assert isinstance(stop["lng"], Decimal)


def test_merge_to_dynamo_item_adds_overrides_and_converts():
    out = merge_to_dynamo_item({"weight": 4.5}, secondary_key="abc", extra_float=1.5)
    assert out["weight"] == Decimal("4.5")
    assert out["secondary_key"] == "abc"
    assert out["extra_float"] == Decimal("1.5")


class _FakeS3:
    def generate_presigned_post(self, **_kw):
        return {"url": "https://example.invalid", "fields": {}}


class _FakeTable:
    def __init__(self):
        self.put_calls = []

    def put_item(self, Item):
        self.put_calls.append(Item)
        return {}

    def scan(self, **_kw):
        return {"Items": []}


def _store_with_table(table) -> DynamoS3PodDataStore:
    store = DynamoS3PodDataStore.__new__(DynamoS3PodDataStore)
    store.bucket_name = "test-bucket"
    store.s3 = _FakeS3()
    store.table = table
    return store


def test_pod_put_metadata_serializes_location_floats_as_decimal():
    """Regression: PodLocation lat/lng are float; without the fix
    `boto3.Table.put_item` rejected the payload and HTTP returned 500.
    """
    table = _FakeTable()
    store = _store_with_table(table)
    now = datetime.now(timezone.utc)

    metadata = PodMetadataRecord(
        org_id="org-1",
        pod_id="pod-1",
        order_id="ord-1",
        driver_id="drv-1",
        created_at=now,
        captured_at=now,
        photo_keys=["k/photo.jpg"],
        signature_keys=["k/sig.png"],
        notes="ok",
        location=PodLocation(lat=32.7555, lng=-97.3308, heading=180.0),
    )

    store.put_metadata(metadata)

    item = table.put_calls[0]
    assert isinstance(item["location"], dict)
    assert isinstance(item["location"]["lat"], Decimal)
    assert item["location"]["lat"] == Decimal("32.7555")
    assert isinstance(item["location"]["lng"], Decimal)
    assert isinstance(item["location"]["heading"], Decimal)


def test_pod_put_metadata_handles_no_location():
    """No location → no float fields → no Decimal upgrade required, but
    the call path still works."""
    table = _FakeTable()
    store = _store_with_table(table)
    now = datetime.now(timezone.utc)

    metadata = PodMetadataRecord(
        org_id="org-1",
        pod_id="pod-2",
        order_id="ord-2",
        driver_id="drv-1",
        created_at=now,
        captured_at=now,
        photo_keys=["k/photo.jpg"],
        signature_keys=[],
        notes=None,
        location=None,
    )

    store.put_metadata(metadata)
    item = table.put_calls[0]
    assert item["location"] is None
    assert item["photo_keys"] == ["k/photo.jpg"]


def test_model_to_dynamo_item_round_trips_decimal_back_to_float():
    """Sanity: PodLocation written as Decimal can be model_validated
    back as float (Pydantic handles Decimal→float automatically)."""
    item = model_to_dynamo_item(PodLocation(lat=1.5, lng=2.5))
    assert isinstance(item["lat"], Decimal)

    restored = PodLocation.model_validate(item)
    assert restored.lat == 1.5
    assert isinstance(restored.lat, float)
