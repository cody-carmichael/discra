"""Storage for in-app pilot feedback (Step 6.3).

Mirrors the push/email store pattern: an ABC, an in-memory implementation used by
tests and local runs, a DynamoDB implementation, and a factory that falls back to
in-memory when the table env var is absent so the app still boots without AWS.

Records are keyed (org_id, feedback_id) where feedback_id is timestamp-prefixed,
so a Query returns newest-first via ScanIndexForward=False without needing a GSI.
"""
import json
import os
import uuid
from abc import ABC, abstractmethod
from datetime import datetime, timezone
from decimal import Decimal
from typing import Dict, List, Optional, Tuple

try:
    import boto3
    from boto3.dynamodb.conditions import Key
except ImportError:  # pragma: no cover - boto3 available in Lambda
    boto3 = None
    Key = None

try:
    from backend.schemas import FeedbackRecord
except ModuleNotFoundError:  # local run from backend/ directory
    from schemas import FeedbackRecord


# A single pilot tester should not be able to fill the table with one paste.
MAX_MESSAGE_CHARS = 4000
# Cap what a list call returns so a chatty org can't produce an unbounded response.
MAX_LIST_LIMIT = 200


def utc_now() -> datetime:
    return datetime.now(timezone.utc)


def new_feedback_id(created_at: Optional[datetime] = None) -> str:
    """Timestamp-prefixed id so range keys sort chronologically.

    Format: <epoch_millis:013d>#<uuid4-hex-12>. The fixed-width millisecond prefix
    keeps lexicographic order equal to chronological order; the uuid suffix keeps
    two submissions in the same millisecond distinct.
    """
    moment = created_at or utc_now()
    millis = int(moment.timestamp() * 1000)
    return f"{millis:013d}#{uuid.uuid4().hex[:12]}"


class FeedbackStore(ABC):
    @abstractmethod
    def add_feedback(self, record: FeedbackRecord) -> FeedbackRecord:
        raise NotImplementedError

    @abstractmethod
    def list_feedback(self, org_id: str, limit: int = 50) -> List[FeedbackRecord]:
        """Newest first, capped at MAX_LIST_LIMIT."""
        raise NotImplementedError


class InMemoryFeedbackStore(FeedbackStore):
    def __init__(self):
        self.items: Dict[Tuple[str, str], FeedbackRecord] = {}

    def add_feedback(self, record: FeedbackRecord) -> FeedbackRecord:
        self.items[(record.org_id, record.feedback_id)] = record
        return record

    def list_feedback(self, org_id: str, limit: int = 50) -> List[FeedbackRecord]:
        capped = max(1, min(limit, MAX_LIST_LIMIT))
        rows = [record for (org, _), record in self.items.items() if org == org_id]
        rows.sort(key=lambda r: r.feedback_id, reverse=True)
        return rows[:capped]


class DynamoFeedbackStore(FeedbackStore):
    def __init__(self, table_name: str):
        if boto3 is None:
            raise RuntimeError("boto3 not available")
        self.table = boto3.resource("dynamodb").Table(table_name)

    def add_feedback(self, record: FeedbackRecord) -> FeedbackRecord:
        item = json.loads(json.dumps(record.model_dump(mode="json")), parse_float=Decimal)
        self.table.put_item(Item=item)
        return record

    def list_feedback(self, org_id: str, limit: int = 50) -> List[FeedbackRecord]:
        capped = max(1, min(limit, MAX_LIST_LIMIT))
        response = self.table.query(
            KeyConditionExpression=Key("org_id").eq(org_id),
            ScanIndexForward=False,  # feedback_id is time-ordered -> newest first
            Limit=capped,
        )
        return [FeedbackRecord.model_validate(item) for item in response.get("Items", [])]


_IN_MEMORY_FEEDBACK_STORE = InMemoryFeedbackStore()


def get_feedback_store() -> FeedbackStore:
    table_name = os.environ.get("FEEDBACK_TABLE")
    if not table_name:
        return _IN_MEMORY_FEEDBACK_STORE
    try:
        return DynamoFeedbackStore(table_name=table_name)
    except Exception:
        return _IN_MEMORY_FEEDBACK_STORE


def reset_in_memory_feedback_store():
    _IN_MEMORY_FEEDBACK_STORE.items.clear()
