"""Scheduled Lambda handler for polling Gmail inboxes and creating orders.

Triggered by EventBridge every 60 seconds. Scans all orgs with email connected,
fetches new messages via Gmail API, classifies, parses, and creates orders.
"""

import logging
import os
import uuid
from datetime import datetime, timezone

logger = logging.getLogger(__name__)

from email_classifier import classify_email, SkipReason
from email_parser import get_parser
from email_store import get_email_config_store, get_skipped_email_store
from gmail_client import GmailClient, GmailAuthError
from order_store import get_order_store
from schemas import Order, OrderStatus, SkippedEmail
from ws_notifier import broadcast as ws_broadcast

PROCESSED_LABEL = "discra-processed"
SKIPPED_LABEL = "discra-skipped"


def _utc_now() -> datetime:
    return datetime.now(timezone.utc)


def _notify_reauth_required(org_id: str, code: str):
    """Best-effort live notification that a Gmail reconnect is required."""
    try:
        ws_broadcast(org_id, {
            "type": "gmail_auth_required",
            "code": code,
            "message": "Gmail authorization expired. Please reconnect to resume order processing.",
        })
    except Exception as ws_err:
        logger.warning("Org %s: ws broadcast for gmail_auth_required failed: %s", org_id, ws_err)


def _process_org(org_config):
    """Process a single org's email inbox. Returns (orders_created, errors)."""
    org_id = org_config.org_id
    orders_created = 0
    errors = []

    config_store = get_email_config_store()
    skipped_store = get_skipped_email_store()
    order_store = get_order_store()

    # Short-circuit if the connection is already known to need reauth.
    # The poller stops touching Gmail until the user reconnects via OAuth,
    # which clears needs_reauth. This avoids burning quota on a dead token.
    if getattr(org_config, "needs_reauth", False):
        logger.info("Org %s: skipping poll — Gmail needs reauth", org_id)
        return 0, []

    client_id = os.environ.get("GOOGLE_OAUTH_CLIENT_ID", "")
    client_secret = os.environ.get("GOOGLE_OAUTH_CLIENT_SECRET", "")

    try:
        gmail = GmailClient(
            refresh_token=org_config.gmail_refresh_token,
            client_id=client_id,
            client_secret=client_secret,
        )

        # Get current history ID if this is the first poll
        if not org_config.gmail_history_id:
            history_id = gmail.get_history_id()
            config_store.update_poll_status(org_id, history_id)
            logger.info("Org %s: initialized historyId=%s, will poll on next cycle", org_id, history_id)
            return 0, []

        # Fetch new messages since last poll
        message_ids, new_history_id = gmail.list_new_message_ids(org_config.gmail_history_id)

        if not message_ids:
            config_store.update_poll_status(org_id, new_history_id)
            return 0, []

        logger.info("Org %s: %d new messages to process", org_id, len(message_ids))

        for msg_id in message_ids:
            try:
                # Skip if already processed
                if gmail.has_label(msg_id, PROCESSED_LABEL):
                    continue

                message = gmail.get_message(msg_id)

                # Classify the email (custom org rules checked first)
                custom_rules = [r.model_dump() for r in (org_config.email_rules or [])]
                result = classify_email(
                    subject=message.subject,
                    sender=message.sender,
                    html_body=message.html_body,
                    text_body=message.text_body,
                    custom_rules=custom_rules,
                )

                if not result.is_order:
                    # Log skipped email
                    skipped = SkippedEmail(
                        org_id=org_id,
                        email_message_id=msg_id,
                        sender=result.original_sender,
                        subject=result.original_subject,
                        skip_reason=result.skip_reason.value if result.skip_reason else "unknown",
                        received_at=_utc_now(),
                    )
                    skipped_store.put_skipped(skipped)
                    gmail.add_label(msg_id, SKIPPED_LABEL)
                    gmail.add_label(msg_id, PROCESSED_LABEL)
                    logger.info(
                        "Org %s: skipped email %s (reason=%s, sender=%s)",
                        org_id, msg_id, skipped.skip_reason, result.original_sender,
                    )
                    continue

                # Parse the order (source may be an EmailSource enum or a plain string from a custom rule)
                source_key = getattr(result.source, "value", result.source)
                parser = get_parser(source_key)
                if not parser:
                    logger.warning("Org %s: no parser for source %s", org_id, result.source)
                    continue

                parsed = parser.parse(message)
                if not parsed:
                    logger.warning("Org %s: parser returned None for message %s", org_id, msg_id)
                    skipped = SkippedEmail(
                        org_id=org_id,
                        email_message_id=msg_id,
                        sender=result.original_sender,
                        subject=result.original_subject,
                        skip_reason="parse_failed",
                        received_at=_utc_now(),
                    )
                    skipped_store.put_skipped(skipped)
                    gmail.add_label(msg_id, SKIPPED_LABEL)
                    gmail.add_label(msg_id, PROCESSED_LABEL)
                    continue

                # Use the email message ID as external_order_id for dedup
                external_id = parsed.external_order_id or msg_id
                source = parsed.source or getattr(result.source, "value", result.source)

                # Check for duplicates
                existing = order_store.find_order_by_external_id(org_id, source, external_id)
                if existing:
                    logger.info("Org %s: duplicate order skipped (source=%s, external_id=%s)", org_id, source, external_id)
                    gmail.add_label(msg_id, PROCESSED_LABEL)
                    continue

                # Create the order
                order = Order(
                    id=str(uuid.uuid4()),
                    org_id=org_id,
                    customer_name=parsed.customer_name or "Unknown",
                    reference_id=parsed.reference_id or external_id,
                    pick_up_street=parsed.pick_up_street or "N/A",
                    pick_up_city=parsed.pick_up_city or "N/A",
                    pick_up_state=parsed.pick_up_state or "N/A",
                    pick_up_zip=parsed.pick_up_zip or "N/A",
                    delivery_street=parsed.delivery_street or "N/A",
                    delivery_city=parsed.delivery_city or "N/A",
                    delivery_state=parsed.delivery_state or "N/A",
                    delivery_zip=parsed.delivery_zip or "N/A",
                    dimensions=parsed.dimensions or None,
                    weight=parsed.weight,
                    pickup_deadline=parsed.pickup_deadline,
                    dropoff_deadline=parsed.dropoff_deadline,
                    phone=parsed.pickup_phone or None,
                    notes=parsed.notes or None,
                    num_packages=parsed.num_packages,
                    external_order_id=external_id,
                    source=source,
                    status=OrderStatus.CREATED,
                    created_at=_utc_now(),
                )
                order_store.upsert_order(order)
                gmail.add_label(msg_id, PROCESSED_LABEL)
                orders_created += 1
                logger.info(
                    "Org %s: created order %s (source=%s, ref=%s)",
                    org_id, order.id, source, order.reference_id,
                )

                # Broadcast new order to connected WebSocket clients
                try:
                    ws_broadcast(org_id, {
                        "type": "new_order",
                        "order": {
                            "id": order.id,
                            "reference_id": order.reference_id,
                            "customer_name": order.customer_name,
                            "source": order.source or "",
                            "pick_up_city": order.pick_up_city,
                            "pick_up_state": order.pick_up_state,
                            "delivery_city": order.delivery_city,
                            "delivery_state": order.delivery_state,
                            "status": order.status.value,
                            "created_at": order.created_at.isoformat(),
                        },
                    })
                except Exception as ws_err:
                    logger.warning("Org %s: WebSocket broadcast failed: %s", org_id, ws_err)

            except Exception as e:
                logger.exception("Org %s: error processing message %s: %s", org_id, msg_id, e)
                errors.append(f"msg={msg_id}: {e}")

        # Update poll status
        error_summary = "; ".join(errors) if errors else None
        config_store.update_poll_status(org_id, new_history_id, error=error_summary)

    except GmailAuthError as e:
        # Hard auth failure — the refresh token is dead. Mark the org as
        # needing reauth so the poller stops hammering Google with a bad
        # token, and notify any connected admins so the UI can surface a
        # reconnect banner without a page refresh.
        logger.warning("Org %s: Gmail auth failed (%s) — marking needs_reauth", org_id, e.code)
        try:
            config_store.update_poll_status(
                org_id,
                org_config.gmail_history_id or "",
                error=f"Gmail authorization expired ({e.code}). Please reconnect.",
                error_code=e.code,
                needs_reauth=True,
            )
        except Exception:
            pass
        _notify_reauth_required(org_id, e.code)
        errors.append(f"auth:{e.code}")
    except Exception as e:
        logger.exception("Org %s: poll failed: %s", org_id, e)
        try:
            config_store.update_poll_status(
                org_id,
                org_config.gmail_history_id or "",
                error=str(e)[:500],
            )
        except Exception:
            pass
        errors.append(str(e))

    return orders_created, errors


def handler(event, context):
    """Lambda handler triggered by EventBridge schedule."""
    logger.info("Email poller invoked")

    config_store = get_email_config_store()
    connected_orgs = config_store.list_connected_orgs()

    if not connected_orgs:
        logger.info("No orgs with email connected")
        return {"statusCode": 200, "body": "no_orgs"}

    total_created = 0
    total_errors = []

    for org_config in connected_orgs:
        created, errors = _process_org(org_config)
        total_created += created
        total_errors.extend(errors)

    logger.info(
        "Email poller complete: %d orgs polled, %d orders created, %d errors",
        len(connected_orgs), total_created, len(total_errors),
    )

    return {
        "statusCode": 200,
        "body": {
            "orgs_polled": len(connected_orgs),
            "orders_created": total_created,
            "errors": len(total_errors),
        },
    }
