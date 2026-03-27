from datetime import timedelta
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, Depends, Query
from pydantic import BaseModel

try:
    from backend.auth import ROLE_ADMIN, ROLE_DISPATCHER, ROLE_DRIVER, require_roles
    from backend.location_service import build_driver_location_record, get_driver_location_store, utc_now
    from backend.repositories import get_identity_repository
    from backend.schemas import DriverLocationRecord, LocationUpdate, UserRecord
except ModuleNotFoundError:  # local run from backend/ directory
    from auth import ROLE_ADMIN, ROLE_DISPATCHER, ROLE_DRIVER, require_roles
    from location_service import build_driver_location_record, get_driver_location_store, utc_now
    from repositories import get_identity_repository
    from schemas import DriverLocationRecord, LocationUpdate, UserRecord

router = APIRouter(prefix="/drivers", tags=["drivers"])


class DriverRosterEntry(BaseModel):
    user_id: str
    username: Optional[str] = None
    email: Optional[str] = None
    phone: Optional[str] = None
    photo_url: Optional[str] = None
    tsa_certified: bool = False
    is_online: bool = False
    lat: Optional[float] = None
    lng: Optional[float] = None
    heading: Optional[float] = None
    last_seen: Optional[str] = None


@router.post("/location", response_model=DriverLocationRecord)
async def upsert_driver_location(
    payload: LocationUpdate,
    user=Depends(require_roles([ROLE_ADMIN, ROLE_DISPATCHER, ROLE_DRIVER])),
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


@router.get("/roster", response_model=List[DriverRosterEntry])
async def list_driver_roster(
    active_minutes: int = Query(default=30, ge=1, le=1440),
    user=Depends(require_roles([ROLE_ADMIN, ROLE_DISPATCHER])),
    location_store=Depends(get_driver_location_store),
    repo=Depends(get_identity_repository),
):
    """Return all drivers with online/offline status."""
    cutoff = utc_now() - timedelta(minutes=active_minutes)
    locations = location_store.list_locations(org_id=user["org_id"])
    loc_by_driver: Dict[str, DriverLocationRecord] = {}
    for loc in locations:
        loc_by_driver[loc.driver_id] = loc

    all_users = repo.list_users(user["org_id"])
    driver_users = [u for u in all_users if u.is_active and ROLE_DRIVER in (u.roles or [])]

    # Also include Admin/Dispatcher users who have shared location
    non_driver_ids = {u.user_id for u in driver_users}
    for uid, loc in loc_by_driver.items():
        if uid not in non_driver_ids:
            matching = [u for u in all_users if u.user_id == uid and u.is_active]
            if matching:
                driver_users.append(matching[0])

    roster: List[DriverRosterEntry] = []
    for u in driver_users:
        loc = loc_by_driver.get(u.user_id)
        is_online = loc is not None and loc.timestamp >= cutoff
        entry = DriverRosterEntry(
            user_id=u.user_id,
            username=u.username,
            email=u.email,
            phone=getattr(u, "phone", None),
            photo_url=getattr(u, "photo_url", None),
            tsa_certified=getattr(u, "tsa_certified", False),
            is_online=is_online,
            lat=loc.lat if loc else None,
            lng=loc.lng if loc else None,
            heading=loc.heading if loc else None,
            last_seen=loc.timestamp.isoformat() if loc else None,
        )
        roster.append(entry)

    # Online first, then offline, each sorted by name
    roster.sort(key=lambda e: (not e.is_online, (e.username or e.user_id).lower()))
    return roster
