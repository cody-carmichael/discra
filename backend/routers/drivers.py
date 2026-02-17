from datetime import timedelta
from typing import List

from fastapi import APIRouter, Depends, Query

try:
    from backend.auth import ROLE_ADMIN, ROLE_DISPATCHER, ROLE_DRIVER, require_roles
    from backend.location_service import build_driver_location_record, get_driver_location_store, utc_now
    from backend.schemas import DriverLocationRecord, LocationUpdate
except ModuleNotFoundError:  # local run from backend/ directory
    from auth import ROLE_ADMIN, ROLE_DISPATCHER, ROLE_DRIVER, require_roles
    from location_service import build_driver_location_record, get_driver_location_store, utc_now
    from schemas import DriverLocationRecord, LocationUpdate

router = APIRouter(prefix="/drivers", tags=["drivers"])


@router.post("/location", response_model=DriverLocationRecord)
async def upsert_driver_location(
    payload: LocationUpdate,
    user=Depends(require_roles([ROLE_DRIVER])),
    location_store=Depends(get_driver_location_store),
):
    record = build_driver_location_record(
        org_id=user["org_id"],
        driver_id=user["sub"],
        payload=payload,
    )
    return location_store.upsert_location(record)


@router.get("", response_model=List[DriverLocationRecord])
async def list_active_driver_locations(
    active_minutes: int = Query(default=30, ge=1, le=1440),
    user=Depends(require_roles([ROLE_ADMIN, ROLE_DISPATCHER])),
    location_store=Depends(get_driver_location_store),
):
    cutoff = utc_now() - timedelta(minutes=active_minutes)
    locations = location_store.list_locations(org_id=user["org_id"])
    active = [item for item in locations if item.timestamp >= cutoff]
    return sorted(active, key=lambda item: item.timestamp, reverse=True)
