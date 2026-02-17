from datetime import datetime, timezone
from typing import Dict, List, Set
from uuid import uuid4

from fastapi import APIRouter, Depends, HTTPException, status as http_status

try:
    from backend.auth import (
        ROLE_ADMIN,
        ROLE_DISPATCHER,
        ROLE_DRIVER,
        get_current_user,
        require_roles,
    )
    from backend.schemas import AssignRequest, Order, OrderCreate, OrderStatus, StatusUpdateRequest
except ModuleNotFoundError:  # local run from backend/ directory
    from auth import ROLE_ADMIN, ROLE_DISPATCHER, ROLE_DRIVER, get_current_user, require_roles
    from schemas import AssignRequest, Order, OrderCreate, OrderStatus, StatusUpdateRequest

router = APIRouter(prefix="/orders", tags=["orders"])

# In-memory store for PR2/PR3 bootstrap. Replace with DynamoDB in a later increment.
_orders: Dict[str, Order] = {}

_STATUS_TRANSITIONS: Dict[OrderStatus, Set[OrderStatus]] = {
    OrderStatus.CREATED: {OrderStatus.ASSIGNED, OrderStatus.FAILED},
    OrderStatus.ASSIGNED: {OrderStatus.PICKED_UP, OrderStatus.EN_ROUTE, OrderStatus.DELIVERED, OrderStatus.FAILED},
    OrderStatus.PICKED_UP: {OrderStatus.EN_ROUTE, OrderStatus.DELIVERED, OrderStatus.FAILED},
    OrderStatus.EN_ROUTE: {OrderStatus.DELIVERED, OrderStatus.FAILED},
    OrderStatus.DELIVERED: set(),
    OrderStatus.FAILED: {OrderStatus.ASSIGNED},
}


def _tenant_orders(org_id: str) -> List[Order]:
    return [order for order in _orders.values() if order.org_id == org_id]


def get_assigned_orders_for_driver(org_id: str, driver_id: str) -> List[Order]:
    return [
        order
        for order in _tenant_orders(org_id)
        if order.assigned_to == driver_id and order.status not in {OrderStatus.DELIVERED, OrderStatus.FAILED}
    ]


def _require_tenant_order(order_id: str, org_id: str) -> Order:
    order = _orders.get(order_id)
    if not order or order.org_id != org_id:
        raise HTTPException(status_code=http_status.HTTP_404_NOT_FOUND, detail="order not found")
    return order


def _has_any_role(user, roles: Set[str]) -> bool:
    return bool(set(user.get("groups") or []).intersection(roles))


def _validate_transition(current_status: OrderStatus, next_status: OrderStatus):
    allowed = _STATUS_TRANSITIONS.get(current_status, set())
    if next_status not in allowed and next_status != current_status:
        raise HTTPException(
            status_code=http_status.HTTP_400_BAD_REQUEST,
            detail=f"Invalid status transition from {current_status.value} to {next_status.value}",
        )


@router.post("/", response_model=Order)
async def create_order(
    payload: OrderCreate,
    user=Depends(require_roles([ROLE_ADMIN, ROLE_DISPATCHER])),
):
    order_id = str(uuid4())
    order = Order(
        id=order_id,
        customer_name=payload.customer_name,
        address=payload.address,
        phone=payload.phone,
        email=payload.email,
        notes=payload.notes,
        num_packages=payload.num_packages,
        delivery_lat=payload.delivery_lat,
        delivery_lng=payload.delivery_lng,
        status=OrderStatus.CREATED,
        assigned_to=None,
        created_at=datetime.now(timezone.utc),
        org_id=user["org_id"],
    )
    _orders[order_id] = order
    return order


@router.get("/", response_model=List[Order])
async def list_orders(
    status: OrderStatus = None,
    assignedTo: str = None,
    user=Depends(require_roles([ROLE_ADMIN, ROLE_DISPATCHER])),
):
    results = _tenant_orders(user["org_id"])
    if status:
        results = [order for order in results if order.status == status]
    if assignedTo:
        results = [order for order in results if order.assigned_to == assignedTo]
    return sorted(results, key=lambda order: order.created_at)


@router.post("/{order_id}/assign", response_model=Order)
async def assign_order(
    order_id: str,
    body: AssignRequest,
    user=Depends(require_roles([ROLE_ADMIN, ROLE_DISPATCHER])),
):
    order = _require_tenant_order(order_id, user["org_id"])
    order.assigned_to = body.driver_id
    order.status = OrderStatus.ASSIGNED
    _orders[order_id] = order
    return order


@router.post("/{order_id}/unassign", response_model=Order)
async def unassign_order(
    order_id: str,
    user=Depends(require_roles([ROLE_ADMIN, ROLE_DISPATCHER])),
):
    order = _require_tenant_order(order_id, user["org_id"])
    order.assigned_to = None
    order.status = OrderStatus.CREATED
    _orders[order_id] = order
    return order


@router.post("/{order_id}/status", response_model=Order)
async def update_order_status(
    order_id: str,
    body: StatusUpdateRequest,
    user=Depends(get_current_user),
):
    order = _require_tenant_order(order_id, user["org_id"])

    if _has_any_role(user, {ROLE_DRIVER}) and not _has_any_role(user, {ROLE_ADMIN, ROLE_DISPATCHER}):
        if order.assigned_to != user["sub"]:
            raise HTTPException(
                status_code=http_status.HTTP_403_FORBIDDEN,
                detail="Drivers can only update assigned orders",
            )

    _validate_transition(order.status, body.status)
    order.status = body.status
    _orders[order_id] = order
    return order


@router.get("/driver/inbox", response_model=List[Order])
async def driver_inbox(user=Depends(require_roles([ROLE_DRIVER]))):
    results = [
        order
        for order in _tenant_orders(user["org_id"])
        if order.assigned_to == user["sub"]
    ]
    return sorted(results, key=lambda order: order.created_at)


@router.get("/{order_id}", response_model=Order)
async def get_order(order_id: str, user=Depends(get_current_user)):
    order = _require_tenant_order(order_id, user["org_id"])
    user_roles = set(user.get("groups") or [])
    if ROLE_DRIVER in user_roles and ROLE_ADMIN not in user_roles and ROLE_DISPATCHER not in user_roles:
        if order.assigned_to != user["sub"]:
            raise HTTPException(status_code=http_status.HTTP_404_NOT_FOUND, detail="order not found")
    return order
