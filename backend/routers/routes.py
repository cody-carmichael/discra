from typing import List, Optional, Tuple

from fastapi import APIRouter, Depends, HTTPException, status as http_status

try:
    from backend.auth import ROLE_ADMIN, ROLE_DISPATCHER, ROLE_DRIVER, require_roles
    from backend.geocode_service import get_address_geocoder
    from backend.location_service import get_driver_location_store
    from backend.route_service import get_ors_provider, get_route_matrix_provider, haversine_meters, solve_open_route
    from backend.routers.orders import get_assigned_orders_for_driver
    from backend.schemas import (
        RouteDirectionsRequest,
        RouteDirectionsResponse,
        RouteNavigateRequest,
        RouteNavigateResponse,
        RouteOptimizeRequest,
        RouteOptimizeResponse,
        RouteOptimizedStop,
        RouteStopInput,
    )
except ModuleNotFoundError:  # local run from backend/ directory
    from auth import ROLE_ADMIN, ROLE_DISPATCHER, ROLE_DRIVER, require_roles
    from geocode_service import get_address_geocoder
    from location_service import get_driver_location_store
    from route_service import get_ors_provider, get_route_matrix_provider, haversine_meters, solve_open_route
    from routers.orders import get_assigned_orders_for_driver
    from schemas import (
        RouteDirectionsRequest,
        RouteDirectionsResponse,
        RouteNavigateRequest,
        RouteNavigateResponse,
        RouteOptimizeRequest,
        RouteOptimizeResponse,
        RouteOptimizedStop,
        RouteStopInput,
    )

router = APIRouter(prefix="/routes", tags=["routes"])


def _stops_from_assigned_orders(org_id: str, driver_id: str) -> List[RouteStopInput]:
    assigned = get_assigned_orders_for_driver(org_id=org_id, driver_id=driver_id)
    if not assigned:
        raise HTTPException(
            status_code=http_status.HTTP_400_BAD_REQUEST,
            detail="No assigned orders found for driver",
        )

    geocoder = get_address_geocoder()
    geocode_cache = {}
    unresolved_order_ids = []
    stops = []

    for order in assigned:
        delivery = ", ".join(filter(None, [
            getattr(order, "delivery_street", "") or "",
            getattr(order, "delivery_city", "") or "",
            getattr(order, "delivery_state", "") or "",
            getattr(order, "delivery_zip", "") or "",
        ])).strip()
        if not delivery:
            unresolved_order_ids.append(order.id)
            continue

        if delivery in geocode_cache:
            point = geocode_cache[delivery]
        else:
            point = geocoder.geocode(delivery)
            geocode_cache[delivery] = point

        if point is None:
            unresolved_order_ids.append(order.id)
            continue

        stops.append(
            RouteStopInput(
                order_id=order.id,
                lat=point.lat,
                lng=point.lng,
                address=delivery,
            )
        )

    if unresolved_order_ids:
        raise HTTPException(
            status_code=http_status.HTTP_400_BAD_REQUEST,
            detail=(
                "Unable to geocode delivery addresses for assigned orders: "
                + ", ".join(unresolved_order_ids)
            ),
        )

    return stops


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
    user=Depends(require_roles([ROLE_ADMIN, ROLE_DISPATCHER, ROLE_DRIVER])),
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


@router.post("/directions", response_model=RouteDirectionsResponse)
async def get_route_directions(
    payload: RouteDirectionsRequest,
    user=Depends(require_roles([ROLE_ADMIN, ROLE_DISPATCHER, ROLE_DRIVER])),
):
    """Get driving directions with a GeoJSON polyline for a driver's optimized route.

    Uses OpenRouteService when configured; otherwise returns a straight-line
    fallback connecting the stops in optimized order.
    """
    # Resolve stops from payload or assigned orders.
    stops = payload.stops or _stops_from_assigned_orders(
        org_id=user["org_id"],
        driver_id=payload.driver_id,
    )
    if not stops:
        raise HTTPException(
            status_code=http_status.HTTP_400_BAD_REQUEST,
            detail="At least one stop is required",
        )

    start_lat, start_lng = _resolve_start_position(
        org_id=user["org_id"],
        driver_id=payload.driver_id,
        stops=stops,
        start_lat=payload.start_lat,
        start_lng=payload.start_lng,
    )

    # Optimize stop order using matrix provider.
    matrix_points = [[start_lng, start_lat]] + [[s.lng, s.lat] for s in stops]
    matrix_provider = get_route_matrix_provider()
    matrix = matrix_provider.calculate_matrix(matrix_points)

    ordered_stops = []
    total_distance = 0.0
    total_duration = 0.0

    if len(stops) == 1:
        # Single stop — no optimization needed.
        stop = stops[0]
        distance = float(matrix.distance_meters[0][1]) if len(matrix.distance_meters) > 1 else 0.0
        duration = float(matrix.duration_seconds[0][1]) if len(matrix.duration_seconds) > 1 else 0.0
        total_distance = distance
        total_duration = duration
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
    else:
        route_node_sequence = solve_open_route(matrix.duration_seconds, start_index=0)
        previous_node = route_node_sequence[0] if route_node_sequence else 0
        for node in route_node_sequence:
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

    # Build coordinate sequence: start → ordered stops.
    waypoints = [[start_lng, start_lat]] + [[s.lng, s.lat] for s in ordered_stops]

    # Try ORS directions for real road geometry.
    ors = get_ors_provider()
    if ors is not None and len(waypoints) >= 2:
        try:
            directions = ors.get_directions(waypoints)
            return RouteDirectionsResponse(
                coordinates=directions.coordinates,
                distance_meters=round(directions.distance_meters, 2),
                duration_seconds=round(directions.duration_seconds, 2),
                bbox=directions.bbox,
                ordered_stops=ordered_stops,
            )
        except Exception:
            pass  # Fall through to straight-line fallback.

    # Straight-line fallback when ORS is unavailable.
    return RouteDirectionsResponse(
        coordinates=waypoints,
        distance_meters=round(total_distance, 2),
        duration_seconds=round(total_duration, 2),
        bbox=None,
        ordered_stops=ordered_stops,
    )


@router.post("/navigate", response_model=RouteNavigateResponse)
async def navigate_to_point(
    payload: RouteNavigateRequest,
    user=Depends(require_roles([ROLE_ADMIN, ROLE_DISPATCHER, ROLE_DRIVER])),
):
    """Get driving directions from point A to point B."""
    start = [payload.start_lng, payload.start_lat]
    dest = [payload.dest_lng, payload.dest_lat]

    ors = get_ors_provider()
    if ors is not None:
        try:
            directions = ors.get_directions([start, dest])
            return RouteNavigateResponse(
                coordinates=directions.coordinates,
                distance_meters=round(directions.distance_meters, 2),
                duration_seconds=round(directions.duration_seconds, 2),
                bbox=directions.bbox,
                steps=[
                    {"instruction": s.instruction, "distance_meters": round(s.distance_meters, 2), "duration_seconds": round(s.duration_seconds, 2), "type": s.type}
                    for s in directions.steps
                ],
            )
        except Exception:
            pass

    # Straight-line fallback
    dist = haversine_meters(payload.start_lat, payload.start_lng, payload.dest_lat, payload.dest_lng)
    return RouteNavigateResponse(
        coordinates=[start, dest],
        distance_meters=round(dist, 2),
        duration_seconds=round(dist / 13.89, 2),
        bbox=None,
        steps=[],
    )
