"""In-memory dispatch simulator.

Spawns N synthetic drivers in a chosen city area, has them roam by default,
react to order assignments by traveling (OSRM-routed) to pickup → delivery,
and progresses order status on arrival. Drives `location_store` and
`order_store` directly — no HTTP, no auth juggling.

State is process-local: lost on backend restart. That's fine for a dev tool.
"""

from __future__ import annotations

import asyncio
import logging
import math
import random
import time
import uuid
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Dict, List, Optional, Tuple

import requests

try:
    from backend.location_service import build_driver_location_record, get_driver_location_store
    from backend.order_store import get_order_store
    from backend.schemas import LocationUpdate, Order, OrderStatus
except ModuleNotFoundError:  # local run from backend/ directory
    from location_service import build_driver_location_record, get_driver_location_store  # type: ignore
    from order_store import get_order_store  # type: ignore
    from schemas import LocationUpdate, Order, OrderStatus  # type: ignore


logger = logging.getLogger(__name__)

# Tunables
ARRIVAL_THRESHOLD_M = 10.0
MPH_TO_MPS = 0.44704
PHOTON_TIMEOUT_S = 5
OSRM_TIMEOUT_S = 8

AREAS: Dict[str, Dict[str, float]] = {
    "fortworth": {"lat": 32.7555, "lng": -97.3308, "r": 0.08},
    "dallas":    {"lat": 32.7767, "lng": -96.7970, "r": 0.10},
    "austin":    {"lat": 30.2672, "lng": -97.7431, "r": 0.08},
    "houston":   {"lat": 29.7604, "lng": -95.3698, "r": 0.12},
    "nyc":       {"lat": 40.7128, "lng": -74.0060, "r": 0.06},
    "la":        {"lat": 34.0522, "lng": -118.2437, "r": 0.10},
}

DRIVER_NAMES = [
    "Alex Rivera", "Jordan Lee", "Taylor Kim", "Morgan Chen", "Casey Brooks",
    "Riley Thompson", "Avery Garcia", "Quinn Martinez", "Drew Wilson", "Cameron Davis",
    "Skyler Patel", "Dakota Nguyen", "Hayden Lopez", "Parker Adams", "Sawyer Hill",
    "Finley Clark", "Emery Scott", "Reese Baker", "Blake Turner", "Rowan James",
]

# Curated, real-ish addresses per area. They need to geocode through Photon so
# the simulator can plot OSRM routes to them when assigned.
SEED_ADDRESSES: Dict[str, List[Tuple[str, str, str, str]]] = {
    "fortworth": [
        ("100 W Weatherford St", "Fort Worth", "TX", "76102"),
        ("1300 Lancaster Ave", "Fort Worth", "TX", "76102"),
        ("3501 Camp Bowie Blvd", "Fort Worth", "TX", "76107"),
        ("500 Commerce St", "Fort Worth", "TX", "76102"),
        ("4200 South Fwy", "Fort Worth", "TX", "76115"),
        ("2900 W 7th St", "Fort Worth", "TX", "76107"),
        ("1600 Main St", "Fort Worth", "TX", "76164"),
        ("2200 University Dr", "Fort Worth", "TX", "76107"),
    ],
    "dallas": [
        ("411 Elm St", "Dallas", "TX", "75202"),
        ("2401 Victory Park Ln", "Dallas", "TX", "75219"),
        ("3000 Pegasus Park Dr", "Dallas", "TX", "75247"),
        ("8687 N Central Expy", "Dallas", "TX", "75225"),
        ("1717 N Harwood St", "Dallas", "TX", "75201"),
        ("2403 Flora St", "Dallas", "TX", "75201"),
        ("5500 Greenville Ave", "Dallas", "TX", "75206"),
        ("13355 Noel Rd", "Dallas", "TX", "75240"),
    ],
    "austin": [
        ("1100 Congress Ave", "Austin", "TX", "78701"),
        ("2901 S Capital of Texas Hwy", "Austin", "TX", "78746"),
        ("301 W 6th St", "Austin", "TX", "78701"),
        ("2300 Manor Rd", "Austin", "TX", "78722"),
        ("11410 Century Oaks Ter", "Austin", "TX", "78758"),
        ("500 E Cesar Chavez St", "Austin", "TX", "78701"),
        ("4001 N Lamar Blvd", "Austin", "TX", "78756"),
        ("2110 S Lamar Blvd", "Austin", "TX", "78704"),
    ],
    "houston": [
        ("1200 McKinney St", "Houston", "TX", "77010"),
        ("8400 Westpark Dr", "Houston", "TX", "77063"),
        ("5615 Kirby Dr", "Houston", "TX", "77005"),
        ("2727 Allen Pkwy", "Houston", "TX", "77019"),
        ("9999 Bellaire Blvd", "Houston", "TX", "77036"),
        ("4848 Loop Central Dr", "Houston", "TX", "77081"),
        ("1500 Westheimer Rd", "Houston", "TX", "77006"),
        ("11100 Northwest Fwy", "Houston", "TX", "77092"),
    ],
    "nyc": [
        ("350 5th Ave", "New York", "NY", "10118"),
        ("11 Wall St", "New York", "NY", "10005"),
        ("200 Park Ave", "New York", "NY", "10166"),
        ("405 Lexington Ave", "New York", "NY", "10174"),
        ("1 World Trade Center", "New York", "NY", "10007"),
        ("4 Times Sq", "New York", "NY", "10036"),
        ("89 E 42nd St", "New York", "NY", "10017"),
        ("250 Broadway", "New York", "NY", "10007"),
    ],
    "la": [
        ("633 W 5th St", "Los Angeles", "CA", "90071"),
        ("1100 S Hope St", "Los Angeles", "CA", "90015"),
        ("6801 Hollywood Blvd", "Los Angeles", "CA", "90028"),
        ("9876 Wilshire Blvd", "Beverly Hills", "CA", "90210"),
        ("100 Universal City Plaza", "Universal City", "CA", "91608"),
        ("2999 Olympic Blvd", "Santa Monica", "CA", "90404"),
        ("400 World Way", "Los Angeles", "CA", "90045"),
        ("1855 Industrial St", "Los Angeles", "CA", "90021"),
    ],
}

CUSTOMER_NAMES = [
    "Tarrant Logistics", "West 7th Couriers", "Sundance Express",
    "Bluebonnet Freight", "Summit Cargo", "Pioneer Trucking",
    "Lone Star Delivery", "Big D Logistics", "Texas Rush",
    "Ironhorse Hauling", "Compass Couriers", "Crescent Cargo",
    "Vanguard Freight", "Cascade Logistics", "Beacon Delivery",
]


def _haversine_m(lat1: float, lng1: float, lat2: float, lng2: float) -> float:
    R = 6371000.0
    p1 = math.radians(lat1)
    p2 = math.radians(lat2)
    dp = math.radians(lat2 - lat1)
    dl = math.radians(lng2 - lng1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * R * math.atan2(math.sqrt(a), math.sqrt(1 - a))


def _bearing(lat1: float, lng1: float, lat2: float, lng2: float) -> float:
    dl = math.radians(lng2 - lng1)
    y = math.sin(dl) * math.cos(math.radians(lat2))
    x = (
        math.cos(math.radians(lat1)) * math.sin(math.radians(lat2))
        - math.sin(math.radians(lat1)) * math.cos(math.radians(lat2)) * math.cos(dl)
    )
    return (math.degrees(math.atan2(y, x)) + 360) % 360


def _random_in_area(area: Dict[str, float]) -> Tuple[float, float]:
    return (
        area["lat"] + (random.random() - 0.5) * 2 * area["r"],
        area["lng"] + (random.random() - 0.5) * 2 * area["r"],
    )


@dataclass
class _Driver:
    id: str
    name: str
    lat: float
    lng: float
    heading: float = 0.0
    state: str = "roaming"  # "roaming" | "to_pickup" | "to_delivery"
    active_order_id: Optional[str] = None
    route: List[Tuple[float, float]] = field(default_factory=list)
    target: Optional[Tuple[float, float]] = None
    roam_dest: Optional[Tuple[float, float]] = None


@dataclass
class _Config:
    org_id: str
    area_key: str
    interval_sec: float
    speed_mph: float


class _Simulator:
    def __init__(self) -> None:
        self._drivers: Dict[str, _Driver] = {}
        self._config: Optional[_Config] = None
        self._task: Optional[asyncio.Task] = None
        self._lock = asyncio.Lock()
        self._geocode_cache: Dict[str, Optional[Tuple[float, float]]] = {}
        self._update_count = 0

    @property
    def running(self) -> bool:
        return self._task is not None and not self._task.done()

    async def spawn(
        self,
        *,
        org_id: str,
        count: int,
        area_key: str,
        interval_sec: float,
        speed_mph: float,
    ) -> dict:
        async with self._lock:
            await self._stop_locked()
            count = max(1, min(int(count), 20))
            area = AREAS.get(area_key, AREAS["fortworth"])
            self._drivers.clear()
            self._geocode_cache.clear()
            self._update_count = 0
            for i in range(count):
                name = DRIVER_NAMES[i % len(DRIVER_NAMES)]
                slug = name.lower().replace(" ", "-")
                driver_id = f"sim-{slug}-{uuid.uuid4().hex[:6]}"
                lat, lng = _random_in_area(area)
                self._drivers[driver_id] = _Driver(id=driver_id, name=name, lat=lat, lng=lng)
            self._config = _Config(
                org_id=org_id,
                area_key=area_key,
                interval_sec=float(interval_sec),
                speed_mph=float(speed_mph),
            )
            self._task = asyncio.create_task(self._run_loop(), name="simulator-tick-loop")
            logger.info("simulator spawned: org=%s count=%d area=%s", org_id, count, area_key)
            return self._snapshot()

    async def stop(self) -> dict:
        async with self._lock:
            await self._stop_locked()
            return self._snapshot()

    async def _stop_locked(self) -> None:
        if self._task and not self._task.done():
            self._task.cancel()
            try:
                await self._task
            except (asyncio.CancelledError, Exception):
                pass
        self._task = None

    def status(self) -> dict:
        return self._snapshot()

    def _snapshot(self) -> dict:
        cfg = self._config
        return {
            "running": self.running,
            "update_count": self._update_count,
            "config": (
                {
                    "area": cfg.area_key,
                    "interval_sec": cfg.interval_sec,
                    "speed_mph": cfg.speed_mph,
                }
                if cfg
                else None
            ),
            "drivers": [
                {
                    "id": d.id,
                    "name": d.name,
                    "lat": d.lat,
                    "lng": d.lng,
                    "heading": d.heading,
                    "state": d.state,
                    "active_order_id": d.active_order_id,
                }
                for d in self._drivers.values()
            ],
        }

    # ── Tick loop ────────────────────────────────────────────────────────

    async def _run_loop(self) -> None:
        try:
            while True:
                cfg = self._config
                if cfg is None:
                    return
                step_m = cfg.speed_mph * MPH_TO_MPS * cfg.interval_sec
                for driver in list(self._drivers.values()):
                    try:
                        await self._tick_driver(driver, step_m, cfg)
                    except Exception:
                        logger.exception("simulator tick failed for driver %s", driver.id)
                await asyncio.sleep(cfg.interval_sec)
        except asyncio.CancelledError:
            return

    async def _tick_driver(self, driver: _Driver, step_m: float, cfg: _Config) -> None:
        await self._process_dispatch(driver, cfg.org_id)

        if driver.state == "roaming" or not driver.route:
            self._move_roam(driver, step_m, cfg.area_key)
        else:
            self._advance_along_route(driver, step_m)

        await asyncio.to_thread(self._upsert_location, driver, cfg.org_id)
        self._update_count += 1

    @staticmethod
    def _upsert_location(driver: _Driver, org_id: str) -> None:
        store = get_driver_location_store()
        record = build_driver_location_record(
            org_id=org_id,
            driver_id=driver.id,
            payload=LocationUpdate(lat=driver.lat, lng=driver.lng, heading=driver.heading),
        )
        store.upsert_location(record)

    # ── Dispatch state machine ──────────────────────────────────────────

    async def _process_dispatch(self, driver: _Driver, org_id: str) -> None:
        order = await asyncio.to_thread(self._first_active_order, driver.id, org_id)
        if order is None:
            if driver.state != "roaming":
                driver.state = "roaming"
                driver.active_order_id = None
                driver.route = []
                driver.target = None
            return

        pickup = self._pickup_address(order)
        delivery = self._delivery_address(order)

        if order.status == OrderStatus.ASSIGNED:
            if driver.state != "to_pickup" or driver.active_order_id != order.id:
                if not await self._plan_route(driver, pickup):
                    return
                driver.state = "to_pickup"
                driver.active_order_id = order.id
                logger.info("driver %s → pickup for order %s", driver.id, order.id)
            if driver.target and _haversine_m(
                driver.lat, driver.lng, driver.target[0], driver.target[1]
            ) < ARRIVAL_THRESHOLD_M:
                await asyncio.to_thread(self._set_status, order.id, org_id, OrderStatus.PICKED_UP)
                logger.info("driver %s ↑ PickedUp %s", driver.id, order.id)
                if await self._plan_route(driver, delivery):
                    driver.state = "to_delivery"
        elif order.status in (OrderStatus.PICKED_UP, OrderStatus.EN_ROUTE):
            if driver.state != "to_delivery" or driver.active_order_id != order.id:
                if not await self._plan_route(driver, delivery):
                    return
                driver.state = "to_delivery"
                driver.active_order_id = order.id
            if driver.target and _haversine_m(
                driver.lat, driver.lng, driver.target[0], driver.target[1]
            ) < ARRIVAL_THRESHOLD_M:
                await asyncio.to_thread(self._set_status, order.id, org_id, OrderStatus.DELIVERED)
                logger.info("driver %s ✓ Delivered %s", driver.id, order.id)
                driver.state = "roaming"
                driver.active_order_id = None
                driver.route = []
                driver.target = None

    @staticmethod
    def _first_active_order(driver_id: str, org_id: str):
        store = get_order_store()
        orders = store.list_assigned_orders(org_id=org_id, driver_id=driver_id, include_terminal=False)
        if not orders:
            return None
        return sorted(orders, key=lambda o: o.created_at)[0]

    @staticmethod
    def _set_status(order_id: str, org_id: str, status: OrderStatus) -> None:
        store = get_order_store()
        order = store.get_order(org_id, order_id)
        if order is None:
            return
        order.status = status
        store.upsert_order(order)

    @staticmethod
    def _pickup_address(order) -> str:
        parts = [order.pick_up_street, order.pick_up_city, order.pick_up_state, order.pick_up_zip]
        return ", ".join(p for p in parts if p)

    @staticmethod
    def _delivery_address(order) -> str:
        parts = [order.delivery_street, order.delivery_city, order.delivery_state, order.delivery_zip]
        return ", ".join(p for p in parts if p)

    # ── Routing & geocoding ─────────────────────────────────────────────

    async def _plan_route(self, driver: _Driver, address: str) -> bool:
        coord = await self._geocode(address)
        if coord is None:
            return False
        route = await asyncio.to_thread(self._osrm_route, driver.lat, driver.lng, coord[0], coord[1])
        driver.route = route
        driver.target = coord
        return True

    async def _geocode(self, address: str) -> Optional[Tuple[float, float]]:
        key = (address or "").strip().lower()
        if not key:
            return None
        if key in self._geocode_cache:
            return self._geocode_cache[key]
        result = await asyncio.to_thread(self._photon_lookup, address)
        self._geocode_cache[key] = result
        return result

    @staticmethod
    def _photon_lookup(address: str) -> Optional[Tuple[float, float]]:
        try:
            r = requests.get(
                "https://photon.komoot.io/api/",
                params={"q": address, "limit": 1},
                timeout=PHOTON_TIMEOUT_S,
                headers={"User-Agent": "Discra/0.1 (dev simulator)"},
            )
            r.raise_for_status()
            data = r.json()
            features = data.get("features") or []
            if not features:
                return None
            coords = features[0]["geometry"]["coordinates"]
            return (float(coords[1]), float(coords[0]))
        except Exception:
            return None

    @staticmethod
    def _osrm_route(
        from_lat: float,
        from_lng: float,
        to_lat: float,
        to_lng: float,
    ) -> List[Tuple[float, float]]:
        fallback = [(from_lat, from_lng), (to_lat, to_lng)]
        try:
            url = (
                "https://router.project-osrm.org/route/v1/driving/"
                f"{from_lng},{from_lat};{to_lng},{to_lat}"
                "?overview=full&geometries=geojson"
            )
            r = requests.get(url, timeout=OSRM_TIMEOUT_S)
            r.raise_for_status()
            data = r.json()
            if data.get("code") != "Ok" or not data.get("routes"):
                return fallback
            coords = data["routes"][0]["geometry"]["coordinates"]
            return [(float(c[1]), float(c[0])) for c in coords]
        except Exception:
            return fallback

    # ── Movement ────────────────────────────────────────────────────────

    def _advance_along_route(self, driver: _Driver, step_m: float) -> None:
        remaining = step_m
        while remaining > 0 and len(driver.route) >= 2:
            target_lat, target_lng = driver.route[1]
            seg_dist = _haversine_m(driver.lat, driver.lng, target_lat, target_lng)
            if seg_dist < 0.1:
                driver.route.pop(0)
                continue
            if remaining >= seg_dist:
                driver.heading = _bearing(driver.lat, driver.lng, target_lat, target_lng)
                driver.lat = target_lat
                driver.lng = target_lng
                driver.route.pop(0)
                remaining -= seg_dist
            else:
                ratio = remaining / seg_dist
                driver.heading = _bearing(driver.lat, driver.lng, target_lat, target_lng)
                driver.lat = driver.lat + (target_lat - driver.lat) * ratio
                driver.lng = driver.lng + (target_lng - driver.lng) * ratio
                remaining = 0

    def _move_roam(self, driver: _Driver, step_m: float, area_key: str) -> None:
        area = AREAS.get(area_key, AREAS["fortworth"])
        if not driver.roam_dest:
            driver.roam_dest = _random_in_area(area)
        target_lat, target_lng = driver.roam_dest
        dist = _haversine_m(driver.lat, driver.lng, target_lat, target_lng)
        if dist < step_m:
            driver.lat = target_lat
            driver.lng = target_lng
            driver.roam_dest = _random_in_area(area)
            return
        ratio = step_m / dist
        driver.heading = _bearing(driver.lat, driver.lng, target_lat, target_lng)
        driver.lat += (target_lat - driver.lat) * ratio
        driver.lng += (target_lng - driver.lng) * ratio


_simulator: Optional[_Simulator] = None


def get_simulator() -> _Simulator:
    global _simulator
    if _simulator is None:
        _simulator = _Simulator()
    return _simulator


def seed_orders(*, org_id: str, area_key: str, count: int) -> List[Order]:
    """Create N test orders for the given area. Pickup/delivery are different
    addresses drawn from the curated list, so OSRM has something to route to."""
    addrs = SEED_ADDRESSES.get(area_key) or SEED_ADDRESSES["fortworth"]
    if len(addrs) < 2:
        return []
    count = max(1, min(int(count), 20))
    store = get_order_store()
    now = datetime.now(timezone.utc)
    batch = int(time.time())
    created: List[Order] = []
    for i in range(count):
        pu, dr = random.sample(addrs, 2)
        order = Order(
            id=str(uuid.uuid4()),
            customer_name=random.choice(CUSTOMER_NAMES),
            reference_id=f"SIM-{batch}-{i + 1}",
            pick_up_street=pu[0], pick_up_city=pu[1], pick_up_state=pu[2], pick_up_zip=pu[3],
            delivery_street=dr[0], delivery_city=dr[1], delivery_state=dr[2], delivery_zip=dr[3],
            num_packages=1,
            status=OrderStatus.CREATED,
            assigned_to=None,
            created_at=now,
            org_id=org_id,
        )
        store.upsert_order(order)
        created.append(order)
    logger.info("seeded %d test orders for org=%s area=%s", len(created), org_id, area_key)
    return created
