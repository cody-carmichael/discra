import hashlib
import os
import re
from abc import ABC, abstractmethod
from dataclasses import dataclass
from typing import Dict, Optional

try:
    import boto3
except ImportError:  # pragma: no cover - boto3 available in Lambda
    boto3 = None


_LAT_LNG_RE = re.compile(r"^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*$")


@dataclass
class GeocodePoint:
    lat: float
    lng: float
    source: str


class AddressGeocoder(ABC):
    @abstractmethod
    def geocode(self, address: str) -> Optional[GeocodePoint]:
        raise NotImplementedError


def _as_bool(value: Optional[str], default: bool = False) -> bool:
    if value is None:
        return default
    return value.strip().lower() in {"1", "true", "yes", "on"}


def _normalize_address(address: str) -> str:
    return " ".join(address.strip().split()).lower()


def _is_valid_lat_lng(lat: float, lng: float) -> bool:
    return -90.0 <= lat <= 90.0 and -180.0 <= lng <= 180.0


def _parse_inline_lat_lng(address: str) -> Optional[GeocodePoint]:
    match = _LAT_LNG_RE.match(address or "")
    if not match:
        return None
    lat = float(match.group(1))
    lng = float(match.group(2))
    if not _is_valid_lat_lng(lat, lng):
        return None
    return GeocodePoint(lat=lat, lng=lng, source="inline-latlng")


def _hash_to_point(normalized_address: str) -> GeocodePoint:
    digest = hashlib.sha256(normalized_address.encode("utf-8")).digest()
    lat_seed = int.from_bytes(digest[0:4], "big")
    lng_seed = int.from_bytes(digest[4:8], "big")
    lat = 24.5 + (lat_seed / 0xFFFFFFFF) * 24.0
    lng = -124.8 + (lng_seed / 0xFFFFFFFF) * 58.5
    return GeocodePoint(lat=lat, lng=lng, source="hash-dev")


class InMemoryAddressGeocoder(AddressGeocoder):
    def __init__(self):
        self._overrides: Dict[str, GeocodePoint] = {}
        self._failures: Dict[str, bool] = {}

    def geocode(self, address: str) -> Optional[GeocodePoint]:
        if not address or not address.strip():
            return None

        inline = _parse_inline_lat_lng(address)
        if inline:
            return inline

        normalized = _normalize_address(address)
        if normalized in self._failures:
            return None
        if normalized in self._overrides:
            return self._overrides[normalized]
        return _hash_to_point(normalized)

    def set_override(self, address: str, lat: float, lng: float):
        normalized = _normalize_address(address)
        self._overrides[normalized] = GeocodePoint(lat=lat, lng=lng, source="in-memory-override")
        self._failures.pop(normalized, None)

    def set_failure(self, address: str):
        normalized = _normalize_address(address)
        self._failures[normalized] = True
        self._overrides.pop(normalized, None)

    def reset(self):
        self._overrides.clear()
        self._failures.clear()


class AmazonLocationAddressGeocoder(AddressGeocoder):
    def __init__(self, place_index_name: str):
        if boto3 is None:
            raise RuntimeError("boto3 not available")
        self.place_index_name = place_index_name
        self.client = boto3.client("location")

    def geocode(self, address: str) -> Optional[GeocodePoint]:
        inline = _parse_inline_lat_lng(address)
        if inline:
            return inline

        response = self.client.search_place_index_for_text(
            IndexName=self.place_index_name,
            Text=address,
            MaxResults=1,
        )
        results = response.get("Results", [])
        if not results:
            return None
        place = results[0].get("Place", {})
        geometry = place.get("Geometry", {})
        point = geometry.get("Point", [])
        if len(point) != 2:
            return None
        lng = float(point[0])
        lat = float(point[1])
        if not _is_valid_lat_lng(lat, lng):
            return None
        return GeocodePoint(lat=lat, lng=lng, source="amazon-location")


_IN_MEMORY_ADDRESS_GEOCODER = InMemoryAddressGeocoder()


def get_address_geocoder() -> AddressGeocoder:
    force_memory = _as_bool(os.environ.get("USE_IN_MEMORY_GEOCODER"), default=False)
    if force_memory:
        return _IN_MEMORY_ADDRESS_GEOCODER

    place_index_name = (os.environ.get("LOCATION_PLACE_INDEX_NAME") or "").strip()
    if place_index_name:
        try:
            return AmazonLocationAddressGeocoder(place_index_name=place_index_name)
        except Exception:
            return _IN_MEMORY_ADDRESS_GEOCODER
    return _IN_MEMORY_ADDRESS_GEOCODER


def reset_in_memory_address_geocoder():
    _IN_MEMORY_ADDRESS_GEOCODER.reset()


def set_in_memory_geocode_result(address: str, lat: float, lng: float):
    _IN_MEMORY_ADDRESS_GEOCODER.set_override(address=address, lat=lat, lng=lng)


def set_in_memory_geocode_failure(address: str):
    _IN_MEMORY_ADDRESS_GEOCODER.set_failure(address=address)
