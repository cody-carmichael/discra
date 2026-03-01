from datetime import datetime, timezone
from typing import Optional

from backend.order_store import DynamoOrderStore
from backend.schemas import Order, OrderStatus


class _FakeTable:
    def __init__(self, query_results=None):
        self.query_results = list(query_results or [])
        self.query_calls = []
        self.put_calls = []

    def query(self, **kwargs):
        self.query_calls.append(kwargs)
        if not self.query_results:
            return {"Items": []}
        next_result = self.query_results.pop(0)
        if isinstance(next_result, Exception):
            raise next_result
        return next_result

    def put_item(self, Item):
        self.put_calls.append(Item)
        return {}


def _store_with_table(table: _FakeTable) -> DynamoOrderStore:
    store = DynamoOrderStore.__new__(DynamoOrderStore)
    store._table = table
    store._status_index_name = "orders_by_status"
    store._assigned_driver_index_name = "orders_by_assigned_driver"
    store._external_lookup_index_name = "orders_by_external_lookup"
    return store


def _order_item(
    order_id: str,
    status: str,
    assigned_to: Optional[str] = None,
    source: Optional[str] = None,
    external_order_id: Optional[str] = None,
):
    item = {
        "id": order_id,
        "customer_name": "Alice",
        "reference_number": 1001,
        "pick_up_address": "Warehouse 1",
        "delivery": "123 Main St",
        "dimensions": "10x8x4 in",
        "weight": 4.5,
        "num_packages": 1,
        "status": status,
        "created_at": datetime.now(timezone.utc).isoformat(),
        "org_id": "org-1",
    }
    if assigned_to is not None:
        item["assigned_to"] = assigned_to
        item["assigned_driver_id"] = assigned_to
    if source is not None:
        item["source"] = source
    if external_order_id is not None:
        item["external_order_id"] = external_order_id
    return item


def test_list_orders_prefers_assigned_driver_index_and_filters_status():
    table = _FakeTable(
        [
            {
                "Items": [
                    _order_item("ord-1", "Assigned", assigned_to="driver-1"),
                    _order_item("ord-2", "Delivered", assigned_to="driver-1"),
                ]
            }
        ]
    )
    store = _store_with_table(table)

    result = store.list_orders(org_id="org-1", status=OrderStatus.ASSIGNED, assigned_to="driver-1")

    assert len(result) == 1
    assert result[0].id == "ord-1"
    assert table.query_calls[0]["IndexName"] == "orders_by_assigned_driver"


def test_list_orders_falls_back_to_org_query_when_assigned_index_unavailable():
    table = _FakeTable(
        [
            RuntimeError("index missing"),
            {
                "Items": [
                    _order_item("ord-1", "Assigned", assigned_to="driver-1"),
                    _order_item("ord-2", "Created"),
                ]
            },
        ]
    )
    store = _store_with_table(table)

    result = store.list_orders(org_id="org-1", assigned_to="driver-1")

    assert len(result) == 1
    assert result[0].id == "ord-1"
    assert table.query_calls[0]["IndexName"] == "orders_by_assigned_driver"
    assert "IndexName" not in table.query_calls[1]


def test_find_order_by_external_id_falls_back_for_legacy_rows_without_lookup_key():
    table = _FakeTable(
        [
            {"Items": []},
            {"Items": [_order_item("ord-legacy", "Created", source="shopify", external_order_id="ext-1")]},
        ]
    )
    store = _store_with_table(table)

    found = store.find_order_by_external_id(org_id="org-1", source="shopify", external_order_id="ext-1")

    assert found is not None
    assert found.id == "ord-legacy"
    assert table.query_calls[0]["IndexName"] == "orders_by_external_lookup"
    assert "IndexName" not in table.query_calls[1]


def test_upsert_order_writes_derived_index_keys():
    table = _FakeTable()
    store = _store_with_table(table)
    now = datetime.now(timezone.utc)

    store.upsert_order(
        Order(
            id="ord-1",
            customer_name="Alice",
            reference_number=101,
            pick_up_address="Warehouse 1",
            delivery="123 Main St",
            dimensions="10x8x4 in",
            weight=4.5,
            num_packages=1,
            external_order_id="ext-1",
            source="shopify",
            status=OrderStatus.ASSIGNED,
            assigned_to="driver-1",
            created_at=now,
            org_id="org-1",
        )
    )
    store.upsert_order(
        Order(
            id="ord-2",
            customer_name="Bob",
            reference_number=102,
            pick_up_address="Warehouse 2",
            delivery="456 Broadway",
            dimensions="8x8x8 in",
            weight=5.0,
            num_packages=1,
            status=OrderStatus.CREATED,
            assigned_to=None,
            created_at=now,
            org_id="org-1",
        )
    )

    first = table.put_calls[0]
    second = table.put_calls[1]
    assert first["assigned_driver_id"] == "driver-1"
    assert first["source_external_order_id"] == "shopify#ext-1"
    assert "assigned_driver_id" not in second
    assert "source_external_order_id" not in second
