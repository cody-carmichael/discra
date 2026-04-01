"""DynamoDB store for WebSocket connections."""

import logging
import os
from abc import ABC, abstractmethod
from datetime import datetime, timedelta, timezone
from typing import Dict, List, Optional, Tuple

try:
    import boto3
    from boto3.dynamodb.conditions import Key
except ImportError:  # pragma: no cover
    boto3 = None
    Key = None

logger = logging.getLogger(__name__)

CONNECTION_TTL_HOURS = 24


def utc_now() -> datetime:
    return datetime.now(timezone.utc)


class WsConnection:
    __slots__ = ("connection_id", "org_id", "user_id", "connected_at", "expires_at_epoch")

    def __init__(self, connection_id: str, org_id: str, user_id: str = "",
                 connected_at: str = "", expires_at_epoch: int = 0):
        self.connection_id = connection_id
        self.org_id = org_id
        self.user_id = user_id
        self.connected_at = connected_at or utc_now().isoformat()
        self.expires_at_epoch = expires_at_epoch or int((utc_now() + timedelta(hours=CONNECTION_TTL_HOURS)).timestamp())


class WsConnectionStore(ABC):
    @abstractmethod
    def put_connection(self, conn: WsConnection) -> None:
        raise NotImplementedError

    @abstractmethod
    def delete_connection(self, connection_id: str) -> None:
        raise NotImplementedError

    @abstractmethod
    def get_connections_by_org(self, org_id: str) -> List[WsConnection]:
        raise NotImplementedError


class InMemoryWsConnectionStore(WsConnectionStore):
    def __init__(self):
        self.items: Dict[str, WsConnection] = {}

    def put_connection(self, conn: WsConnection) -> None:
        self.items[conn.connection_id] = conn

    def delete_connection(self, connection_id: str) -> None:
        self.items.pop(connection_id, None)

    def get_connections_by_org(self, org_id: str) -> List[WsConnection]:
        return [c for c in self.items.values() if c.org_id == org_id]


class DynamoWsConnectionStore(WsConnectionStore):
    def __init__(self, table_name: str):
        if boto3 is None:
            raise RuntimeError("boto3 not available")
        self._table = boto3.resource("dynamodb").Table(table_name)

    def put_connection(self, conn: WsConnection) -> None:
        self._table.put_item(Item={
            "connection_id": conn.connection_id,
            "org_id": conn.org_id,
            "user_id": conn.user_id,
            "connected_at": conn.connected_at,
            "expires_at_epoch": conn.expires_at_epoch,
        })

    def delete_connection(self, connection_id: str) -> None:
        self._table.delete_item(Key={"connection_id": connection_id})

    def get_connections_by_org(self, org_id: str) -> List[WsConnection]:
        resp = self._table.query(
            IndexName="connections_by_org",
            KeyConditionExpression=Key("org_id").eq(org_id),
        )
        items = resp.get("Items", [])
        while resp.get("LastEvaluatedKey"):
            resp = self._table.query(
                IndexName="connections_by_org",
                KeyConditionExpression=Key("org_id").eq(org_id),
                ExclusiveStartKey=resp["LastEvaluatedKey"],
            )
            items.extend(resp.get("Items", []))
        return [
            WsConnection(
                connection_id=item["connection_id"],
                org_id=item["org_id"],
                user_id=item.get("user_id", ""),
                connected_at=item.get("connected_at", ""),
                expires_at_epoch=int(item.get("expires_at_epoch", 0)),
            )
            for item in items
        ]


_IN_MEMORY_WS_STORE = InMemoryWsConnectionStore()


def get_ws_connection_store() -> WsConnectionStore:
    table_name = (os.environ.get("WS_CONNECTIONS_TABLE") or "").strip()
    if not table_name:
        return _IN_MEMORY_WS_STORE
    try:
        return DynamoWsConnectionStore(table_name=table_name)
    except Exception:
        return _IN_MEMORY_WS_STORE


def reset_in_memory_ws_store():
    _IN_MEMORY_WS_STORE.items.clear()
