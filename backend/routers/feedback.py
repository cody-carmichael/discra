"""In-app pilot feedback (Step 6.3).

Any authenticated user can submit; only Admin/Dispatcher can read the queue.
Drivers deliberately cannot list feedback — a driver seeing every colleague's
complaints is a privacy problem, not a feature.

Submissions are org-scoped from the JWT, never from the request body, so a
tester cannot file feedback into another tenant.
"""
from datetime import datetime, timezone
from typing import List, Optional

from fastapi import APIRouter, Depends, Query, Request
from pydantic import BaseModel, Field

try:
    from backend.auth import (
        ROLE_ADMIN,
        ROLE_DISPATCHER,
        ROLE_DRIVER,
        get_current_user,
        require_roles,
    )
    from backend.feedback_store import (
        MAX_MESSAGE_CHARS,
        get_feedback_store,
        new_feedback_id,
    )
    from backend.schemas import FeedbackRecord
except ModuleNotFoundError:  # local run from backend/ directory
    from auth import (
        ROLE_ADMIN,
        ROLE_DISPATCHER,
        ROLE_DRIVER,
        get_current_user,
        require_roles,
    )
    from feedback_store import MAX_MESSAGE_CHARS, get_feedback_store, new_feedback_id
    from schemas import FeedbackRecord

router = APIRouter(prefix="/feedback", tags=["feedback"])

ALLOWED_CATEGORIES = {"bug", "confusing", "idea", "praise", "general"}

# Bound the free-text context fields. These are attacker-controllable (user agent
# especially) and end up rendered in the admin console.
MAX_CONTEXT_CHARS = 400


class FeedbackSubmitRequest(BaseModel):
    message: str = Field(..., min_length=1, max_length=MAX_MESSAGE_CHARS)
    category: str = "general"
    surface: str = ""
    page: str = ""
    app_version: str = ""


def _clip(value: Optional[str], limit: int = MAX_CONTEXT_CHARS) -> str:
    return (value or "").strip()[:limit]


@router.post("")
async def submit_feedback(
    body: FeedbackSubmitRequest,
    request: Request,
    user=Depends(require_roles([ROLE_ADMIN, ROLE_DISPATCHER, ROLE_DRIVER])),
    feedback_store=Depends(get_feedback_store),
):
    """Accept feedback from any signed-in user, scoped to their own org."""
    category = body.category if body.category in ALLOWED_CATEGORIES else "general"
    created_at = datetime.now(timezone.utc)

    record = FeedbackRecord(
        # org comes from the verified token, never from the payload.
        org_id=user["org_id"],
        feedback_id=new_feedback_id(created_at),
        category=category,
        message=body.message.strip()[:MAX_MESSAGE_CHARS],
        surface=_clip(body.surface),
        page=_clip(body.page),
        app_version=_clip(body.app_version),
        user_agent=_clip(request.headers.get("user-agent")),
        submitted_by=user.get("sub") or "",
        submitted_by_email=user.get("email") or "",
        submitted_by_roles=list(user.get("groups") or []),
        created_at=created_at,
    )
    saved = feedback_store.add_feedback(record)
    return {"ok": True, "feedback_id": saved.feedback_id}


@router.get("")
async def list_feedback(
    limit: int = Query(50, ge=1, le=200),
    user=Depends(require_roles([ROLE_ADMIN, ROLE_DISPATCHER])),
    feedback_store=Depends(get_feedback_store),
) -> List[FeedbackRecord]:
    """Newest-first feedback for the caller's org."""
    return feedback_store.list_feedback(user["org_id"], limit=limit)
