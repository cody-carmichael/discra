import json
import logging
import os

try:
    from pywebpush import webpush, WebPushException
except ImportError:  # pragma: no cover - pywebpush may not be installed locally
    webpush = None
    WebPushException = Exception

try:
    from backend.push_store import get_push_subscription_store
except ModuleNotFoundError:  # local run from backend/ directory
    from push_store import get_push_subscription_store

logger = logging.getLogger(__name__)

_vapid_private_key_cache: str = ""


def _get_vapid_private_key() -> str:
    """Fetch the VAPID private key from SSM SecureString at runtime.

    The env var VAPID_PRIVATE_KEY_PARAM holds the SSM parameter path.
    Falls back to VAPID_PRIVATE_KEY env var for local development.
    Result is cached for the lifetime of the Lambda container.
    """
    global _vapid_private_key_cache
    if _vapid_private_key_cache:
        return _vapid_private_key_cache

    # Local dev fallback
    direct = os.environ.get("VAPID_PRIVATE_KEY", "")
    if direct:
        _vapid_private_key_cache = direct
        return _vapid_private_key_cache

    param_path = os.environ.get("VAPID_PRIVATE_KEY_PARAM", "")
    if not param_path:
        return ""

    try:
        import boto3
        ssm = boto3.client("ssm")
        resp = ssm.get_parameter(Name=param_path, WithDecryption=True)
        _vapid_private_key_cache = resp["Parameter"]["Value"]
    except Exception as e:
        logger.error("Failed to fetch VAPID private key from SSM: %s", e)

    return _vapid_private_key_cache


def send_push_notification(org_id: str, driver_id: str, payload: dict) -> bool:
    """Send a Web Push notification to a driver. Returns True if sent successfully.

    This function is designed to be fire-and-forget: it never raises exceptions
    that would disrupt the calling code (e.g. order assignment).
    """
    if webpush is None:
        logger.debug("pywebpush not installed, skipping push notification")
        return False

    vapid_private_key = _get_vapid_private_key()
    vapid_claim_email = os.environ.get("VAPID_CLAIM_EMAIL", "")
    if not vapid_private_key or not vapid_claim_email:
        logger.debug("VAPID keys not configured, skipping push notification")
        return False

    try:
        store = get_push_subscription_store()
        subscription = store.get_subscription(org_id, driver_id)
        if not subscription:
            logger.debug("No push subscription for driver %s in org %s", driver_id, org_id)
            return False

        subscription_info = {
            "endpoint": subscription.endpoint,
            "keys": {
                "p256dh": subscription.p256dh,
                "auth": subscription.auth,
            },
        }

        webpush(
            subscription_info=subscription_info,
            data=json.dumps(payload),
            vapid_private_key=vapid_private_key,
            vapid_claims={"sub": vapid_claim_email},
        )
        logger.info("Push notification sent to driver %s in org %s", driver_id, org_id)
        return True

    except WebPushException as e:
        response = getattr(e, "response", None)
        status_code = getattr(response, "status_code", None) if response else None
        if status_code in (404, 410):
            logger.info("Push subscription expired for driver %s, removing", driver_id)
            try:
                store.delete_subscription(org_id, driver_id)
            except Exception:
                pass
        else:
            logger.warning("Push notification failed for driver %s: %s", driver_id, e)
        return False

    except Exception as e:
        logger.warning("Unexpected error sending push to driver %s: %s", driver_id, e)
        return False
