import json
import math
import os
import urllib.request
from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from typing import List, Optional

try:
    import boto3
except ImportError:  # pragma: no cover - boto3 available in Lambda
    boto3 = None

try:
    from ortools.constraint_solver import pywrapcp, routing_enums_pb2
except ImportError:  # pragma: no cover - installed via requirements
    pywrapcp = None
    routing_enums_pb2 = None


@dataclass
class RouteMatrixResult:
    source: str
    distance_meters: List[List[float]]
    duration_seconds: List[List[float]]


class RouteMatrixProvider(ABC):
    @abstractmethod
    def calculate_matrix(self, points: List[List[float]]) -> RouteMatrixResult:
        raise NotImplementedError


def _as_bool(value: Optional[str], default: bool = False) -> bool:
    if value is None:
        return default
    return value.strip().lower() in {"1", "true", "yes", "on"}


def haversine_meters(a_lat: float, a_lng: float, b_lat: float, b_lng: float) -> float:
    radius = 6371000.0
    phi1 = math.radians(a_lat)
    phi2 = math.radians(b_lat)
    d_phi = math.radians(b_lat - a_lat)
    d_lambda = math.radians(b_lng - a_lng)

    h = (
        math.sin(d_phi / 2.0) ** 2
        + math.cos(phi1) * math.cos(phi2) * math.sin(d_lambda / 2.0) ** 2
    )
    return 2.0 * radius * math.atan2(math.sqrt(h), math.sqrt(1.0 - h))


class InMemoryRouteMatrixProvider(RouteMatrixProvider):
    # Approximate urban speed for development fallback.
    _SPEED_METERS_PER_SECOND = 13.89

    def calculate_matrix(self, points: List[List[float]]) -> RouteMatrixResult:
        distance = []
        duration = []
        for i, origin in enumerate(points):
            d_row = []
            t_row = []
            for j, destination in enumerate(points):
                if i == j:
                    d_row.append(0.0)
                    t_row.append(0.0)
                else:
                    meters = haversine_meters(origin[1], origin[0], destination[1], destination[0])
                    d_row.append(meters)
                    t_row.append(meters / self._SPEED_METERS_PER_SECOND)
            distance.append(d_row)
            duration.append(t_row)
        return RouteMatrixResult(
            source="haversine-dev",
            distance_meters=distance,
            duration_seconds=duration,
        )


class AmazonLocationRouteMatrixProvider(RouteMatrixProvider):
    def __init__(self, calculator_name: str):
        if boto3 is None:
            raise RuntimeError("boto3 not available")
        self.calculator_name = calculator_name
        self.client = boto3.client("location")

    def calculate_matrix(self, points: List[List[float]]) -> RouteMatrixResult:
        response = self.client.calculate_route_matrix(
            CalculatorName=self.calculator_name,
            DeparturePositions=points,
            DestinationPositions=points,
            TravelMode="Car",
            DistanceUnit="Meters",
            DepartNow=True,
        )
        matrix = response.get("RouteMatrix", [])
        distance = []
        duration = []
        for row in matrix:
            d_row = []
            t_row = []
            for cell in row:
                if "Error" in cell:
                    d_row.append(1e9)
                    t_row.append(1e9)
                else:
                    d_row.append(float(cell.get("Distance", 0.0)))
                    t_row.append(float(cell.get("DurationSeconds", 0.0)))
            distance.append(d_row)
            duration.append(t_row)
        return RouteMatrixResult(
            source="amazon-location",
            distance_meters=distance,
            duration_seconds=duration,
        )


@dataclass
class OrsDirectionsResult:
    """Result from an ORS directions call with route geometry."""
    coordinates: List[List[float]] = field(default_factory=list)  # [[lng, lat], ...]
    distance_meters: float = 0.0
    duration_seconds: float = 0.0
    bbox: Optional[List[float]] = None


class OpenRouteServiceProvider(RouteMatrixProvider):
    """Uses the OpenRouteService /v2/matrix and /v2/directions APIs."""

    _BASE_URL = "https://api.openrouteservice.org"

    def __init__(self, api_key: str):
        self.api_key = api_key

    def _ors_request(self, path: str, body: dict) -> dict:
        data = json.dumps(body).encode("utf-8")
        req = urllib.request.Request(
            self._BASE_URL + path,
            data=data,
            headers={
                "Authorization": self.api_key,
                "Content-Type": "application/json",
                "Accept": "application/json",
            },
            method="POST",
        )
        with urllib.request.urlopen(req, timeout=15) as resp:
            return json.loads(resp.read().decode("utf-8"))

    def calculate_matrix(self, points: List[List[float]]) -> RouteMatrixResult:
        """Call ORS /v2/matrix/driving-car for an NxN time/distance matrix."""
        body = {
            "locations": points,
            "metrics": ["distance", "duration"],
            "units": "m",
        }
        result = self._ors_request("/v2/matrix/driving-car", body)
        return RouteMatrixResult(
            source="openrouteservice",
            distance_meters=result.get("distances", []),
            duration_seconds=result.get("durations", []),
        )

    def get_directions(
        self,
        coordinates: List[List[float]],
    ) -> OrsDirectionsResult:
        """Call ORS /v2/directions/driving-car for a route with geometry.

        coordinates: list of [lng, lat] pairs in order of visit.
        """
        body = {
            "coordinates": coordinates,
            "geometry": True,
            "format": "geojson",
        }
        result = self._ors_request("/v2/directions/driving-car/geojson", body)
        features = result.get("features", [])
        if not features:
            return OrsDirectionsResult()

        feature = features[0]
        geometry = feature.get("geometry", {})
        props = feature.get("properties", {}).get("summary", {})
        return OrsDirectionsResult(
            coordinates=geometry.get("coordinates", []),
            distance_meters=props.get("distance", 0.0),
            duration_seconds=props.get("duration", 0.0),
            bbox=result.get("bbox"),
        )


def get_ors_provider() -> Optional[OpenRouteServiceProvider]:
    """Return an ORS provider if API key is configured, else None."""
    api_key = os.environ.get("ORS_API_KEY", "").strip()
    if not api_key:
        return None
    return OpenRouteServiceProvider(api_key=api_key)


_IN_MEMORY_ROUTE_MATRIX_PROVIDER = InMemoryRouteMatrixProvider()


def get_route_matrix_provider() -> RouteMatrixProvider:
    force_memory = _as_bool(os.environ.get("USE_IN_MEMORY_ROUTE_MATRIX"), default=False)
    if force_memory:
        return _IN_MEMORY_ROUTE_MATRIX_PROVIDER

    # Prefer ORS when configured.
    ors = get_ors_provider()
    if ors is not None:
        return ors

    calculator_name = os.environ.get("LOCATION_ROUTE_CALCULATOR_NAME", "").strip()
    if calculator_name:
        try:
            return AmazonLocationRouteMatrixProvider(calculator_name=calculator_name)
        except Exception:
            return _IN_MEMORY_ROUTE_MATRIX_PROVIDER
    return _IN_MEMORY_ROUTE_MATRIX_PROVIDER


def _optimization_timeout_seconds() -> int:
    configured = os.environ.get("ROUTE_OPTIMIZATION_TIMEOUT_SECONDS")
    if not configured:
        return 5
    try:
        timeout = int(configured)
    except ValueError:
        return 5
    return max(1, min(timeout, 30))


def solve_nearest_neighbor(duration_seconds: List[List[float]], start_index: int = 0) -> List[int]:
    """Greedy nearest-neighbor heuristic — no external dependencies."""
    n = len(duration_seconds)
    if n == 0:
        return []
    if n == 1:
        return [0]
    visited = {start_index}
    sequence = [start_index]
    current = start_index
    while len(visited) < n:
        best_next = -1
        best_cost = float("inf")
        for j in range(n):
            if j not in visited and duration_seconds[current][j] < best_cost:
                best_cost = duration_seconds[current][j]
                best_next = j
        if best_next < 0:
            break
        visited.add(best_next)
        sequence.append(best_next)
        current = best_next
    return sequence


def solve_open_route(duration_seconds: List[List[float]], start_index: int = 0) -> List[int]:
    if pywrapcp is None or routing_enums_pb2 is None:
        return solve_nearest_neighbor(duration_seconds, start_index)

    node_count = len(duration_seconds)
    if node_count == 0:
        return []
    if node_count == 1:
        return [0]

    # Add a virtual end node so we can compute an open route (no forced return).
    end_node = node_count
    matrix = [[0 for _ in range(node_count + 1)] for _ in range(node_count + 1)]
    very_large_cost = 10**9
    for i in range(node_count):
        for j in range(node_count):
            matrix[i][j] = int(duration_seconds[i][j])
        matrix[i][end_node] = 0
    for j in range(node_count):
        matrix[end_node][j] = very_large_cost
    matrix[end_node][end_node] = 0

    manager = pywrapcp.RoutingIndexManager(node_count + 1, 1, [start_index], [end_node])
    routing = pywrapcp.RoutingModel(manager)

    def transit_callback(from_index, to_index):
        from_node = manager.IndexToNode(from_index)
        to_node = manager.IndexToNode(to_index)
        return matrix[from_node][to_node]

    callback_index = routing.RegisterTransitCallback(transit_callback)
    routing.SetArcCostEvaluatorOfAllVehicles(callback_index)

    search_params = pywrapcp.DefaultRoutingSearchParameters()
    search_params.first_solution_strategy = routing_enums_pb2.FirstSolutionStrategy.PATH_CHEAPEST_ARC
    search_params.local_search_metaheuristic = routing_enums_pb2.LocalSearchMetaheuristic.GUIDED_LOCAL_SEARCH
    search_params.time_limit.seconds = _optimization_timeout_seconds()

    solution = routing.SolveWithParameters(search_params)
    if solution is None:
        raise RuntimeError("Unable to solve route optimization problem")

    sequence = []
    current = routing.Start(0)
    while not routing.IsEnd(current):
        node = manager.IndexToNode(current)
        if node != end_node:
            sequence.append(node)
        current = solution.Value(routing.NextVar(current))
    return sequence
