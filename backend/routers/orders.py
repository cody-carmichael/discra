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
    from backend.order_store import get_order_store
    from backend.schemas import AssignRequest, Order, OrderCreate, OrderStatus, StatusUpdateRequest
except ModuleNotFoundError:  # local run from backend/ directory
    from auth import ROLE_ADMIN, ROLE_DISPATCHER, ROLE_DRIVER, get_current_user, require_roles
    from order_store import get_order_store
    from schemas import AssignRequest, Order, OrderCreate, OrderStatus, StatusUpdateRequest

router = APIRouter(prefix="/orders", tags=["orders"])

_STATUS_TRANSITIONS: Dict[OrderStatus, Set[OrderStatus]] = {
    OrderStatus.CREATED: {OrderStatus.ASSIGNED, OrderStatus.FAILED},
    OrderStatus.ASSIGNED: {OrderStatus.PICKED_UP, OrderStatus.EN_ROUTE, OrderStatus.DELIVERED, OrderStatus.FAILED},
    OrderStatus.PICKED_UP: {OrderStatus.EN_ROUTE, OrderStatus.DELIVERED, OrderStatus.FAILED},
    OrderStatus.EN_ROUTE: {OrderStatus.DELIVERED, OrderStatus.FAILED},
    OrderStatus.DELIVERED: set(),
    OrderStatus.FAILED: {OrderStatus.ASSIGNED},
}


def get_assigned_orders_for_driver(org_id: str, driver_id: str) -> List[Order]:
    return get_order_store().list_assigned_orders(
        org_id=org_id,
        driver_id=driver_id,
        include_terminal=False,
    )


def _require_tenant_order(order_id: str, org_id: str, order_store=None) -> Order:
    store = order_store or get_order_store()
    order = store.get_order(org_id=org_id, order_id=order_id)
    if not order:
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
    order_store=Depends(get_order_store),
):
    order_id = str(uuid4())
    order = Order(
        id=order_id,
        customer_name=payload.customer_name,
        reference_number=payload.reference_number,
        pick_up_address=payload.pick_up_address,
        delivery=payload.delivery,
        dimensions=payload.dimensions,
        weight=payload.weight,
        phone=payload.phone,
        email=payload.email,
        notes=payload.notes,
        num_packages=payload.num_packages,
        status=OrderStatus.CREATED,
        assigned_to=None,
        created_at=datetime.now(timezone.utc),
        org_id=user["org_id"],
    )
    return order_store.upsert_order(order)


@router.get("/", response_model=List[Order])
async def list_orders(
    status: OrderStatus = None,
    assignedTo: str = None,
    user=Depends(require_roles([ROLE_ADMIN, ROLE_DISPATCHER])),
    order_store=Depends(get_order_store),
):
    results = order_store.list_orders(
        org_id=user["org_id"],
        status=status,
        assigned_to=assignedTo,
    )
    return sorted(results, key=lambda order: order.created_at)


@router.post("/{order_id}/assign", response_model=Order)
async def assign_order(
    order_id: str,
    body: AssignRequest,
    user=Depends(require_roles([ROLE_ADMIN, ROLE_DISPATCHER])),
    order_store=Depends(get_order_store),
):
    order = _require_tenant_order(order_id, user["org_id"], order_store=order_store)
    order.assigned_to = body.driver_id
    order.status = OrderStatus.ASSIGNED
    return order_store.upsert_order(order)


@router.post("/{order_id}/unassign", response_model=Order)
async def unassign_order(
    order_id: str,
    user=Depends(require_roles([ROLE_ADMIN, ROLE_DISPATCHER])),
    order_store=Depends(get_order_store),
):
    order = _require_tenant_order(order_id, user["org_id"], order_store=order_store)
    order.assigned_to = None
    order.status = OrderStatus.CREATED
    return order_store.upsert_order(order)


@router.post("/{order_id}/status", response_model=Order)
async def update_order_status(
    order_id: str,
    body: StatusUpdateRequest,
    user=Depends(get_current_user),
    order_store=Depends(get_order_store),
):
    order = _require_tenant_order(order_id, user["org_id"], order_store=order_store)

    if _has_any_role(user, {ROLE_DRIVER}) and not _has_any_role(user, {ROLE_ADMIN, ROLE_DISPATCHER}):
        if order.assigned_to != user["sub"]:
            raise HTTPException(
                status_code=http_status.HTTP_403_FORBIDDEN,
                detail="Drivers can only update assigned orders",
            )

    _validate_transition(order.status, body.status)
    order.status = body.status
    return order_store.upsert_order(order)


@router.get("/driver/inbox", response_model=List[Order])
async def driver_inbox(
    user=Depends(require_roles([ROLE_DRIVER])),
    order_store=Depends(get_order_store),
):
    results = order_store.list_assigned_orders(
        org_id=user["org_id"],
        driver_id=user["sub"],
        include_terminal=True,
    )
    return sorted(results, key=lambda order: order.created_at)


@router.get("/{order_id}", response_model=Order)
async def get_order(order_id: str, user=Depends(get_current_user), order_store=Depends(get_order_store)):
    order = _require_tenant_order(order_id, user["org_id"], order_store=order_store)
    user_roles = set(user.get("groups") or [])
    if ROLE_DRIVER in user_roles and ROLE_ADMIN not in user_roles and ROLE_DISPATCHER not in user_roles:
        if order.assigned_to != user["sub"]:
            raise HTTPException(status_code=http_status.HTTP_404_NOT_FOUND, detail="order not found")
    return order
