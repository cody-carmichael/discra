#!/usr/bin/env python3
"""Seed mock proof-of-delivery records so the Admin POD viewer has something to render.

For each order assigned to the target driver that doesn't already have POD,
the script:
  1. Generates a small placeholder JPEG (photo) + PNG (signature) using stdlib only.
  2. Calls POST /pod/presign as the driver.
  3. Uploads the bytes via the returned S3 presigned POST.
  4. Calls POST /pod/metadata to register the records.

Run after the dev stack is up and at least one order is assigned to the
test-driver. Useful for QA: lets reviewers click "View POD" and actually see
photos + signatures rendered.

Usage:
  python tools/pilot/seed_mock_pod.py \
    --api-base https://m50fjhgrn7.execute-api.us-east-1.amazonaws.com/dev/backend \
    --driver-user-id test-driver \
    --org-id org-pilot-1 \
    --max-orders 5

Defaults work against the deployed dev stack with dev quick sign-in enabled.
"""

from __future__ import annotations

import argparse
import http.cookiejar
import io
import json
import struct
import sys
import urllib.error
import urllib.request
import uuid
import zlib
from typing import List, Optional, Tuple


# ---------------------------------------------------------------------------
# Image generation (stdlib only — no Pillow dependency)
# ---------------------------------------------------------------------------

def _png_chunk(chunk_type: bytes, data: bytes) -> bytes:
    return (
        struct.pack(">I", len(data))
        + chunk_type
        + data
        + struct.pack(">I", zlib.crc32(chunk_type + data) & 0xFFFFFFFF)
    )


def make_solid_png(width: int, height: int, rgb: Tuple[int, int, int]) -> bytes:
    """Build a minimal valid PNG of solid color. Useful as a placeholder."""
    sig = b"\x89PNG\r\n\x1a\n"
    ihdr_data = struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0)  # 8-bit RGB
    r, g, b = rgb
    raw = b""
    for _ in range(height):
        raw += b"\x00" + bytes((r, g, b)) * width
    idat = zlib.compress(raw, 9)
    return sig + _png_chunk(b"IHDR", ihdr_data) + _png_chunk(b"IDAT", idat) + _png_chunk(b"IEND", b"")


def make_signature_png(width: int = 400, height: int = 150) -> bytes:
    """Build a PNG with a wavy line that resembles a signature.

    Solid white background, dark wavy line traced across the width. No font
    library required.
    """
    import math

    sig = b"\x89PNG\r\n\x1a\n"
    ihdr_data = struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0)
    white = (255, 255, 255)
    ink = (32, 32, 48)

    # Build per-row pixel data
    raw = b""
    for y in range(height):
        row = bytearray(b"\x00")  # filter byte
        for x in range(width):
            # Two overlapping sine waves give a signature-ish curve
            wave1 = int(height / 2 + 25 * math.sin(x / 28.0))
            wave2 = int(height / 2 + 18 * math.sin(x / 14.0 + 1.2))
            if abs(y - wave1) <= 2 or abs(y - wave2) <= 1:
                row.extend(ink)
            else:
                row.extend(white)
        raw += bytes(row)

    idat = zlib.compress(raw, 9)
    return sig + _png_chunk(b"IHDR", ihdr_data) + _png_chunk(b"IDAT", idat) + _png_chunk(b"IEND", b"")


def make_mock_photo_jpeg() -> bytes:
    """Return a small valid JPEG of a dark-gray block.

    JPEG header construction from scratch is finicky; we ship a hardcoded
    minimal grayscale JPEG decoded from base64. Renders as a ~40x30 dark
    gray rectangle. Just enough to confirm the POD modal shows a photo.
    """
    import base64

    # Minimal 40x30 grayscale JPEG, dark gray. Roughly 350 bytes.
    return base64.b64decode(
        b"/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAAYEBAQFBAYFBQYJBgUGCQsIBgYICwwKCgsKCgwQDAwMDAwMEAwODxAPDgwTExQUExMcGxsbHB8fHx8fHx8fHx//2wBDAQcHBw0MDRgQEBgaFREVGh8fHx8fHx8fHx8fHx8fHx8fHx8fHx8fHx8fHx8fHx8fHx8fHx8fHx8fHx8fHx8fHx//wAARCAAeACgDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwD3+iiigD//2Q=="
    )


# ---------------------------------------------------------------------------
# HTTP helpers
# ---------------------------------------------------------------------------

def _open_jar() -> http.cookiejar.CookieJar:
    return http.cookiejar.CookieJar()


def _request(opener, method, url, *, headers=None, body=None) -> dict:
    req = urllib.request.Request(url, method=method)
    if headers:
        for k, v in headers.items():
            req.add_header(k, v)
    if body is not None:
        if isinstance(body, dict):
            req.add_header("Content-Type", "application/json")
            body = json.dumps(body).encode("utf-8")
        req.data = body
    with opener.open(req) as resp:
        raw = resp.read()
        if resp.status == 204 or not raw:
            return {}
        try:
            return json.loads(raw.decode("utf-8"))
        except json.JSONDecodeError:
            return {"_raw": raw}


def login_dev_session(opener, api_base: str, role: str, user_id: str, org_id: str) -> dict:
    """POST /ui/dev-auth/login to get a session cookie (requires EnableUiDevAuth)."""
    return _request(
        opener,
        "POST",
        f"{api_base}/ui/dev-auth/login",
        body={"role": role, "user_id": user_id, "org_id": org_id},
    )


def list_driver_inbox(opener, api_base: str) -> List[dict]:
    return _request(opener, "GET", f"{api_base}/orders/driver/inbox") or []


def list_pod_for_order(opener, api_base: str, order_id: str) -> List[dict]:
    return _request(opener, "GET", f"{api_base}/pod/order/{order_id}") or []


def presign_pod(opener, api_base: str, order_id: str, photo_bytes: bytes, sig_bytes: bytes) -> dict:
    return _request(
        opener,
        "POST",
        f"{api_base}/pod/presign",
        body={
            "order_id": order_id,
            "artifacts": [
                {
                    "artifact_type": "photo",
                    "content_type": "image/jpeg",
                    "file_size_bytes": len(photo_bytes),
                    "file_name": "mock-photo.jpg",
                },
                {
                    "artifact_type": "signature",
                    "content_type": "image/png",
                    "file_size_bytes": len(sig_bytes),
                    "file_name": "mock-signature.png",
                },
            ],
        },
    )


def upload_to_s3(presigned_post: dict, content_type: str, body: bytes) -> None:
    """Multipart POST upload to an S3 presigned-POST endpoint."""
    boundary = f"----DiscraSeed{uuid.uuid4().hex}"
    lines: List[bytes] = []
    for k, v in presigned_post["fields"].items():
        lines.append(f"--{boundary}".encode())
        lines.append(f'Content-Disposition: form-data; name="{k}"'.encode())
        lines.append(b"")
        lines.append(str(v).encode())
    lines.append(f"--{boundary}".encode())
    lines.append(b'Content-Disposition: form-data; name="file"; filename="upload"')
    lines.append(f"Content-Type: {content_type}".encode())
    lines.append(b"")
    lines.append(body)
    lines.append(f"--{boundary}--".encode())
    lines.append(b"")
    payload = b"\r\n".join(lines)

    req = urllib.request.Request(presigned_post["url"], method="POST", data=payload)
    req.add_header("Content-Type", f"multipart/form-data; boundary={boundary}")
    with urllib.request.urlopen(req) as resp:
        if resp.status >= 300:
            raise RuntimeError(f"S3 upload returned HTTP {resp.status}")


def post_pod_metadata(opener, api_base: str, order_id: str, photo_key: str, signature_key: str) -> dict:
    return _request(
        opener,
        "POST",
        f"{api_base}/pod/metadata",
        body={
            "order_id": order_id,
            "photo_keys": [photo_key],
            "signature_keys": [signature_key],
            "notes": "Mock POD seeded by tools/pilot/seed_mock_pod.py for QA",
            "location": {"lat": 32.7555, "lng": -97.3308},
        },
    )


# ---------------------------------------------------------------------------
# Driver
# ---------------------------------------------------------------------------

def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--api-base", default="https://m50fjhgrn7.execute-api.us-east-1.amazonaws.com/dev/backend")
    parser.add_argument("--driver-user-id", default="test-driver", help="dev quick-session driver user_id")
    parser.add_argument("--org-id", default="org-pilot-1")
    parser.add_argument("--max-orders", type=int, default=5, help="max number of orders to seed POD for (default: 5)")
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()

    api_base = args.api_base.rstrip("/")

    jar = _open_jar()
    opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar))

    print(f"Logging in as Driver {args.driver_user_id} (org {args.org_id}) ...")
    try:
        login_dev_session(opener, api_base, "Driver", args.driver_user_id, args.org_id)
    except urllib.error.HTTPError as e:
        print(f"ERROR: dev quick sign-in failed: {e}", file=sys.stderr)
        print("Confirm `EnableUiDevAuth=true` on the target deploy.", file=sys.stderr)
        return 1

    print("Listing driver inbox ...")
    inbox = list_driver_inbox(opener, api_base)
    print(f"  {len(inbox)} order(s) assigned to this driver.")

    candidates = []
    for order in inbox:
        if order.get("status") in {"Delivered", "Failed"}:
            continue
        existing = list_pod_for_order(opener, api_base, order["id"])
        if existing:
            continue
        candidates.append(order)
        if len(candidates) >= args.max_orders:
            break

    print(f"  {len(candidates)} order(s) eligible (active + no existing POD).")
    if not candidates:
        print("Nothing to seed. Try assigning more orders to the driver first.")
        return 0

    if args.dry_run:
        print()
        print("DRY RUN — would seed POD for:")
        for o in candidates:
            print(f"  {o['id']}  ref={o.get('reference_id', '?')}  status={o.get('status')}")
        return 0

    print()
    print("Generating placeholder images ...")
    photo_bytes = make_mock_photo_jpeg()
    sig_bytes = make_signature_png()
    print(f"  photo: {len(photo_bytes)} bytes (JPEG)")
    print(f"  signature: {len(sig_bytes)} bytes (PNG)")

    succeeded = 0
    failed = 0
    for order in candidates:
        order_id = order["id"]
        ref = order.get("reference_id", "?")
        print(f"\n→ Seeding POD for order {order_id} (ref={ref}) ...")
        try:
            presign = presign_pod(opener, api_base, order_id, photo_bytes, sig_bytes)
            uploads = {u["artifact_type"]: u for u in presign["uploads"]}
            photo_upload = uploads["photo"]
            sig_upload = uploads["signature"]

            print(f"    Uploading photo to S3 ({photo_upload['key']}) ...")
            upload_to_s3({"url": photo_upload["url"], "fields": photo_upload["fields"]}, "image/jpeg", photo_bytes)

            print(f"    Uploading signature to S3 ({sig_upload['key']}) ...")
            upload_to_s3({"url": sig_upload["url"], "fields": sig_upload["fields"]}, "image/png", sig_bytes)

            print("    Registering metadata ...")
            post_pod_metadata(opener, api_base, order_id, photo_upload["key"], sig_upload["key"])
            succeeded += 1
            print("    ✓ done")
        except urllib.error.HTTPError as e:
            failed += 1
            body = e.read().decode("utf-8", errors="replace") if e.fp else ""
            print(f"    ✗ HTTP {e.code}: {body[:200]}")
        except Exception as e:
            failed += 1
            print(f"    ✗ {type(e).__name__}: {e}")

    print()
    print("=" * 60)
    print(f"SUMMARY: seeded {succeeded} / failed {failed} / total {len(candidates)}")
    print("=" * 60)
    return 0 if failed == 0 else 2


if __name__ == "__main__":
    sys.exit(main())
