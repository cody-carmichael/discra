import math
import os
from abc import ABC, abstractmethod
from dataclasses import dataclass
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


_IN_MEMORY_ROUTE_MATRIX_PROVIDER = InMemoryRouteMatrixProvider()


def get_route_matrix_provider() -> RouteMatrixProvider:
    force_memory = _as_bool(os.environ.get("USE_IN_MEMORY_ROUTE_MATRIX"), default=False)
    if force_memory:
        return _IN_MEMORY_ROUTE_MATRIX_PROVIDER

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


def solve_open_route(duration_seconds: List[List[float]], start_index: int = 0) -> List[int]:
    if pywrapcp is None or routing_enums_pb2 is None:
        raise RuntimeError("OR-Tools is not installed")

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
