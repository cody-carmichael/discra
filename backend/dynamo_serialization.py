"""Shared helpers for serializing Pydantic models to DynamoDB items.

boto3's high-level `Table.put_item` rejects Python `float` and requires
`Decimal`. Pydantic v2's `model_dump(mode="json")` produces a JSON-compatible
shape (Decimal → float), so we need to flip floats back to Decimal before
writing.

Centralizing this avoids the bug recurring every time a new schema adds a
numeric field.
"""

from __future__ import annotations

import json
from decimal import Decimal
from typing import Any, Mapping

try:
    from pydantic import BaseModel
except ImportError:  # pragma: no cover - pydantic is a hard dep in production
    BaseModel = None  # type: ignore[assignment]


def floats_to_decimal(item: Any) -> Any:
    """Recursively convert Python floats in `item` to Decimal.

    Strings, ints, bools, and None pass through unchanged. Nested dicts and
    lists are traversed in place via JSON round-trip with
    `parse_float=Decimal`.

    NOTE: JSON round-trip means non-JSON-safe types (datetime, Decimal,
    Enum, etc.) MUST be serialized before calling this. Pass items produced
    by `model_dump(mode="json")` or equivalent.
    """
    return json.loads(json.dumps(item), parse_float=Decimal)


def model_to_dynamo_item(model: "BaseModel") -> dict:
    """Serialize a Pydantic model into a DynamoDB-ready item dict.

    Equivalent to `floats_to_decimal(model.model_dump(mode="json"))`.
    Prefer this in store/repository code so we don't litter call sites
    with the same two-line conversion.
    """
    return floats_to_decimal(model.model_dump(mode="json"))


def merge_to_dynamo_item(base: Mapping[str, Any], **overrides: Any) -> dict:
    """Combine a base item with overrides, then float→Decimal the result.

    Useful when store code builds the item dict manually (e.g. adding
    secondary index attributes) and needs the same protection.
    """
    merged = dict(base)
    merged.update(overrides)
    return floats_to_decimal(merged)
