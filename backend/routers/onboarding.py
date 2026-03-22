from datetime import datetime
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query, Request, status as http_status

try:
    from backend.audit_store import get_audit_log_store, new_event_id
    from backend.auth import ROLE_ADMIN, get_authenticated_identity
    from backend.onboarding_service import (
        OnboardingCognitoAdminClient,
        OnboardingNotifier,
        OnboardingRepository,
        ReviewTokenError,
        build_hosted_ui_login_link,
        build_review_link,
        generate_org_id,
        get_onboarding_cognito_admin_client,
        get_onboarding_notifier,
        get_onboarding_repository,
        issue_review_token,
        onboarding_approver_allowlist,
        onboarding_register_url_base,
        registration_id_for_identity,
        resolve_review_token,
        utc_now,
    )
    from backend.repositories import get_identity_repository
    from backend.schemas import (
        AuditLogRecord,
        OnboardingPendingRegistrationsResponse,
        OnboardingRegistrationMeResponse,
        OnboardingRegistrationRecord,
        OnboardingRegistrationStatus,
        OnboardingRegistrationUpsertRequest,
        OnboardingReviewDecision,
        OnboardingReviewDecisionByRegistrationRequest,
        OnboardingReviewDecisionRequest,
        OnboardingReviewDecisionResponse,
        OnboardingReviewResolveResponse,
        OrganizationRecord,
        UserRecord,
    )
except ModuleNotFoundError:  # local run from backend/ directory
    from audit_store import get_audit_log_store, new_event_id
    from auth import ROLE_ADMIN, get_authenticated_identity
    from onboarding_service import (
        OnboardingCognitoAdminClient,
        OnboardingNotifier,
        OnboardingRepository,
        ReviewTokenError,
        build_hosted_ui_login_link,
        build_review_link,
        generate_org_id,
        get_onboarding_cognito_admin_client,
        get_onboarding_notifier,
        get_onboarding_repository,
        issue_review_token,
        onboarding_approver_allowlist,
        onboarding_register_url_base,
        registration_id_for_identity,
        resolve_review_token,
        utc_now,
    )
    from repositories import get_identity_repository
    from schemas import (
        AuditLogRecord,
        OnboardingPendingRegistrationsResponse,
        OnboardingRegistrationMeResponse,
        OnboardingRegistrationRecord,
        OnboardingRegistrationStatus,
        OnboardingRegistrationUpsertRequest,
        OnboardingReviewDecision,
        OnboardingReviewDecisionByRegistrationRequest,
        OnboardingReviewDecisionRequest,
        OnboardingReviewDecisionResponse,
        OnboardingReviewResolveResponse,
        OrganizationRecord,
        UserRecord,
    )

router = APIRouter(tags=["onboarding"])


def _request_id(request: Request) -> Optional[str]:
    value = getattr(getattr(request, "state", object()), "request_id", None)
    if value:
        return str(value)
    return request.headers.get("x-correlation-id") or request.headers.get("x-request-id")


def _audit_event(
    *,
    request: Request,
    action: str,
    target_id: str,
    actor_id: Optional[str],
    actor_roles,
    details: dict,
    org_id: Optional[str] = None,
):
    now = utc_now()
    event = AuditLogRecord(
        org_id=org_id or "onboarding",
        event_id=new_event_id(now),
        action=action,
        actor_id=actor_id,
        actor_roles=list(actor_roles or []),
        target_type="onboarding_registration",
        target_id=target_id,
        request_id=_request_id(request),
        details=details,
        created_at=now,
    )
    get_audit_log_store().put_event(event)


def _normalized_email(value: Optional[str]) -> Optional[str]:
    if value is None:
        return None
    text = value.strip().lower()
    if "@" not in text:
        return None
    return text


def _send_review_request_email(
    *,
    notifier: OnboardingNotifier,
    registration: OnboardingRegistrationRecord,
    review_link: str,
    approver_allowlist: set[str],
):
    if not approver_allowlist or not review_link:
        return
    requester_email = registration.requester_email or "unknown"
    subject = f"Discra onboarding request: {registration.tenant_name}"
    body = (
        "A new tenant admin registration is pending review.\n\n"
        f"Tenant: {registration.tenant_name}\n"
        f"Requester: {requester_email}\n"
        f"Registration ID: {registration.registration_id}\n\n"
        "Open review link:\n"
        f"{review_link}\n"
    )
    notifier.send_email(
        to_addresses=sorted(approver_allowlist),
        subject=subject,
        text_body=body,
    )


def _send_requester_decision_email(
    *,
    notifier: OnboardingNotifier,
    registration: OnboardingRegistrationRecord,
    decision: OnboardingReviewDecision,
    reason: Optional[str],
):
    requester_email = _normalized_email(registration.requester_email)
    if not requester_email:
        return
    register_url = onboarding_register_url_base()
    hosted_login_url = build_hosted_ui_login_link()

    if decision == OnboardingReviewDecision.APPROVE:
        subject = f"Discra registration approved: {registration.tenant_name}"
        body = (
            "Your Discra tenant registration was approved.\n\n"
            f"Tenant: {registration.tenant_name}\n"
            f"Organization ID: {registration.org_id or '-'}\n\n"
            "Next step: sign in again to refresh your claims.\n"
        )
        if register_url:
            body += f"Open app: {register_url}\n"
        if hosted_login_url:
            body += f"Hosted UI login: {hosted_login_url}\n"
    else:
        subject = f"Discra registration update: {registration.tenant_name}"
        body = (
            "Your Discra tenant registration was not approved.\n\n"
            f"Tenant: {registration.tenant_name}\n"
        )
        if reason:
            body += f"Reason: {reason.strip()}\n"
        if register_url:
            body += f"\nYou can update and resubmit here: {register_url}\n"

    notifier.send_email(
        to_addresses=[requester_email],
        subject=subject,
        text_body=body,
    )


def _ensure_approver_identity(identity: dict) -> str:
    approver_email = _normalized_email(identity.get("email"))
    if not approver_email:
        raise HTTPException(
            status_code=http_status.HTTP_403_FORBIDDEN,
            detail="Approver email claim is required",
        )
    allowlist = onboarding_approver_allowlist()
    if not allowlist:
        raise HTTPException(
            status_code=http_status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Onboarding approver allowlist is not configured",
        )
    if approver_email not in allowlist:
        raise HTTPException(
            status_code=http_status.HTTP_403_FORBIDDEN,
            detail="Approver email is not allowlisted",
        )
    return approver_email


def _roles_with_admin(existing_roles) -> list[str]:
    values = [role for role in list(existing_roles or []) if role]
    if ROLE_ADMIN not in values:
        values.append(ROLE_ADMIN)
    return values


def _token_is_current(token_issued_at: datetime, registration: OnboardingRegistrationRecord) -> bool:
    if registration.review_token_issued_at is None:
        return True
    return int(token_issued_at.timestamp()) == int(registration.review_token_issued_at.timestamp())


def _apply_review_decision_for_registration(
    *,
    decision: OnboardingReviewDecision,
    decision_reason: Optional[str],
    decision_source: str,
    request: Request,
    identity,
    approver_email: str,
    registration: OnboardingRegistrationRecord,
    repo: OnboardingRepository,
    cognito_admin: OnboardingCognitoAdminClient,
    notifier: OnboardingNotifier,
    identity_repo,
) -> OnboardingReviewDecisionResponse:
    if registration.status != OnboardingRegistrationStatus.PENDING:
        _audit_event(
            request=request,
            action="onboarding.review.decision.idempotent",
            target_id=registration.registration_id,
            actor_id=identity.get("sub"),
            actor_roles=identity.get("groups") or [],
            details={
                "requested_decision": decision.value,
                "current_status": registration.status.value,
                "approver_email": approver_email,
                "decision_source": decision_source,
            },
            org_id=registration.org_id,
        )
        return OnboardingReviewDecisionResponse(
            registration=registration,
            idempotent=True,
            message=f"Registration already {registration.status.value}",
        )

    now = utc_now()

    if decision == OnboardingReviewDecision.APPROVE:
        org_id = registration.org_id or generate_org_id(registration.tenant_name, registration.registration_id)
        existing_org = identity_repo.get_org(org_id)
        if not existing_org:
            identity_repo.upsert_org(
                OrganizationRecord(
                    org_id=org_id,
                    name=registration.tenant_name,
                    created_by=registration.identity_sub,
                    created_at=now,
                    updated_at=now,
                )
            )

        existing_user = identity_repo.get_user(org_id, registration.identity_sub)
        user_record = UserRecord(
            org_id=org_id,
            user_id=registration.identity_sub,
            username=registration.identity_username or registration.identity_sub,
            email=registration.requester_email or (existing_user.email if existing_user else None),
            roles=_roles_with_admin(existing_user.roles if existing_user else []),
            is_active=True,
            created_at=existing_user.created_at if existing_user else now,
            updated_at=now,
        )
        identity_repo.upsert_user(user_record)

        cognito_username = registration.identity_username or registration.identity_sub
        try:
            cognito_admin.ensure_admin_access(username=cognito_username, org_id=org_id, role_name=ROLE_ADMIN)
        except Exception as exc:
            raise HTTPException(
                status_code=http_status.HTTP_502_BAD_GATEWAY,
                detail=f"Failed to apply Cognito admin updates: {exc}",
            ) from exc

        updated = OnboardingRegistrationRecord(
            registration_id=registration.registration_id,
            identity_sub=registration.identity_sub,
            identity_username=registration.identity_username,
            requester_email=registration.requester_email,
            tenant_name=registration.tenant_name,
            contact_name=registration.contact_name,
            notes=registration.notes,
            requested_role=registration.requested_role,
            status=OnboardingRegistrationStatus.APPROVED,
            org_id=org_id,
            created_at=registration.created_at,
            updated_at=now,
            submitted_at=registration.submitted_at,
            decided_at=now,
            decided_by_email=approver_email,
            decision_reason=decision_reason,
            review_token_issued_at=registration.review_token_issued_at,
            review_token_expires_at=registration.review_token_expires_at,
        )
        saved = repo.upsert_registration(updated)
        try:
            _send_requester_decision_email(
                notifier=notifier,
                registration=saved,
                decision=OnboardingReviewDecision.APPROVE,
                reason=decision_reason,
            )
        except Exception:
            pass

        _audit_event(
            request=request,
            action="onboarding.registration.approved",
            target_id=saved.registration_id,
            actor_id=identity.get("sub"),
            actor_roles=identity.get("groups") or [],
            details={
                "approver_email": approver_email,
                "org_id": org_id,
                "decision_reason": decision_reason,
                "decision_source": decision_source,
            },
            org_id=org_id,
        )
        return OnboardingReviewDecisionResponse(
            registration=saved,
            idempotent=False,
            message="Registration approved",
        )

    updated = OnboardingRegistrationRecord(
        registration_id=registration.registration_id,
        identity_sub=registration.identity_sub,
        identity_username=registration.identity_username,
        requester_email=registration.requester_email,
        tenant_name=registration.tenant_name,
        contact_name=registration.contact_name,
        notes=registration.notes,
        requested_role=registration.requested_role,
        status=OnboardingRegistrationStatus.REJECTED,
        org_id=None,
        created_at=registration.created_at,
        updated_at=now,
        submitted_at=registration.submitted_at,
        decided_at=now,
        decided_by_email=approver_email,
        decision_reason=decision_reason,
        review_token_issued_at=registration.review_token_issued_at,
        review_token_expires_at=registration.review_token_expires_at,
    )
    saved = repo.upsert_registration(updated)
    try:
        _send_requester_decision_email(
            notifier=notifier,
            registration=saved,
            decision=OnboardingReviewDecision.REJECT,
            reason=decision_reason,
        )
    except Exception:
        pass

    _audit_event(
        request=request,
        action="onboarding.registration.rejected",
        target_id=saved.registration_id,
        actor_id=identity.get("sub"),
        actor_roles=identity.get("groups") or [],
        details={
            "approver_email": approver_email,
            "decision_reason": decision_reason,
            "decision_source": decision_source,
        },
    )
    return OnboardingReviewDecisionResponse(
        registration=saved,
        idempotent=False,
        message="Registration rejected",
    )


@router.post("/onboarding/registrations", response_model=OnboardingRegistrationMeResponse)
async def create_or_update_registration(
    payload: OnboardingRegistrationUpsertRequest,
    request: Request,
    identity=Depends(get_authenticated_identity),
    repo: OnboardingRepository = Depends(get_onboarding_repository),
    notifier: OnboardingNotifier = Depends(get_onboarding_notifier),
):
    now = utc_now()
    identity_sub = str(identity.get("sub") or "").strip()
    if not identity_sub:
        raise HTTPException(status_code=http_status.HTTP_401_UNAUTHORIZED, detail="Missing identity sub")

    registration_id = registration_id_for_identity(identity_sub)
    existing = repo.get_registration(registration_id)
    tenant_name = payload.tenant_name.strip()
    contact_name = payload.contact_name.strip() if payload.contact_name else None
    notes = payload.notes.strip() if payload.notes else None
    requester_email = _normalized_email(identity.get("email"))
    username = str(identity.get("username") or identity_sub).strip() or identity_sub

    if existing and existing.status == OnboardingRegistrationStatus.APPROVED:
        _audit_event(
            request=request,
            action="onboarding.registration.idempotent",
            target_id=existing.registration_id,
            actor_id=identity_sub,
            actor_roles=identity.get("groups") or [],
            details={
                "status": existing.status.value,
                "reason": "already_approved",
            },
            org_id=existing.org_id,
        )
        return OnboardingRegistrationMeResponse(exists=True, registration=existing)

    status = OnboardingRegistrationStatus.PENDING
    created_at = existing.created_at if existing else now
    submitted_at = now if existing is None or existing.status != OnboardingRegistrationStatus.PENDING else existing.submitted_at
    org_id = existing.org_id if existing and existing.status == OnboardingRegistrationStatus.APPROVED else None

    review_token, token_expires_at = issue_review_token(registration_id, now=now)
    review_link = build_review_link(review_token)

    next_record = OnboardingRegistrationRecord(
        registration_id=registration_id,
        identity_sub=identity_sub,
        identity_username=username,
        requester_email=requester_email,
        tenant_name=tenant_name,
        contact_name=contact_name,
        notes=notes,
        requested_role=ROLE_ADMIN,
        status=status,
        org_id=org_id,
        created_at=created_at,
        updated_at=now,
        submitted_at=submitted_at,
        decided_at=None,
        decided_by_email=None,
        decision_reason=None,
        review_token_issued_at=now,
        review_token_expires_at=token_expires_at,
    )

    unchanged = (
        existing is not None
        and existing.status == OnboardingRegistrationStatus.PENDING
        and existing.tenant_name == next_record.tenant_name
        and existing.contact_name == next_record.contact_name
        and (existing.notes or None) == (next_record.notes or None)
    )
    saved = repo.upsert_registration(next_record)

    email_error = None
    approver_allowlist = onboarding_approver_allowlist()
    try:
        _send_review_request_email(
            notifier=notifier,
            registration=saved,
            review_link=review_link,
            approver_allowlist=approver_allowlist,
        )
    except Exception as exc:  # pragma: no cover - network failure path
        email_error = str(exc)

    _audit_event(
        request=request,
        action="onboarding.registration.idempotent" if unchanged else "onboarding.registration.submitted",
        target_id=saved.registration_id,
        actor_id=identity_sub,
        actor_roles=identity.get("groups") or [],
        details={
            "status": saved.status.value,
            "tenant_name": saved.tenant_name,
            "requester_email": saved.requester_email,
            "review_link_generated": bool(review_link),
            "review_link_sent_to_count": len(approver_allowlist),
            "review_email_error": email_error,
        },
    )
    return OnboardingRegistrationMeResponse(exists=True, registration=saved)


@router.get("/onboarding/registrations/me", response_model=OnboardingRegistrationMeResponse)
async def get_registration_for_current_identity(
    identity=Depends(get_authenticated_identity),
    repo: OnboardingRepository = Depends(get_onboarding_repository),
):
    identity_sub = str(identity.get("sub") or "").strip()
    if not identity_sub:
        raise HTTPException(status_code=http_status.HTTP_401_UNAUTHORIZED, detail="Missing identity sub")
    registration = repo.get_registration_for_identity(identity_sub)
    return OnboardingRegistrationMeResponse(
        exists=registration is not None,
        registration=registration,
    )


@router.get("/onboarding/registrations/pending", response_model=OnboardingPendingRegistrationsResponse)
async def list_pending_registrations_for_approver(
    identity=Depends(get_authenticated_identity),
    repo: OnboardingRepository = Depends(get_onboarding_repository),
):
    _ensure_approver_identity(identity)
    items = repo.list_by_status(OnboardingRegistrationStatus.PENDING, limit=100)
    return OnboardingPendingRegistrationsResponse(items=items)


@router.get("/onboarding/review", response_model=OnboardingReviewResolveResponse)
async def resolve_review_link(
    token: str = Query(..., min_length=10),
    repo: OnboardingRepository = Depends(get_onboarding_repository),
):
    try:
        registration_id, token_issued_at, token_expires_at = resolve_review_token(token)
    except ReviewTokenError as exc:
        raise HTTPException(status_code=http_status.HTTP_400_BAD_REQUEST, detail=str(exc)) from exc

    registration = repo.get_registration(registration_id)
    if registration is None:
        raise HTTPException(status_code=http_status.HTTP_404_NOT_FOUND, detail="Registration not found")

    if not _token_is_current(token_issued_at, registration):
        raise HTTPException(
            status_code=http_status.HTTP_400_BAD_REQUEST,
            detail="Review token has been replaced by a newer link",
        )

    return OnboardingReviewResolveResponse(
        registration=registration,
        token_expires_at=token_expires_at,
        decision_allowed=registration.status == OnboardingRegistrationStatus.PENDING,
    )


@router.post("/onboarding/review/decision", response_model=OnboardingReviewDecisionResponse)
async def apply_review_decision(
    payload: OnboardingReviewDecisionRequest,
    request: Request,
    identity=Depends(get_authenticated_identity),
    repo: OnboardingRepository = Depends(get_onboarding_repository),
    cognito_admin: OnboardingCognitoAdminClient = Depends(get_onboarding_cognito_admin_client),
    notifier: OnboardingNotifier = Depends(get_onboarding_notifier),
    identity_repo=Depends(get_identity_repository),
):
    approver_email = _ensure_approver_identity(identity)

    try:
        registration_id, token_issued_at, _ = resolve_review_token(payload.token)
    except ReviewTokenError as exc:
        raise HTTPException(status_code=http_status.HTTP_400_BAD_REQUEST, detail=str(exc)) from exc

    registration = repo.get_registration(registration_id)
    if registration is None:
        raise HTTPException(status_code=http_status.HTTP_404_NOT_FOUND, detail="Registration not found")

    if not _token_is_current(token_issued_at, registration):
        raise HTTPException(
            status_code=http_status.HTTP_400_BAD_REQUEST,
            detail="Review token has been replaced by a newer link",
        )
    return _apply_review_decision_for_registration(
        decision=payload.decision,
        decision_reason=payload.reason.strip() if payload.reason else None,
        decision_source="signed_token",
        request=request,
        identity=identity,
        approver_email=approver_email,
        registration=registration,
        repo=repo,
        cognito_admin=cognito_admin,
        notifier=notifier,
        identity_repo=identity_repo,
    )


@router.post("/onboarding/review/decision/by-registration", response_model=OnboardingReviewDecisionResponse)
async def apply_review_decision_by_registration(
    payload: OnboardingReviewDecisionByRegistrationRequest,
    request: Request,
    identity=Depends(get_authenticated_identity),
    repo: OnboardingRepository = Depends(get_onboarding_repository),
    cognito_admin: OnboardingCognitoAdminClient = Depends(get_onboarding_cognito_admin_client),
    notifier: OnboardingNotifier = Depends(get_onboarding_notifier),
    identity_repo=Depends(get_identity_repository),
):
    approver_email = _ensure_approver_identity(identity)
    registration_id = payload.registration_id.strip()
    registration = repo.get_registration(registration_id)
    if registration is None:
        raise HTTPException(status_code=http_status.HTTP_404_NOT_FOUND, detail="Registration not found")
    return _apply_review_decision_for_registration(
        decision=payload.decision,
        decision_reason=payload.reason.strip() if payload.reason else None,
        decision_source="approver_queue",
        request=request,
        identity=identity,
        approver_email=approver_email,
        registration=registration,
        repo=repo,
        cognito_admin=cognito_admin,
        notifier=notifier,
        identity_repo=identity_repo,
    )
