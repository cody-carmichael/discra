"""Broadcast messages to WebSocket connections for an org.

Uses the API Gateway Management API to POST messages to connected clients.
Automatically cleans up stale (GoneException) connections.
"""

import json
import logging
import os
from typing import Any, Dict, List

logger = logging.getLogger(__name__)

try:
    import boto3
    from botocore.exceptions import ClientError
except ImportError:  # pragma: no cover
    boto3 = None
    ClientError = Exception

try:
    from backend.ws_store import get_ws_connection_store
except ModuleNotFoundError:
    from ws_store import get_ws_connection_store


def _get_apigw_management_client():
    """Create an API Gateway Management API client."""
    endpoint = (os.environ.get("WS_API_ENDPOINT") or "").strip()
    if not endpoint or boto3 is None:
        return None

    # The endpoint must be https://{api-id}.execute-api.{region}.amazonaws.com/{stage}
    # Convert wss:// to https:// if needed
    if endpoint.startswith("wss://"):
        endpoint = "https://" + endpoint[6:]

    return boto3.client("apigatewaymanagementapi", endpoint_url=endpoint)


def broadcast(org_id: str, message: Dict[str, Any]) -> int:
    """Broadcast a message to all WebSocket connections for an org.

    Returns the number of connections successfully notified.
    """
    store = get_ws_connection_store()
    connections = store.get_connections_by_org(org_id)

    if not connections:
        return 0

    client = _get_apigw_management_client()
    if not client:
        logger.warning("WS_API_ENDPOINT not configured, skipping WebSocket broadcast for org %s", org_id)
        return 0

    payload = json.dumps(message).encode("utf-8")
    sent = 0

    for conn in connections:
        try:
            client.post_to_connection(
                ConnectionId=conn.connection_id,
                Data=payload,
            )
            sent += 1
        except ClientError as e:
            error_code = e.response.get("Error", {}).get("Code", "")
            if error_code == "GoneException":
                # Connection is stale, clean it up
                logger.debug("Removing stale WebSocket connection: %s", conn.connection_id)
                store.delete_connection(conn.connection_id)
            else:
                logger.warning(
                    "Failed to send to WebSocket connection %s: %s",
                    conn.connection_id, e,
                )
        except Exception as e:
            logger.warning("Failed to send to WebSocket connection %s: %s", conn.connection_id, e)

    logger.info("Broadcast to org %s: %d/%d connections", org_id, sent, len(connections))
    return sent
