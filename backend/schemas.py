from datetime import datetime
from enum import Enum
from typing import List, Optional

from pydantic import BaseModel, Field


class OrderCreate(BaseModel):
    customer_name: str
    address: str
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
    address: str
    phone: Optional[str] = None
    email: Optional[str] = None
    notes: Optional[str] = None
    num_packages: int
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
