from datetime import datetime
from enum import Enum
from typing import Any, Dict, List, Optional

from pydantic import BaseModel, Field


class OrderCreate(BaseModel):
    customer_name: str
    reference_number: int = Field(..., ge=1)
    pick_up_address: str = Field(..., min_length=1, max_length=300)
    delivery: str = Field(..., min_length=1, max_length=300)
    dimensions: str = Field(..., min_length=1, max_length=120)
    weight: float = Field(..., gt=0)
    phone: Optional[str] = None
    email: Optional[str] = None
    notes: Optional[str] = None
    num_packages: int = Field(default=1, ge=1)


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
    reference_number: int
    pick_up_address: str
    delivery: str
    dimensions: str
    weight: float
    phone: Optional[str] = None
    email: Optional[str] = None
    notes: Optional[str] = None
    num_packages: int
    external_order_id: Optional[str] = None
    source: Optional[str] = None
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


class SeatRole(str, Enum):
    DISPATCHER = "Dispatcher"
    DRIVER = "Driver"


class InvitationStatus(str, Enum):
    PENDING = "Pending"
    ACCEPTED = "Accepted"
    CANCELLED = "Cancelled"


class SeatSubscriptionRecord(BaseModel):
    org_id: str
    plan_name: str = "seat-based"
    status: str = "active"
    stripe_customer_id: Optional[str] = None
    stripe_subscription_id: Optional[str] = None
    dispatcher_seat_limit: int = Field(default=0, ge=0)
    driver_seat_limit: int = Field(default=0, ge=0)
    created_at: datetime
    updated_at: datetime


class BillingSeatState(BaseModel):
    total: int = Field(..., ge=0)
    used: int = Field(..., ge=0)
    pending: int = Field(..., ge=0)
    available: int = Field(..., ge=0)


class BillingSummary(BaseModel):
    org_id: str
    plan_name: str
    status: str
    stripe_customer_id: Optional[str] = None
    stripe_subscription_id: Optional[str] = None
    dispatcher_seats: BillingSeatState
    driver_seats: BillingSeatState
    updated_at: datetime


class BillingProviderStatus(BaseModel):
    org_id: str
    stripe_mode: str
    checkout_enabled: bool
    webhook_signature_verification_enabled: bool
    stripe_secret_key_configured: bool
    stripe_webhook_secret_configured: bool
    stripe_dispatcher_price_id_configured: bool
    stripe_driver_price_id_configured: bool
    stripe_customer_id: Optional[str] = None
    stripe_subscription_id: Optional[str] = None


class BillingSeatsUpdateRequest(BaseModel):
    dispatcher_seat_limit: Optional[int] = Field(default=None, ge=0, le=10000)
    driver_seat_limit: Optional[int] = Field(default=None, ge=0, le=10000)


class BillingSeatsUpdateResponse(BaseModel):
    summary: BillingSummary


class BillingCheckoutRequest(BaseModel):
    dispatcher_seat_limit: Optional[int] = Field(default=None, ge=0, le=10000)
    driver_seat_limit: Optional[int] = Field(default=None, ge=0, le=10000)
    success_url: str = Field(..., min_length=1, max_length=2000)
    cancel_url: str = Field(..., min_length=1, max_length=2000)


class BillingCheckoutResponse(BaseModel):
    mode: str
    checkout_url: Optional[str] = None
    checkout_session_id: Optional[str] = None
    summary: Optional[BillingSummary] = None


class BillingPortalRequest(BaseModel):
    return_url: str = Field(..., min_length=1, max_length=2000)


class BillingPortalResponse(BaseModel):
    portal_url: str
    portal_session_id: Optional[str] = None


class BillingInvitationCreateRequest(BaseModel):
    user_id: str = Field(..., min_length=1, max_length=128)
    email: Optional[str] = Field(default=None, min_length=3, max_length=320)
    role: SeatRole


class BillingInvitationRecord(BaseModel):
    org_id: str
    invitation_id: str
    user_id: str
    email: Optional[str] = None
    role: SeatRole
    status: InvitationStatus
    created_at: datetime
    updated_at: datetime


class StripeWebhookResponse(BaseModel):
    received: bool
    event_type: Optional[str] = None
    org_id: Optional[str] = None


class WebhookOrderInput(BaseModel):
    external_order_id: str = Field(..., min_length=1, max_length=128)
    customer_name: str = Field(..., min_length=1, max_length=160)
    reference_number: int = Field(..., ge=1)
    pick_up_address: str = Field(..., min_length=1, max_length=300)
    delivery: str = Field(..., min_length=1, max_length=300)
    dimensions: str = Field(..., min_length=1, max_length=120)
    weight: float = Field(..., gt=0)
    phone: Optional[str] = Field(default=None, max_length=40)
    email: Optional[str] = Field(default=None, max_length=320)
    notes: Optional[str] = Field(default=None, max_length=1000)
    num_packages: int = Field(default=1, ge=1, le=500)


class OrdersWebhookRequest(BaseModel):
    org_id: str = Field(..., min_length=1, max_length=120)
    source: str = Field(default="external", min_length=1, max_length=80)
    orders: List[WebhookOrderInput] = Field(..., min_length=1, max_length=500)


class OrdersWebhookResponse(BaseModel):
    accepted: int
    created: int
    updated: int
    order_ids: List[str] = Field(default_factory=list)


class AuditLogRecord(BaseModel):
    org_id: str
    event_id: str
    action: str = Field(..., min_length=1, max_length=120)
    actor_id: Optional[str] = Field(default=None, max_length=128)
    actor_roles: List[str] = Field(default_factory=list)
    target_type: Optional[str] = Field(default=None, max_length=80)
    target_id: Optional[str] = Field(default=None, max_length=128)
    request_id: Optional[str] = Field(default=None, max_length=128)
    details: Dict[str, Any] = Field(default_factory=dict)
    created_at: datetime


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
