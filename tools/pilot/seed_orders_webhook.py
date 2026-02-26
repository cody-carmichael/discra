#!/usr/bin/env python
"""
Seed Discra orders through the external orders webhook.

This is intended for pilot/demo onboarding so Admin/Dispatcher users have
orders to assign without manual entry.
"""

from __future__ import annotations

import argparse
import hashlib
import hmac
import json
import os
import random
import sys
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Dict, Iterable, List, Optional
from urllib import error, request


@dataclass
class SeedConfig:
    endpoint: str
    token: str
    org_id: str
    source: str
    count: int
    batch_size: int
    pickup_address: str
    hmac_secret: Optional[str]
    seed: int


def _parse_args() -> SeedConfig:
    parser = argparse.ArgumentParser(
        description="Seed orders using Discra POST /backend/webhooks/orders endpoint.",
    )
    parser.add_argument(
        "--endpoint",
        required=True,
        help="Full webhook URL, e.g. https://<api-id>.execute-api.us-east-1.amazonaws.com/dev/backend/webhooks/orders",
    )
    parser.add_argument(
        "--token",
        default=os.environ.get("ORDERS_WEBHOOK_TOKEN", ""),
        help="Orders webhook token (x-orders-webhook-token).",
    )
    parser.add_argument("--org-id", default="org-pilot-1", help="Tenant/org id used for seeded orders.")
    parser.add_argument("--source", default="pilot-seed", help="Source label written to each order.")
    parser.add_argument(
        "--count",
        type=int,
        default=50,
        help="Number of orders to generate (default: 50).",
    )
    parser.add_argument(
        "--batch-size",
        type=int,
        default=50,
        help="Webhook batch size (1-500, default: 50).",
    )
    parser.add_argument(
        "--pickup-address",
        default="111 Distribution Way, Nashville, TN 37207",
        help="Default pickup address for generated orders.",
    )
    parser.add_argument(
        "--hmac-secret",
        default=os.environ.get("ORDERS_WEBHOOK_HMAC_SECRET"),
        help="Optional HMAC secret (ORDERS_WEBHOOK_HMAC_SECRET).",
    )
    parser.add_argument(
        "--seed",
        type=int,
        default=42,
        help="Random seed for deterministic output (default: 42).",
    )
    args = parser.parse_args()

    if args.count < 1:
        parser.error("--count must be >= 1")
    if args.batch_size < 1 or args.batch_size > 500:
        parser.error("--batch-size must be between 1 and 500")
    if not args.token or not str(args.token).strip():
        parser.error("--token is required (or set ORDERS_WEBHOOK_TOKEN)")

    return SeedConfig(
        endpoint=args.endpoint.strip(),
        token=args.token.strip(),
        org_id=args.org_id.strip(),
        source=args.source.strip(),
        count=args.count,
        batch_size=args.batch_size,
        pickup_address=args.pickup_address.strip(),
        hmac_secret=(args.hmac_secret.strip() if args.hmac_secret else None),
        seed=args.seed,
    )


def _chunks(items: List[dict], size: int) -> Iterable[List[dict]]:
    for index in range(0, len(items), size):
        yield items[index : index + size]


def _build_orders(cfg: SeedConfig) -> List[dict]:
    random.seed(cfg.seed)
    created_iso = datetime.now(timezone.utc).strftime("%Y%m%d%H%M%S")
    streets = [
        "100 Main St",
        "205 Oak Ave",
        "78 Elm Blvd",
        "412 River Rd",
        "901 Broadway",
        "66 Pinecrest Dr",
        "340 Cedar Ln",
        "55 Maple Ct",
    ]
    cities = [
        "Nashville, TN 37203",
        "Nashville, TN 37207",
        "Franklin, TN 37064",
        "Murfreesboro, TN 37129",
        "Brentwood, TN 37027",
    ]
    dimensions = ["10x8x6 in", "14x10x8 in", "18x12x10 in", "22x16x12 in"]

    orders: List[dict] = []
    for index in range(cfg.count):
        order_num = index + 1
        suffix = f"{created_iso}-{order_num:04d}"
        delivery = f"{random.choice(streets)}, {random.choice(cities)}"
        packages = random.randint(1, 4)
        weight = round(random.uniform(1.0, 42.0), 1)

        orders.append(
            {
                "external_order_id": f"pilot-{suffix}",
                "customer_name": f"Pilot Customer {order_num}",
                "reference_number": 700000 + order_num,
                "pick_up_address": cfg.pickup_address,
                "delivery": delivery,
                "dimensions": random.choice(dimensions),
                "weight": weight,
                "phone": f"+1-615-555-{order_num:04d}"[:16],
                "email": f"pilot.customer{order_num}@example.com",
                "notes": "Seeded via tools/pilot/seed_orders_webhook.py",
                "num_packages": packages,
            }
        )
    return orders


def _build_headers(cfg: SeedConfig, body: bytes) -> Dict[str, str]:
    headers = {
        "content-type": "application/json",
        "x-orders-webhook-token": cfg.token,
    }
    if cfg.hmac_secret:
        timestamp = str(int(time.time()))
        signature_payload = timestamp.encode("utf-8") + b"." + body
        digest = hmac.new(
            cfg.hmac_secret.encode("utf-8"),
            signature_payload,
            hashlib.sha256,
        ).hexdigest()
        headers["x-orders-webhook-timestamp"] = timestamp
        headers["x-orders-webhook-signature"] = f"sha256={digest}"
    return headers


def _post_batch(cfg: SeedConfig, orders: List[dict]) -> dict:
    payload = {
        "org_id": cfg.org_id,
        "source": cfg.source,
        "orders": orders,
    }
    body = json.dumps(payload, separators=(",", ":")).encode("utf-8")
    req = request.Request(
        cfg.endpoint,
        data=body,
        headers=_build_headers(cfg, body),
        method="POST",
    )
    try:
        with request.urlopen(req, timeout=30) as response:
            raw = response.read().decode("utf-8")
            return json.loads(raw)
    except error.HTTPError as exc:
        details = exc.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"Webhook HTTP {exc.code}: {details}") from exc
    except error.URLError as exc:
        raise RuntimeError(f"Webhook request failed: {exc}") from exc


def main() -> int:
    cfg = _parse_args()
    orders = _build_orders(cfg)
    batches = list(_chunks(orders, cfg.batch_size))

    print(f"Seeding {cfg.count} orders to {cfg.endpoint}")
    print(f"Org: {cfg.org_id}, Source: {cfg.source}, Batches: {len(batches)}")

    accepted = 0
    created = 0
    updated = 0
    for batch_index, batch_orders in enumerate(batches, start=1):
        result = _post_batch(cfg, batch_orders)
        batch_accepted = int(result.get("accepted", 0))
        batch_created = int(result.get("created", 0))
        batch_updated = int(result.get("updated", 0))
        accepted += batch_accepted
        created += batch_created
        updated += batch_updated
        print(
            f"[{batch_index}/{len(batches)}] accepted={batch_accepted} created={batch_created} "
            f"updated={batch_updated}"
        )

    print("")
    print("Seed complete")
    print(f"accepted={accepted} created={created} updated={updated}")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except KeyboardInterrupt:
        print("Cancelled", file=sys.stderr)
        raise SystemExit(130)
    except RuntimeError as exc:
        print(str(exc), file=sys.stderr)
        raise SystemExit(1)
