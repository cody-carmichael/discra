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

    def get_order(self, org_id: str, order_id: str) -> Optional[Order]:
        item = self._table.get_item(Key={"org_id": org_id, "id": order_id}).get("Item")
        if not item:
            return None
        return Order.model_validate(item)

    def upsert_order(self, order: Order) -> Order:
        self._table.put_item(Item=order.model_dump(mode="json"))
        return order

    def _list_by_org(self, org_id: str) -> List[Order]:
        response = self._table.query(KeyConditionExpression=Key("org_id").eq(org_id))
        items = list(response.get("Items", []))
        while "LastEvaluatedKey" in response:
            response = self._table.query(
                KeyConditionExpression=Key("org_id").eq(org_id),
                ExclusiveStartKey=response["LastEvaluatedKey"],
            )
            items.extend(response.get("Items", []))
        return [Order.model_validate(item) for item in items]

    def list_orders(
        self,
        org_id: str,
        status: Optional[OrderStatus] = None,
        assigned_to: Optional[str] = None,
    ) -> List[Order]:
        values = self._list_by_org(org_id=org_id)
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
            for order in self._list_by_org(org_id=org_id)
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
        for order in self._list_by_org(org_id=org_id):
            if order.external_order_id == external_order_id and (order.source or "external") == source:
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
