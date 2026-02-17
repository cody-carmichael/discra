from datetime import datetime
from enum import Enum
from typing import Dict, List, Optional

from pydantic import BaseModel, Field


class OrderCreate(BaseModel):
    customer_name: str
    address: str
    phone: Optional[str] = None
    email: Optional[str] = None
    notes: Optional[str] = None
    num_packages: int = Field(default=1, ge=1)
    delivery_lat: Optional[float] = Field(default=None, ge=-90, le=90)
    delivery_lng: Optional[float] = Field(default=None, ge=-180, le=180)


class OrderStatus(str, Enum):
    CREATED = "Created"
    ASSIGNED = "Assigned"
    PICKED_UP = "PickedUp"
    EN_ROUTE = "EnRoute"
    DELIVERED = "Delivered"
    FAILED = "Failed"


class Order(BaseModel):
    id: str
    customer_name: str
    address: str
    phone: Optional[str] = None
    email: Optional[str] = None
    notes: Optional[str] = None
    num_packages: int
    delivery_lat: Optional[float] = None
    delivery_lng: Optional[float] = None
    status: OrderStatus
    assigned_to: Optional[str] = None
    created_at: datetime
    org_id: str


class AssignRequest(BaseModel):
    driver_id: str


class StatusUpdateRequest(BaseModel):
    status: OrderStatus
    notes: Optional[str] = Field(default=None, max_length=500)


class LocationUpdate(BaseModel):
    lat: float = Field(..., ge=-90, le=90)
    lng: float = Field(..., ge=-180, le=180)
    heading: Optional[float] = Field(default=None, ge=0, le=360)
    timestamp: Optional[datetime] = None


class UserClaims(BaseModel):
    sub: Optional[str] = None
    username: Optional[str] = None
    email: Optional[str] = None
    org_id: Optional[str] = None
    groups: List[str] = Field(default_factory=list)


class OrganizationUpdateRequest(BaseModel):
    name: str = Field(..., min_length=1, max_length=120)


class OrganizationRecord(BaseModel):
    org_id: str
    name: str
    created_by: str
    created_at: datetime
    updated_at: datetime


class UserRecord(BaseModel):
    org_id: str
    user_id: str
    username: Optional[str] = None
    email: Optional[str] = None
    roles: List[str] = Field(default_factory=list)
    is_active: bool = True
    created_at: datetime
    updated_at: datetime


class PodArtifactType(str, Enum):
    PHOTO = "photo"
    SIGNATURE = "signature"


class PodPresignArtifactRequest(BaseModel):
    artifact_type: PodArtifactType
    content_type: str = Field(..., min_length=3, max_length=100)
    file_size_bytes: int = Field(..., gt=0)
    file_name: Optional[str] = Field(default=None, max_length=255)


class PodPresignRequest(BaseModel):
    order_id: str
    artifacts: List[PodPresignArtifactRequest] = Field(..., min_length=1, max_length=6)


class PodPresignedUpload(BaseModel):
    artifact_type: PodArtifactType
    key: str
    url: str
    fields: Dict[str, str]
    expires_in: int
    max_size_bytes: int


class PodPresignResponse(BaseModel):
    uploads: List[PodPresignedUpload]


class PodLocation(BaseModel):
    lat: float = Field(..., ge=-90, le=90)
    lng: float = Field(..., ge=-180, le=180)
    heading: Optional[float] = Field(default=None, ge=0, le=360)


class PodMetadataCreateRequest(BaseModel):
    order_id: str
    photo_keys: List[str] = Field(default_factory=list, max_length=10)
    signature_keys: List[str] = Field(default_factory=list, max_length=5)
    notes: Optional[str] = Field(default=None, max_length=1000)
    captured_at: Optional[datetime] = None
    location: Optional[PodLocation] = None


class PodMetadataRecord(BaseModel):
    org_id: str
    pod_id: str
    order_id: str
    driver_id: str
    created_at: datetime
    captured_at: datetime
    photo_keys: List[str] = Field(default_factory=list)
    signature_keys: List[str] = Field(default_factory=list)
    notes: Optional[str] = None
    location: Optional[PodLocation] = None


class DriverLocationRecord(BaseModel):
    org_id: str
    driver_id: str
    lat: float = Field(..., ge=-90, le=90)
    lng: float = Field(..., ge=-180, le=180)
    heading: Optional[float] = Field(default=None, ge=0, le=360)
    timestamp: datetime
    expires_at_epoch: int


class RouteStopInput(BaseModel):
    order_id: str
    lat: float = Field(..., ge=-90, le=90)
    lng: float = Field(..., ge=-180, le=180)
    address: Optional[str] = None


class RouteOptimizeRequest(BaseModel):
    driver_id: str
    stops: Optional[List[RouteStopInput]] = None
    start_lat: Optional[float] = Field(default=None, ge=-90, le=90)
    start_lng: Optional[float] = Field(default=None, ge=-180, le=180)


class RouteOptimizedStop(BaseModel):
    sequence: int
    order_id: str
    lat: float
    lng: float
    address: Optional[str] = None
    distance_from_previous_meters: float
    duration_from_previous_seconds: float


class RouteOptimizeResponse(BaseModel):
    matrix_source: str
    total_distance_meters: float
    total_duration_seconds: float
    ordered_stops: List[RouteOptimizedStop]
