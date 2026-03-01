from datetime import datetime, timezone
from typing import Dict, List, Set
from uuid import uuid4

from fastapi import APIRouter, Depends, HTTPException, Request, status as http_status

try:
    from backend.auth import (
        ROLE_ADMIN,
        ROLE_DISPATCHER,
        ROLE_DRIVER,
        get_current_user,
        require_roles,
    )
    from backend.audit_store import get_audit_log_store, new_event_id
    from backend.order_store import get_order_store
    from backend.schemas import (
        AuditLogRecord,
        AssignRequest,
        BulkAssignRequest,
        BulkOrderMutationResponse,
        BulkUnassignRequest,
        Order,
        OrderCreate,
        OrderStatus,
        StatusUpdateRequest,
    )
except ModuleNotFoundError:  # local run from backend/ directory
    from auth import ROLE_ADMIN, ROLE_DISPATCHER, ROLE_DRIVER, get_current_user, require_roles
    from audit_store import get_audit_log_store, new_event_id
    from order_store import get_order_store
    from schemas import (
        AuditLogRecord,
        AssignRequest,
        BulkAssignRequest,
        BulkOrderMutationResponse,
        BulkUnassignRequest,
        Order,
        OrderCreate,
        OrderStatus,
        StatusUpdateRequest,
    )

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


def _request_id(request: Request):
    request_id = getattr(getattr(request, "state", object()), "request_id", None)
    if request_id:
        return str(request_id)
    return request.headers.get("x-correlation-id") or request.headers.get("x-request-id")


def _unique_order_ids(order_ids: List[str]) -> List[str]:
    unique_ids = []
    seen = set()
    for raw_id in order_ids:
        order_id = (raw_id or "").strip()
        if not order_id or order_id in seen:
            continue
        seen.add(order_id)
        unique_ids.append(order_id)
    if not unique_ids:
        raise HTTPException(
            status_code=http_status.HTTP_400_BAD_REQUEST,
            detail="At least one valid order_id is required",
        )
    return unique_ids


def _audit_event(
    audit_store,
    *,
    org_id: str,
    action: str,
    actor_id: str,
    actor_roles,
    target_type: str,
    target_id: str,
    request: Request,
    details: Dict,
):
    now = datetime.now(timezone.utc)
    event = AuditLogRecord(
        org_id=org_id,
        event_id=new_event_id(now),
        action=action,
        actor_id=actor_id,
        actor_roles=list(actor_roles or []),
        target_type=target_type,
        target_id=target_id,
        request_id=_request_id(request),
        details=details,
        created_at=now,
    )
    audit_store.put_event(event)


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
        time_window_start=payload.time_window_start,
        time_window_end=payload.time_window_end,
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
    request: Request,
    user=Depends(require_roles([ROLE_ADMIN, ROLE_DISPATCHER])),
    order_store=Depends(get_order_store),
    audit_store=Depends(get_audit_log_store),
):
    order = _require_tenant_order(order_id, user["org_id"], order_store=order_store)
    previous_assigned_to = order.assigned_to
    order.assigned_to = body.driver_id
    order.status = OrderStatus.ASSIGNED
    saved = order_store.upsert_order(order)

    action = "order.reassigned" if previous_assigned_to and previous_assigned_to != body.driver_id else "order.assigned"
    _audit_event(
        audit_store,
        org_id=user["org_id"],
        action=action,
        actor_id=user.get("sub"),
        actor_roles=user.get("groups") or [],
        target_type="order",
        target_id=saved.id,
        request=request,
        details={
            "previous_driver_id": previous_assigned_to,
            "new_driver_id": body.driver_id,
            "status": saved.status.value,
        },
    )
    return saved


@router.post("/{order_id}/unassign", response_model=Order)
async def unassign_order(
    order_id: str,
    request: Request,
    user=Depends(require_roles([ROLE_ADMIN, ROLE_DISPATCHER])),
    order_store=Depends(get_order_store),
    audit_store=Depends(get_audit_log_store),
):
    order = _require_tenant_order(order_id, user["org_id"], order_store=order_store)
    previous_assigned_to = order.assigned_to
    order.assigned_to = None
    order.status = OrderStatus.CREATED
    saved = order_store.upsert_order(order)
    _audit_event(
        audit_store,
        org_id=user["org_id"],
        action="order.unassigned",
        actor_id=user.get("sub"),
        actor_roles=user.get("groups") or [],
        target_type="order",
        target_id=saved.id,
        request=request,
        details={
            "previous_driver_id": previous_assigned_to,
            "status": saved.status.value,
        },
    )
    return saved


@router.post("/bulk-assign", response_model=BulkOrderMutationResponse)
async def bulk_assign_orders(
    body: BulkAssignRequest,
    request: Request,
    user=Depends(require_roles([ROLE_ADMIN, ROLE_DISPATCHER])),
    order_store=Depends(get_order_store),
    audit_store=Depends(get_audit_log_store),
):
    unique_order_ids = _unique_order_ids(body.order_ids)
    driver_id = body.driver_id.strip()
    if not driver_id:
        raise HTTPException(
            status_code=http_status.HTTP_400_BAD_REQUEST,
            detail="driver_id is required",
        )

    updated_ids = []
    for order_id in unique_order_ids:
        order = _require_tenant_order(order_id, user["org_id"], order_store=order_store)
        order.assigned_to = driver_id
        order.status = OrderStatus.ASSIGNED
        order_store.upsert_order(order)
        updated_ids.append(order.id)

    _audit_event(
        audit_store,
        org_id=user["org_id"],
        action="order.bulk_assigned",
        actor_id=user.get("sub"),
        actor_roles=user.get("groups") or [],
        target_type="orders",
        target_id="bulk",
        request=request,
        details={
            "updated": len(updated_ids),
            "driver_id": driver_id,
            "order_ids": updated_ids,
            "status": OrderStatus.ASSIGNED.value,
        },
    )
    return BulkOrderMutationResponse(updated=len(updated_ids), order_ids=updated_ids)


@router.post("/bulk-unassign", response_model=BulkOrderMutationResponse)
async def bulk_unassign_orders(
    body: BulkUnassignRequest,
    request: Request,
    user=Depends(require_roles([ROLE_ADMIN, ROLE_DISPATCHER])),
    order_store=Depends(get_order_store),
    audit_store=Depends(get_audit_log_store),
):
    unique_order_ids = _unique_order_ids(body.order_ids)

    updated_ids = []
    for order_id in unique_order_ids:
        order = _require_tenant_order(order_id, user["org_id"], order_store=order_store)
        order.assigned_to = None
        order.status = OrderStatus.CREATED
        order_store.upsert_order(order)
        updated_ids.append(order.id)

    _audit_event(
        audit_store,
        org_id=user["org_id"],
        action="order.bulk_unassigned",
        actor_id=user.get("sub"),
        actor_roles=user.get("groups") or [],
        target_type="orders",
        target_id="bulk",
        request=request,
        details={
            "updated": len(updated_ids),
            "order_ids": updated_ids,
            "status": OrderStatus.CREATED.value,
        },
    )
    return BulkOrderMutationResponse(updated=len(updated_ids), order_ids=updated_ids)


@router.post("/{order_id}/status", response_model=Order)
async def update_order_status(
    order_id: str,
    body: StatusUpdateRequest,
    user=Depends(require_roles([ROLE_ADMIN, ROLE_DISPATCHER, ROLE_DRIVER])),
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
async def get_order(
    order_id: str,
    user=Depends(require_roles([ROLE_ADMIN, ROLE_DISPATCHER, ROLE_DRIVER])),
    order_store=Depends(get_order_store),
):
    order = _require_tenant_order(order_id, user["org_id"], order_store=order_store)
    user_roles = set(user.get("groups") or [])
    if ROLE_DRIVER in user_roles and ROLE_ADMIN not in user_roles and ROLE_DISPATCHER not in user_roles:
        if order.assigned_to != user["sub"]:
            raise HTTPException(status_code=http_status.HTTP_404_NOT_FOUND, detail="order not found")
    return order
