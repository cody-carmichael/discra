from collections import Counter
from datetime import timedelta
from typing import Dict, List

from fastapi import APIRouter, Depends, Query

try:
    from backend.auth import ROLE_ADMIN, ROLE_DISPATCHER, require_roles
    from backend.location_service import get_driver_location_store, utc_now
    from backend.order_store import get_order_store
    from backend.schemas import DispatchSummaryResponse, OrderStatus
except ModuleNotFoundError:  # local run from backend/ directory
    from auth import ROLE_ADMIN, ROLE_DISPATCHER, require_roles
    from location_service import get_driver_location_store, utc_now
    from order_store import get_order_store
    from schemas import DispatchSummaryResponse, OrderStatus

router = APIRouter(prefix="/reports", tags=["reports"])


@router.get("/dispatch-summary", response_model=DispatchSummaryResponse)
async def dispatch_summary(
    active_minutes: int = Query(default=120, ge=1, le=1440),
    user=Depends(require_roles([ROLE_ADMIN, ROLE_DISPATCHER])),
    order_store=Depends(get_order_store),
    location_store=Depends(get_driver_location_store),
):
    orders = order_store.list_orders(org_id=user["org_id"])
    status_counts = Counter(order.status.value for order in orders)

    assigned_orders = sum(1 for order in orders if order.assigned_to)
    terminal_statuses = {OrderStatus.DELIVERED, OrderStatus.FAILED}
    terminal_orders = sum(1 for order in orders if order.status in terminal_statuses)

    cutoff = utc_now() - timedelta(minutes=active_minutes)
    locations = location_store.list_locations(org_id=user["org_id"])
    active_locations = [location for location in locations if location.timestamp >= cutoff]
    active_driver_ids: List[str] = sorted({location.driver_id for location in active_locations})

    by_status: Dict[str, int] = {}
    for status in OrderStatus:
        by_status[status.value] = int(status_counts.get(status.value, 0))

    return DispatchSummaryResponse(
        org_id=user["org_id"],
        generated_at=utc_now(),
        total_orders=len(orders),
        assigned_orders=assigned_orders,
        unassigned_orders=max(len(orders) - assigned_orders, 0),
        terminal_orders=terminal_orders,
        by_status=by_status,
        active_drivers=len(active_driver_ids),
        active_driver_ids=active_driver_ids,
    )
