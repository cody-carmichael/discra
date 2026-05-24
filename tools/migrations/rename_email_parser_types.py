#!/usr/bin/env python3
"""One-time migration: rename legacy company-specific email parser_type values.

The 2026 rename moved parser identifiers from carrier names to format names:

    Old (carrier-specific)  -> New (format-descriptive)
    email-marken            -> email-html-table
    email-airspace          -> email-labeled-fields
    email-cap               -> email-pdf-attachment
    email-ai                -> email-ai          (unchanged)

This script scans the email-configs DynamoDB table and rewrites any
EmailRule rows whose ``parser_type`` is still a legacy value. It is
idempotent — re-running after a successful pass updates nothing.

Usage (dev stack)::

    python tools/migrations/rename_email_parser_types.py \\
        --table-name discra-email-configs-discra-api-dev \\
        --region us-east-1 \\
        --dry-run

Run without ``--dry-run`` to apply. The script prints a per-org summary
before and after, and refuses to write when no changes are required.

Backstop: ``backend/email_store.py`` also normalizes legacy values on
read, so the API continues to return current names even if this script
hasn't been run yet. Run it anyway to keep the stored data clean.
"""

from __future__ import annotations

import argparse
import sys
from typing import Dict, List

try:
    import boto3
except ImportError:  # pragma: no cover
    print("ERROR: boto3 is required. `pip install boto3`.", file=sys.stderr)
    sys.exit(1)


LEGACY_PARSER_TYPE_MAP: Dict[str, str] = {
    "email-marken": "email-html-table",
    "email-airspace": "email-labeled-fields",
    "email-cap": "email-pdf-attachment",
}


def _migrate_rules(rules: List[dict]) -> tuple[List[dict], int]:
    """Return (new_rules_list, count_of_renames). Pure function, no I/O."""
    new_rules = []
    renames = 0
    for rule in rules:
        if not isinstance(rule, dict):
            new_rules.append(rule)
            continue
        old_pt = rule.get("parser_type", "")
        new_pt = LEGACY_PARSER_TYPE_MAP.get(old_pt, old_pt)
        if new_pt != old_pt:
            updated = dict(rule)
            updated["parser_type"] = new_pt
            new_rules.append(updated)
            renames += 1
        else:
            new_rules.append(rule)
    return new_rules, renames


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--table-name", required=True, help="DynamoDB table name for email configs (e.g. discra-email-configs-discra-api-dev)")
    parser.add_argument("--region", default="us-east-1", help="AWS region (default: us-east-1)")
    parser.add_argument("--dry-run", action="store_true", help="Report what would change without writing")
    args = parser.parse_args()

    print(f"Target: arn:aws:dynamodb:{args.region}:*:table/{args.table_name}")
    print(f"Mode:   {'DRY RUN — no writes' if args.dry_run else 'APPLY — writes enabled'}")
    print()

    ddb = boto3.resource("dynamodb", region_name=args.region)
    table = ddb.Table(args.table_name)

    items: List[dict] = []
    scan_kwargs: dict = {}
    while True:
        response = table.scan(**scan_kwargs)
        items.extend(response.get("Items", []))
        if "LastEvaluatedKey" not in response:
            break
        scan_kwargs = {"ExclusiveStartKey": response["LastEvaluatedKey"]}

    print(f"Scanned {len(items)} email config row(s).")

    orgs_updated = 0
    rules_renamed = 0
    skipped_no_changes = 0

    for item in items:
        org_id = item.get("org_id")
        if not org_id:
            continue
        rules = item.get("email_rules") or []
        if not isinstance(rules, list):
            continue

        new_rules, count = _migrate_rules(rules)
        if count == 0:
            skipped_no_changes += 1
            continue

        rules_renamed += count
        orgs_updated += 1
        print(f"  {org_id}: {count} rule(s) renamed")
        for old, new in LEGACY_PARSER_TYPE_MAP.items():
            n = sum(1 for r in rules if isinstance(r, dict) and r.get("parser_type") == old)
            if n:
                print(f"      {old} -> {new}  (x{n})")

        if not args.dry_run:
            table.update_item(
                Key={"org_id": org_id},
                UpdateExpression="SET email_rules = :r",
                ExpressionAttributeValues={":r": new_rules},
            )

    print()
    print("=" * 60)
    mode = "DRY RUN COMPLETE" if args.dry_run else "MIGRATION COMPLETE"
    print(f"{mode}: {rules_renamed} rule(s) across {orgs_updated} org(s)")
    print(f"  {skipped_no_changes} org(s) already on current naming")
    print("=" * 60)

    if args.dry_run and rules_renamed > 0:
        print()
        print("To apply, rerun without --dry-run.")


if __name__ == "__main__":
    main()
