from typing import List, Optional, Tuple

from fastapi import APIRouter, Depends, HTTPException, status as http_status

try:
    from backend.auth import ROLE_ADMIN, ROLE_DISPATCHER, require_roles
    from backend.location_service import get_driver_location_store
    from backend.route_service import get_route_matrix_provider, solve_open_route
    from backend.routers.orders import get_assigned_orders_for_driver
    from backend.schemas import (
        RouteOptimizeRequest,
        RouteOptimizeResponse,
        RouteOptimizedStop,
        RouteStopInput,
    )
except ModuleNotFoundError:  # local run from backend/ directory
    from auth import ROLE_ADMIN, ROLE_DISPATCHER, require_roles
    from location_service import get_driver_location_store
    from route_service import get_route_matrix_provider, solve_open_route
    from routers.orders import get_assigned_orders_for_driver
    from schemas import RouteOptimizeRequest, RouteOptimizeResponse, RouteOptimizedStop, RouteStopInput

router = APIRouter(prefix="/routes", tags=["routes"])


def _stops_from_assigned_orders(org_id: str, driver_id: str) -> List[RouteStopInput]:
    assigned = get_assigned_orders_for_driver(org_id=org_id, driver_id=driver_id)
    if not assigned:
        raise HTTPException(
            status_code=http_status.HTTP_400_BAD_REQUEST,
            detail="No assigned orders found for driver",
        )

    raise HTTPException(
        status_code=http_status.HTTP_400_BAD_REQUEST,
        detail=(
            "Assigned orders no longer store delivery coordinates. "
            "Provide explicit stops with lat/lng in the request payload."
        ),
    )


def _resolve_start_position(
    org_id: str,
    driver_id: str,
    stops: List[RouteStopInput],
    start_lat: Optional[float],
    start_lng: Optional[float],
) -> Tuple[float, float]:
    if start_lat is not None and start_lng is not None:
        return start_lat, start_lng

    location_store = get_driver_location_store()
    driver_locations = location_store.list_locations(org_id=org_id)
    for location in driver_locations:
        if location.driver_id == driver_id:
            return location.lat, location.lng

    if not stops:
        raise HTTPException(status_code=http_status.HTTP_400_BAD_REQUEST, detail="No stops available for optimization")
    return stops[0].lat, stops[0].lng


@router.post("/optimize", response_model=RouteOptimizeResponse)
async def optimize_driver_route(
    payload: RouteOptimizeRequest,
    user=Depends(require_roles([ROLE_ADMIN, ROLE_DISPATCHER])),
):
    stops = payload.stops or _stops_from_assigned_orders(
        org_id=user["org_id"],
        driver_id=payload.driver_id,
    )
    if len(stops) == 0:
        raise HTTPException(status_code=http_status.HTTP_400_BAD_REQUEST, detail="At least one stop is required")

    start_lat, start_lng = _resolve_start_position(
        org_id=user["org_id"],
        driver_id=payload.driver_id,
        stops=stops,
        start_lat=payload.start_lat,
        start_lng=payload.start_lng,
    )

    # Build matrix points as [lng, lat] with an explicit start node at index 0.
    matrix_points = [[start_lng, start_lat]] + [[stop.lng, stop.lat] for stop in stops]
    matrix_provider = get_route_matrix_provider()
    matrix = matrix_provider.calculate_matrix(matrix_points)
    route_node_sequence = solve_open_route(matrix.duration_seconds, start_index=0)

    ordered_stops = []
    total_distance = 0.0
    total_duration = 0.0
    previous_node = route_node_sequence[0] if route_node_sequence else 0

    for sequence_index, node in enumerate(route_node_sequence):
        if node == 0:
            continue
        stop = stops[node - 1]
        distance = float(matrix.distance_meters[previous_node][node])
        duration = float(matrix.duration_seconds[previous_node][node])
        total_distance += distance
        total_duration += duration
        ordered_stops.append(
            RouteOptimizedStop(
                sequence=len(ordered_stops) + 1,
                order_id=stop.order_id,
                lat=stop.lat,
                lng=stop.lng,
                address=stop.address,
                distance_from_previous_meters=distance,
                duration_from_previous_seconds=duration,
            )
        )
        previous_node = node

    if not ordered_stops and stops:
        # Single-stop fallback when solver sequence does not include stop node.
        stop = stops[0]
        distance = float(matrix.distance_meters[0][1]) if len(matrix.distance_meters) > 1 else 0.0
        duration = float(matrix.duration_seconds[0][1]) if len(matrix.duration_seconds) > 1 else 0.0
        ordered_stops.append(
            RouteOptimizedStop(
                sequence=1,
                order_id=stop.order_id,
                lat=stop.lat,
                lng=stop.lng,
                address=stop.address,
                distance_from_previous_meters=distance,
                duration_from_previous_seconds=duration,
            )
        )
        total_distance += distance
        total_duration += duration

    return RouteOptimizeResponse(
        matrix_source=matrix.source,
        total_distance_meters=round(total_distance, 2),
        total_duration_seconds=round(total_duration, 2),
        ordered_stops=ordered_stops,
    )
