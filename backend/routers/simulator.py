"""HTTP control surface for the in-process dispatch simulator.

Restricted to a small allow-list of usernames (dev tool, not for general
admin use). Add usernames via SIMULATOR_ALLOWED_USERNAMES env var
(comma-separated). Defaults to {"cody.carmichael"}.
"""

from __future__ import annotations

import os
from typing import List, Optional

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, Field

try:
    from backend.auth import ROLE_ADMIN, ROLE_DISPATCHER, require_roles
    from backend.simulator_service import AREAS, get_simulator, seed_orders
except ModuleNotFoundError:  # local run from backend/ directory
    from auth import ROLE_ADMIN, ROLE_DISPATCHER, require_roles  # type: ignore
    from simulator_service import AREAS, get_simulator, seed_orders  # type: ignore


router = APIRouter(prefix="/admin/simulator", tags=["simulator"])


def _allowed_usernames() -> set[str]:
    raw = os.environ.get("SIMULATOR_ALLOWED_USERNAMES", "").strip()
    if not raw:
        return {"cody.carmichael"}
    return {u.strip().lower() for u in raw.split(",") if u.strip()}


def _ensure_allowed(user: dict) -> None:
    allowed = _allowed_usernames()
    candidates = {
        str(user.get("username") or "").strip().lower(),
        str(user.get("email") or "").strip().lower().split("@")[0],
        str(user.get("sub") or "").strip().lower(),
    }
    if not (candidates & allowed):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="simulator is not enabled for this account",
        )


class SpawnRequest(BaseModel):
    count: int = Field(default=5, ge=1, le=20)
    area: str = Field(default="fortworth")
    interval_sec: float = Field(default=5.0, ge=2.0, le=60.0)
    speed_mph: float = Field(default=30.0, ge=1.0, le=120.0)


class DriverSnapshot(BaseModel):
    id: str
    name: str
    lat: float
    lng: float
    heading: float
    state: str
    active_order_id: Optional[str] = None


class SimulatorConfig(BaseModel):
    area: str
    interval_sec: float
    speed_mph: float


class SimulatorStatus(BaseModel):
    running: bool
    update_count: int
    config: Optional[SimulatorConfig] = None
    drivers: List[DriverSnapshot] = Field(default_factory=list)


@router.post("/spawn", response_model=SimulatorStatus)
async def spawn(
    payload: SpawnRequest,
    user=Depends(require_roles([ROLE_ADMIN, ROLE_DISPATCHER])),
):
    _ensure_allowed(user)
    if payload.area not in AREAS:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"unknown area '{payload.area}'",
        )
    sim = get_simulator()
    return await sim.spawn(
        org_id=user["org_id"],
        count=payload.count,
        area_key=payload.area,
        interval_sec=payload.interval_sec,
        speed_mph=payload.speed_mph,
    )


@router.post("/stop", response_model=SimulatorStatus)
async def stop(user=Depends(require_roles([ROLE_ADMIN, ROLE_DISPATCHER]))):
    _ensure_allowed(user)
    sim = get_simulator()
    return await sim.stop()


@router.get("/status", response_model=SimulatorStatus)
async def get_status(user=Depends(require_roles([ROLE_ADMIN, ROLE_DISPATCHER]))):
    _ensure_allowed(user)
    return get_simulator().status()


class SeedOrdersRequest(BaseModel):
    count: int = Field(default=5, ge=1, le=20)
    area: str = Field(default="fortworth")


class SeedOrdersResponse(BaseModel):
    created: int
    order_ids: List[str]


@router.post("/seed-orders", response_model=SeedOrdersResponse)
async def seed_orders_endpoint(
    payload: SeedOrdersRequest,
    user=Depends(require_roles([ROLE_ADMIN, ROLE_DISPATCHER])),
):
    _ensure_allowed(user)
    if payload.area not in AREAS:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"unknown area '{payload.area}'",
        )
    orders = seed_orders(org_id=user["org_id"], area_key=payload.area, count=payload.count)
    return SeedOrdersResponse(
        created=len(orders),
        order_ids=[o.id for o in orders],
    )
