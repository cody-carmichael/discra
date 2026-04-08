from datetime import datetime, timezone
from enum import Enum
from typing import Any, Dict, List, Optional

from pydantic import BaseModel, Field, model_validator


def _to_utc(value: Optional[datetime]) -> Optional[datetime]:
    if value is None:
        return None
    if value.tzinfo is None:
        return value.replace(tzinfo=timezone.utc)
    return value.astimezone(timezone.utc)


class OrderCreate(BaseModel):
    customer_name: str
    reference_id: str = Field(..., min_length=1, max_length=64)
    pick_up_street: str = Field(..., min_length=1, max_length=200)
    pick_up_city: str = Field(..., min_length=1, max_length=100)
    pick_up_state: str = Field(..., min_length=1, max_length=50)
    pick_up_zip: str = Field(..., min_length=1, max_length=20)
    delivery_street: str = Field(..., min_length=1, max_length=200)
    delivery_city: str = Field(..., min_length=1, max_length=100)
    delivery_state: str = Field(..., min_length=1, max_length=50)
    delivery_zip: str = Field(..., min_length=1, max_length=20)
    dimensions: Optional[str] = Field(default=None, max_length=120)
    weight: Optional[float] = Field(default=None, gt=0)
    time_window_start: Optional[datetime] = None
    time_window_end: Optional[datetime] = None
    pickup_deadline: Optional[datetime] = None
    dropoff_deadline: Optional[datetime] = None
    phone: Optional[str] = None
    email: Optional[str] = None
    notes: Optional[str] = None
    num_packages: int = Field(default=1, ge=1)

    @model_validator(mode="after")
    def validate_time_window(self):
        start_utc = _to_utc(self.time_window_start)
        end_utc = _to_utc(self.time_window_end)
        if start_utc and end_utc and end_utc < start_utc:
            raise ValueError("time_window_end must be greater than or equal to time_window_start")
        pickup_deadline_utc = _to_utc(self.pickup_deadline)
        dropoff_deadline_utc = _to_utc(self.dropoff_deadline)
        if pickup_deadline_utc and dropoff_deadline_utc and dropoff_deadline_utc < pickup_deadline_utc:
            raise ValueError("dropoff_deadline must be greater than or equal to pickup_deadline")
        return self


class OrderUpdate(BaseModel):
    customer_name: Optional[str] = Field(default=None, min_length=1, max_length=160)
    reference_id: Optional[str] = Field(default=None, min_length=1, max_length=64)
    pick_up_street: Optional[str] = Field(default=None, min_length=1, max_length=200)
    pick_up_city: Optional[str] = Field(default=None, min_length=1, max_length=100)
    pick_up_state: Optional[str] = Field(default=None, min_length=1, max_length=50)
    pick_up_zip: Optional[str] = Field(default=None, min_length=1, max_length=20)
    delivery_street: Optional[str] = Field(default=None, min_length=1, max_length=200)
    delivery_city: Optional[str] = Field(default=None, min_length=1, max_length=100)
    delivery_state: Optional[str] = Field(default=None, min_length=1, max_length=50)
    delivery_zip: Optional[str] = Field(default=None, min_length=1, max_length=20)
    dimensions: Optional[str] = Field(default=None, max_length=120)
    weight: Optional[float] = Field(default=None, gt=0)
    pickup_deadline: Optional[datetime] = None
    dropoff_deadline: Optional[datetime] = None
    phone: Optional[str] = Field(default=None, max_length=40)
    email: Optional[str] = Field(default=None, max_length=320)
    notes: Optional[str] = Field(default=None, max_length=1000)
    num_packages: Optional[int] = Field(default=None, ge=1, le=500)

    @model_validator(mode="after")
    def validate_deadlines(self):
        pickup_utc = _to_utc(self.pickup_deadline)
        dropoff_utc = _to_utc(self.dropoff_deadline)
        if pickup_utc and dropoff_utc and dropoff_utc < pickup_utc:
            raise ValueError("dropoff_deadline must be greater than or equal to pickup_deadline")
        return self


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
    reference_id: str
    pick_up_street: str
    pick_up_city: str
    pick_up_state: str
    pick_up_zip: str
    delivery_street: str
    delivery_city: str
    delivery_state: str
    delivery_zip: str
    dimensions: Optional[str] = None
    weight: Optional[float] = None
    time_window_start: Optional[datetime] = None
    time_window_end: Optional[datetime] = None
    pickup_deadline: Optional[datetime] = None
    dropoff_deadline: Optional[datetime] = None
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


class BulkAssignRequest(BaseModel):
    order_ids: List[str] = Field(..., min_length=1, max_length=200)
    driver_id: str = Field(..., min_length=1, max_length=128)


class BulkUnassignRequest(BaseModel):
    order_ids: List[str] = Field(..., min_length=1, max_length=200)


class BulkOrderMutationResponse(BaseModel):
    updated: int
    order_ids: List[str] = Field(default_factory=list)


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
    phone: Optional[str] = None
    photo_url: Optional[str] = None
    tsa_certified: bool = False
    roles: List[str] = Field(default_factory=list)
    is_active: bool = True
    created_at: datetime
    updated_at: datetime


class UserProfileUpdate(BaseModel):
    phone: Optional[str] = Field(default=None, max_length=40)
    email: Optional[str] = Field(default=None, max_length=320)
    photo_url: Optional[str] = Field(default=None, max_length=500)
    tsa_certified: Optional[bool] = None


class SeatRole(str, Enum):
    ADMIN = "Admin"
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
    user_id: Optional[str] = Field(default=None, min_length=1, max_length=128)
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
    reference_id: str = Field(..., min_length=1, max_length=64)
    pick_up_street: str = Field(..., min_length=1, max_length=200)
    pick_up_city: str = Field(..., min_length=1, max_length=100)
    pick_up_state: str = Field(..., min_length=1, max_length=50)
    pick_up_zip: str = Field(..., min_length=1, max_length=20)
    delivery_street: str = Field(..., min_length=1, max_length=200)
    delivery_city: str = Field(..., min_length=1, max_length=100)
    delivery_state: str = Field(..., min_length=1, max_length=50)
    delivery_zip: str = Field(..., min_length=1, max_length=20)
    dimensions: Optional[str] = Field(default=None, max_length=120)
    weight: Optional[float] = Field(default=None, gt=0)
    time_window_start: Optional[datetime] = None
    time_window_end: Optional[datetime] = None
    pickup_deadline: Optional[datetime] = None
    dropoff_deadline: Optional[datetime] = None
    phone: Optional[str] = Field(default=None, max_length=40)
    email: Optional[str] = Field(default=None, max_length=320)
    notes: Optional[str] = Field(default=None, max_length=1000)
    num_packages: int = Field(default=1, ge=1, le=500)

    @model_validator(mode="after")
    def validate_time_window(self):
        start_utc = _to_utc(self.time_window_start)
        end_utc = _to_utc(self.time_window_end)
        if start_utc and end_utc and end_utc < start_utc:
            raise ValueError("time_window_end must be greater than or equal to time_window_start")
        pickup_deadline_utc = _to_utc(self.pickup_deadline)
        dropoff_deadline_utc = _to_utc(self.dropoff_deadline)
        if pickup_deadline_utc and dropoff_deadline_utc and dropoff_deadline_utc < pickup_deadline_utc:
            raise ValueError("dropoff_deadline must be greater than or equal to pickup_deadline")
        return self


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


class PushSubscriptionRecord(BaseModel):
    org_id: str
    driver_id: str
    endpoint: str
    p256dh: str
    auth: str
    created_at: datetime
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


class RouteDirectionsRequest(BaseModel):
    driver_id: str
    stops: Optional[List[RouteStopInput]] = None
    start_lat: Optional[float] = Field(default=None, ge=-90, le=90)
    start_lng: Optional[float] = Field(default=None, ge=-180, le=180)


class RouteDirectionsResponse(BaseModel):
    coordinates: List[List[float]]  # [[lng, lat], ...] polyline
    distance_meters: float
    duration_seconds: float
    bbox: Optional[List[float]] = None
    ordered_stops: List[RouteOptimizedStop]


class RouteNavigateRequest(BaseModel):
    start_lat: float = Field(..., ge=-90, le=90)
    start_lng: float = Field(..., ge=-180, le=180)
    dest_lat: float = Field(..., ge=-90, le=90)
    dest_lng: float = Field(..., ge=-180, le=180)


class RouteStep(BaseModel):
    instruction: str = ""
    distance_meters: float = 0.0
    duration_seconds: float = 0.0
    type: int = 0


class RouteNavigateResponse(BaseModel):
    coordinates: List[List[float]]  # [[lng, lat], ...] polyline
    distance_meters: float
    duration_seconds: float
    bbox: Optional[List[float]] = None
    steps: List[RouteStep] = Field(default_factory=list)


class DispatchSummaryResponse(BaseModel):
    org_id: str
    generated_at: datetime
    total_orders: int = Field(..., ge=0)
    assigned_orders: int = Field(..., ge=0)
    unassigned_orders: int = Field(..., ge=0)
    terminal_orders: int = Field(..., ge=0)
    by_status: Dict[str, int] = Field(default_factory=dict)
    active_drivers: int = Field(..., ge=0)
    active_driver_ids: List[str] = Field(default_factory=list)


class OnboardingRegistrationStatus(str, Enum):
    PENDING = "Pending"
    APPROVED = "Approved"
    REJECTED = "Rejected"


class OnboardingReviewDecision(str, Enum):
    APPROVE = "approve"
    REJECT = "reject"


class OnboardingRegistrationUpsertRequest(BaseModel):
    tenant_name: str = Field(..., min_length=2, max_length=140)
    contact_name: Optional[str] = Field(default=None, max_length=120)
    notes: Optional[str] = Field(default=None, max_length=1000)


class OnboardingRegistrationRecord(BaseModel):
    registration_id: str
    identity_sub: str
    identity_username: Optional[str] = None
    requester_email: Optional[str] = None
    tenant_name: str
    contact_name: Optional[str] = None
    notes: Optional[str] = None
    requested_role: str = "Admin"
    status: OnboardingRegistrationStatus
    org_id: Optional[str] = None
    created_at: datetime
    updated_at: datetime
    submitted_at: datetime
    decided_at: Optional[datetime] = None
    decided_by_email: Optional[str] = None
    decision_reason: Optional[str] = None
    review_token_issued_at: Optional[datetime] = None
    review_token_expires_at: Optional[datetime] = None


class OnboardingRegistrationMeResponse(BaseModel):
    exists: bool
    registration: Optional[OnboardingRegistrationRecord] = None


class OnboardingReviewResolveResponse(BaseModel):
    registration: OnboardingRegistrationRecord
    token_expires_at: datetime
    decision_allowed: bool


class OnboardingReviewDecisionRequest(BaseModel):
    token: str = Field(..., min_length=10, max_length=4096)
    decision: OnboardingReviewDecision
    reason: Optional[str] = Field(default=None, max_length=1000)


class OnboardingReviewDecisionByRegistrationRequest(BaseModel):
    registration_id: str = Field(..., min_length=8, max_length=120)
    decision: OnboardingReviewDecision
    reason: Optional[str] = Field(default=None, max_length=1000)


class OnboardingReviewDecisionResponse(BaseModel):
    registration: OnboardingRegistrationRecord
    idempotent: bool = False
    message: str


class OnboardingPendingRegistrationsResponse(BaseModel):
    items: List[OnboardingRegistrationRecord] = Field(default_factory=list)


# ── Email ingestion ──────────────────────────────────────────────


class EmailRule(BaseModel):
    rule_id: str
    name: str = Field(..., max_length=120)
    sender_pattern: str = Field(..., max_length=200)
    subject_pattern: str = Field(default="", max_length=200)
    parser_type: str = Field(..., max_length=40)
    enabled: bool = True
    created_at: datetime
    updated_at: datetime


class EmailConfig(BaseModel):
    org_id: str
    gmail_email: str = ""
    gmail_refresh_token: str = ""
    gmail_history_id: Optional[str] = None
    email_connected: bool = False
    connected_at: Optional[datetime] = None
    last_poll_at: Optional[datetime] = None
    last_error: Optional[str] = None
    email_rules: List[EmailRule] = Field(default_factory=list)


class SkippedEmail(BaseModel):
    org_id: str
    email_message_id: str
    sender: str = ""
    subject: str = ""
    received_at: Optional[datetime] = None
    skip_reason: str = ""
    created_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))
    expires_at_epoch: int = 0
