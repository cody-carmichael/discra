import os
from abc import ABC, abstractmethod
from typing import Dict, List, Optional, Tuple

try:
    import boto3
    from boto3.dynamodb.conditions import Key
except ImportError:  # pragma: no cover - boto3 available in Lambda
    boto3 = None
    Key = None

try:
    from backend.schemas import Order, OrderStatus
except ModuleNotFoundError:  # local run from backend/ directory
    from schemas import Order, OrderStatus


def _as_bool(value: Optional[str], default: bool = False) -> bool:
    if value is None:
        return default
    return value.strip().lower() in {"1", "true", "yes", "on"}


_ORDERS_STATUS_INDEX = "orders_by_status"
_ORDERS_ASSIGNED_DRIVER_INDEX = "orders_by_assigned_driver"
_ORDERS_EXTERNAL_LOOKUP_INDEX = "orders_by_external_lookup"
_ASSIGNED_DRIVER_ATTR = "assigned_driver_id"
_EXTERNAL_LOOKUP_ATTR = "source_external_order_id"


def _normalize_source(source: Optional[str]) -> str:
    value = (source or "").strip()
    return value or "external"


def _external_lookup_key(source: Optional[str], external_order_id: str) -> str:
    return f"{_normalize_source(source)}#{external_order_id.strip()}"


class OrderStore(ABC):
    @abstractmethod
    def get_order(self, org_id: str, order_id: str) -> Optional[Order]:
        raise NotImplementedError

    @abstractmethod
    def upsert_order(self, order: Order) -> Order:
        raise NotImplementedError

    @abstractmethod
    def list_orders(
        self,
        org_id: str,
        status: Optional[OrderStatus] = None,
        assigned_to: Optional[str] = None,
    ) -> List[Order]:
        raise NotImplementedError

    @abstractmethod
    def list_assigned_orders(
        self,
        org_id: str,
        driver_id: str,
        include_terminal: bool = True,
    ) -> List[Order]:
        raise NotImplementedError

    @abstractmethod
    def find_order_by_external_id(
        self,
        org_id: str,
        source: str,
        external_order_id: str,
    ) -> Optional[Order]:
        raise NotImplementedError


class InMemoryOrderStore(OrderStore):
    def __init__(self):
        self.items: Dict[Tuple[str, str], Order] = {}

    def get_order(self, org_id: str, order_id: str) -> Optional[Order]:
        return self.items.get((org_id, order_id))

    def upsert_order(self, order: Order) -> Order:
        self.items[(order.org_id, order.id)] = order
        return order

    def list_orders(
        self,
        org_id: str,
        status: Optional[OrderStatus] = None,
        assigned_to: Optional[str] = None,
    ) -> List[Order]:
        values = [order for (item_org_id, _), order in self.items.items() if item_org_id == org_id]
        if status is not None:
            values = [order for order in values if order.status == status]
        if assigned_to:
            values = [order for order in values if order.assigned_to == assigned_to]
        return values

    def list_assigned_orders(
        self,
        org_id: str,
        driver_id: str,
        include_terminal: bool = True,
    ) -> List[Order]:
        values = [
            order
            for order in self.list_orders(org_id=org_id)
            if order.assigned_to == driver_id
        ]
        if include_terminal:
            return values
        return [
            order
            for order in values
            if order.status not in {OrderStatus.DELIVERED, OrderStatus.FAILED}
        ]

    def find_order_by_external_id(
        self,
        org_id: str,
        source: str,
        external_order_id: str,
    ) -> Optional[Order]:
        for order in self.list_orders(org_id=org_id):
            if order.external_order_id == external_order_id and (order.source or "external") == source:
                return order
        return None


class DynamoOrderStore(OrderStore):
    def __init__(self, table_name: str):
        if boto3 is None:
            raise RuntimeError("boto3 not available")
        self._table = boto3.resource("dynamodb").Table(table_name)
        self._status_index_name = os.environ.get("ORDERS_STATUS_INDEX", _ORDERS_STATUS_INDEX).strip() or _ORDERS_STATUS_INDEX
        self._assigned_driver_index_name = (
            os.environ.get("ORDERS_ASSIGNED_DRIVER_INDEX", _ORDERS_ASSIGNED_DRIVER_INDEX).strip()
            or _ORDERS_ASSIGNED_DRIVER_INDEX
        )
        self._external_lookup_index_name = (
            os.environ.get("ORDERS_EXTERNAL_LOOKUP_INDEX", _ORDERS_EXTERNAL_LOOKUP_INDEX).strip()
            or _ORDERS_EXTERNAL_LOOKUP_INDEX
        )

    def get_order(self, org_id: str, order_id: str) -> Optional[Order]:
        item = self._table.get_item(Key={"org_id": org_id, "id": order_id}).get("Item")
        if not item:
            return None
        return Order.model_validate(item)

    def upsert_order(self, order: Order) -> Order:
        item = order.model_dump(mode="json")

        assigned_driver_id = (order.assigned_to or "").strip()
        if assigned_driver_id:
            item[_ASSIGNED_DRIVER_ATTR] = assigned_driver_id
        else:
            item.pop(_ASSIGNED_DRIVER_ATTR, None)

        external_order_id = (order.external_order_id or "").strip()
        if external_order_id:
            item[_EXTERNAL_LOOKUP_ATTR] = _external_lookup_key(order.source, external_order_id)
        else:
            item.pop(_EXTERNAL_LOOKUP_ATTR, None)

        self._table.put_item(Item=item)
        return order

    def _query_orders(self, **query_kwargs) -> List[Order]:
        response = self._table.query(**query_kwargs)
        items = list(response.get("Items", []))
        while "LastEvaluatedKey" in response:
            next_kwargs = dict(query_kwargs)
            next_kwargs["ExclusiveStartKey"] = response["LastEvaluatedKey"]
            response = self._table.query(**next_kwargs)
            items.extend(response.get("Items", []))
        return [Order.model_validate(item) for item in items]

    def _list_by_org(self, org_id: str) -> List[Order]:
        return self._query_orders(KeyConditionExpression=Key("org_id").eq(org_id))

    def _query_status_index(self, org_id: str, status: OrderStatus) -> Optional[List[Order]]:
        try:
            return self._query_orders(
                IndexName=self._status_index_name,
                KeyConditionExpression=Key("org_id").eq(org_id) & Key("status").eq(status.value),
            )
        except Exception:
            return None

    def _query_assigned_driver_index(self, org_id: str, assigned_to: str) -> Optional[List[Order]]:
        try:
            return self._query_orders(
                IndexName=self._assigned_driver_index_name,
                KeyConditionExpression=Key("org_id").eq(org_id) & Key(_ASSIGNED_DRIVER_ATTR).eq(assigned_to),
            )
        except Exception:
            return None

    def _query_external_lookup_index(self, org_id: str, lookup_key: str) -> Optional[List[Order]]:
        try:
            return self._query_orders(
                IndexName=self._external_lookup_index_name,
                KeyConditionExpression=Key("org_id").eq(org_id) & Key(_EXTERNAL_LOOKUP_ATTR).eq(lookup_key),
            )
        except Exception:
            return None

    def list_orders(
        self,
        org_id: str,
        status: Optional[OrderStatus] = None,
        assigned_to: Optional[str] = None,
    ) -> List[Order]:
        assigned_driver_id = (assigned_to or "").strip()
        if assigned_driver_id:
            indexed = self._query_assigned_driver_index(org_id=org_id, assigned_to=assigned_driver_id)
            values = indexed if indexed is not None else self._list_by_org(org_id=org_id)
            values = [order for order in values if order.assigned_to == assigned_driver_id]
            if status is not None:
                values = [order for order in values if order.status == status]
            return values

        if status is not None:
            indexed = self._query_status_index(org_id=org_id, status=status)
            if indexed is not None:
                return indexed

        values = self._list_by_org(org_id=org_id)
        if status is not None:
            values = [order for order in values if order.status == status]
        return values

    def list_assigned_orders(
        self,
        org_id: str,
        driver_id: str,
        include_terminal: bool = True,
    ) -> List[Order]:
        values = self.list_orders(org_id=org_id, assigned_to=driver_id)
        if include_terminal:
            return values
        return [
            order
            for order in values
            if order.status not in {OrderStatus.DELIVERED, OrderStatus.FAILED}
        ]

    def find_order_by_external_id(
        self,
        org_id: str,
        source: str,
        external_order_id: str,
    ) -> Optional[Order]:
        external_order_id = (external_order_id or "").strip()
        if not external_order_id:
            return None

        normalized_source = _normalize_source(source)
        lookup_key = _external_lookup_key(normalized_source, external_order_id)
        indexed = self._query_external_lookup_index(org_id=org_id, lookup_key=lookup_key)
        if indexed:
            return indexed[0]

        # Backward compatibility for rows written before source_external_order_id existed.
        for order in self._list_by_org(org_id=org_id):
            if order.external_order_id == external_order_id and _normalize_source(order.source) == normalized_source:
                return order
        return None


_IN_MEMORY_ORDER_STORE = InMemoryOrderStore()


def get_order_store() -> OrderStore:
    force_memory = _as_bool(os.environ.get("USE_IN_MEMORY_ORDER_STORE"), default=False)
    if force_memory:
        return _IN_MEMORY_ORDER_STORE

    table_name = (os.environ.get("ORDERS_TABLE") or "").strip()
    if not table_name:
        return _IN_MEMORY_ORDER_STORE

    try:
        return DynamoOrderStore(table_name=table_name)
    except Exception:
        return _IN_MEMORY_ORDER_STORE


def reset_in_memory_order_store():
    _IN_MEMORY_ORDER_STORE.items.clear()
