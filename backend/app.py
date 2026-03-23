import asyncio
import json
import logging
import os
import time
import uuid
from pathlib import Path
from urllib import error as urllib_error
from urllib import parse as urllib_parse
from urllib import request as urllib_request

from fastapi import FastAPI, HTTPException, Request, Response, status
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from mangum import Mangum

try:
    from backend.auth import (
        ROLE_ADMIN,
        ROLE_DISPATCHER,
        ROLE_DRIVER,
        build_dev_auth_session_value,
        dev_auth_cookie_name,
        dev_auth_default_org_id,
        dev_auth_ttl_seconds,
        get_dev_auth_user,
        get_optional_authenticated_identity,
        is_dev_auth_enabled,
        normalize_dev_auth_role,
        web_auth_cookie_name,
        web_auth_ttl_seconds,
    )
    from backend.routers import (
        billing_router,
        drivers_router,
        identity_router,
        onboarding_router,
        orders_router,
        pod_router,
        reports_router,
        routes_router,
    )
except ModuleNotFoundError:  # local run from backend/ directory
    from auth import (  # type: ignore
        ROLE_ADMIN,
        ROLE_DISPATCHER,
        ROLE_DRIVER,
        build_dev_auth_session_value,
        dev_auth_cookie_name,
        dev_auth_default_org_id,
        dev_auth_ttl_seconds,
        get_dev_auth_user,
        get_optional_authenticated_identity,
        is_dev_auth_enabled,
        normalize_dev_auth_role,
        web_auth_cookie_name,
        web_auth_ttl_seconds,
    )
    from routers import (
        billing_router,
        drivers_router,
        identity_router,
        onboarding_router,
        orders_router,
        pod_router,
        reports_router,
        routes_router,
    )

LOG_LEVEL = os.environ.get("LOG_LEVEL", "INFO").upper()
logging.basicConfig(level=LOG_LEVEL)
logger = logging.getLogger("discra.backend")
FRONTEND_DIR = Path(__file__).resolve().parent / "frontend"
FRONTEND_ASSETS_DIR = FRONTEND_DIR / "assets"


def _json_log(fields):
    return json.dumps(fields, separators=(",", ":"))


def _dev_auth_profiles():
    org_id = dev_auth_default_org_id()
    return [
        {
            "label": "Test Admin",
            "role": ROLE_ADMIN,
            "user_id": (os.environ.get("UI_DEV_AUTH_ADMIN_USER_ID") or "test-admin").strip() or "test-admin",
            "email": (os.environ.get("UI_DEV_AUTH_ADMIN_EMAIL") or "").strip(),
            "org_id": org_id,
        },
        {
            "label": "Test Dispatcher",
            "role": ROLE_DISPATCHER,
            "user_id": (os.environ.get("UI_DEV_AUTH_DISPATCHER_USER_ID") or "test-dispatcher").strip() or "test-dispatcher",
            "email": (os.environ.get("UI_DEV_AUTH_DISPATCHER_EMAIL") or "").strip(),
            "org_id": org_id,
        },
        {
            "label": "Test Driver",
            "role": ROLE_DRIVER,
            "user_id": (os.environ.get("UI_DEV_AUTH_DRIVER_USER_ID") or "test-driver").strip() or "test-driver",
            "email": (os.environ.get("UI_DEV_AUTH_DRIVER_EMAIL") or "").strip(),
            "org_id": org_id,
        },
    ]


def _default_user_id_for_role(role: str) -> str:
    for profile in _dev_auth_profiles():
        if profile["role"] == role:
            return profile["user_id"]
    return "test-user"


def _user_response_payload(user):
    if user is None:
        return None
    return {
        "sub": user.get("sub"),
        "username": user.get("username"),
        "email": user.get("email"),
        "org_id": user.get("org_id"),
        "groups": user.get("groups") or [],
    }


def _ui_config_payload(*, admin_redirect_path: str, driver_redirect_path: str, register_redirect_path: str, review_redirect_path: str):
    dev_auth_enabled = is_dev_auth_enabled()
    return {
        "cognito_domain": os.environ.get("COGNITO_HOSTED_UI_DOMAIN", ""),
        "cognito_client_id": os.environ.get("FRONTEND_COGNITO_CLIENT_ID")
        or os.environ.get("COGNITO_AUDIENCE", ""),
        "admin_redirect_path": admin_redirect_path,
        "driver_redirect_path": driver_redirect_path,
        "onboarding_enabled": (os.environ.get("ENABLE_ONBOARDING_FLOW", "true").strip().lower() in {"1", "true", "yes", "on"}),
        "register_url_path": register_redirect_path,
        "review_url_path": review_redirect_path,
        "map_style_url": os.environ.get("FRONTEND_MAP_STYLE_URL", "https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json"),
        "dev_auth_enabled": dev_auth_enabled,
        "dev_auth_profiles": _dev_auth_profiles() if dev_auth_enabled else [],
    }


def _as_bool(value: str | None, default: bool = False) -> bool:
    if value is None:
        return default
    return value.strip().lower() in {"1", "true", "yes", "on"}


def _cookie_secure(request: Request) -> bool:
    if _as_bool(os.environ.get("FORCE_SECURE_COOKIES"), default=False):
        return True
    return request.url.scheme == "https"


def _normalize_hosted_domain(value: str) -> str:
    return value.replace("https://", "").replace("http://", "").rstrip("/")


def _exchange_hosted_code_for_token(
    *,
    domain: str,
    client_id: str,
    code: str,
    redirect_uri: str,
    code_verifier: str,
) -> dict:
    form = urllib_parse.urlencode(
        {
            "grant_type": "authorization_code",
            "client_id": client_id,
            "code": code,
            "redirect_uri": redirect_uri,
            "code_verifier": code_verifier,
        }
    ).encode("utf-8")
    token_url = f"https://{_normalize_hosted_domain(domain)}/oauth2/token"
    req = urllib_request.Request(
        token_url,
        data=form,
        method="POST",
        headers={"content-type": "application/x-www-form-urlencoded"},
    )
    try:
        with urllib_request.urlopen(req, timeout=15) as response:
            raw_body = response.read().decode("utf-8")
    except urllib_error.HTTPError as exc:
        body_text = exc.read().decode("utf-8", errors="ignore")
        detail = "Hosted login token exchange failed."
        if body_text:
            try:
                payload = json.loads(body_text)
                detail = payload.get("error_description") or payload.get("error") or detail
            except Exception:
                detail = detail
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=detail) from exc
    except Exception as exc:
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail="Hosted login token exchange failed.",
        ) from exc

    try:
        payload = json.loads(raw_body) if raw_body else {}
    except Exception as exc:
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail="Hosted login returned an invalid response.",
        ) from exc
    if not isinstance(payload, dict):
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail="Hosted login returned an invalid response.",
        )
    return payload


def create_app() -> FastAPI:
    app = FastAPI(
        title="Discra Backend",
        version=os.environ.get("VERSION", "dev"),
    )

    @app.middleware("http")
    async def log_request(request: Request, call_next):
        request_id = (
            request.headers.get("x-correlation-id")
            or request.headers.get("x-request-id")
            or str(uuid.uuid4())
        )
        request.state.request_id = request_id
        started = time.perf_counter()
        response = await call_next(request)
        elapsed_ms = (time.perf_counter() - started) * 1000
        response.headers["x-request-id"] = request_id
        logger.info(
            _json_log(
                {
                    "event": "request",
                    "request_id": request_id,
                    "method": request.method,
                    "path": request.url.path,
                    "status_code": response.status_code,
                    "elapsed_ms": round(elapsed_ms, 2),
                }
            )
        )
        return response

    @app.get("/health")
    async def health():
        return {"ok": True}

    @app.get("/version")
    async def version():
        return {"version": os.environ.get("VERSION", "dev")}

    @app.get("/backend/health")
    async def backend_health():
        return {"ok": True}

    @app.get("/dev/backend/health")
    async def dev_backend_health():
        return {"ok": True}

    @app.get("/backend/version")
    async def backend_version():
        return {"version": os.environ.get("VERSION", "dev")}

    @app.get("/dev/backend/version")
    async def dev_backend_version():
        return {"version": os.environ.get("VERSION", "dev")}

    if FRONTEND_ASSETS_DIR.exists():
        app.mount("/ui/assets", StaticFiles(directory=str(FRONTEND_ASSETS_DIR)), name="ui-assets")
        app.mount("/backend/ui/assets", StaticFiles(directory=str(FRONTEND_ASSETS_DIR)), name="backend-ui-assets")
        app.mount("/dev/backend/ui/assets", StaticFiles(directory=str(FRONTEND_ASSETS_DIR)), name="dev-backend-ui-assets")

    @app.get("/ui", include_in_schema=False)
    async def ui_home():
        return FileResponse(str(FRONTEND_DIR / "index.html"))

    @app.get("/backend/ui", include_in_schema=False)
    async def backend_ui_home():
        return FileResponse(str(FRONTEND_DIR / "index.html"))

    @app.get("/dev/backend/ui", include_in_schema=False)
    async def dev_backend_ui_home():
        return FileResponse(str(FRONTEND_DIR / "index.html"))

    @app.get("/ui/admin", include_in_schema=False)
    async def ui_admin():
        return FileResponse(str(FRONTEND_DIR / "admin.html"))

    @app.get("/backend/ui/admin", include_in_schema=False)
    async def backend_ui_admin():
        return FileResponse(str(FRONTEND_DIR / "admin.html"))

    @app.get("/dev/backend/ui/admin", include_in_schema=False)
    async def dev_backend_ui_admin():
        return FileResponse(str(FRONTEND_DIR / "admin.html"))

    @app.get("/ui/admin-sw.js", include_in_schema=False)
    async def ui_admin_service_worker():
        return FileResponse(str(FRONTEND_DIR / "admin-sw.js"), media_type="application/javascript")

    @app.get("/backend/ui/admin-sw.js", include_in_schema=False)
    async def backend_ui_admin_service_worker():
        return FileResponse(str(FRONTEND_DIR / "admin-sw.js"), media_type="application/javascript")

    @app.get("/dev/backend/ui/admin-sw.js", include_in_schema=False)
    async def dev_backend_ui_admin_service_worker():
        return FileResponse(str(FRONTEND_DIR / "admin-sw.js"), media_type="application/javascript")

    @app.get("/ui/driver", include_in_schema=False)
    async def ui_driver():
        return FileResponse(str(FRONTEND_DIR / "driver.html"))

    @app.get("/backend/ui/driver", include_in_schema=False)
    async def backend_ui_driver():
        return FileResponse(str(FRONTEND_DIR / "driver.html"))

    @app.get("/dev/backend/ui/driver", include_in_schema=False)
    async def dev_backend_ui_driver():
        return FileResponse(str(FRONTEND_DIR / "driver.html"))

    @app.get("/ui/register", include_in_schema=False)
    async def ui_register():
        return FileResponse(str(FRONTEND_DIR / "register.html"))

    @app.get("/backend/ui/register", include_in_schema=False)
    async def backend_ui_register():
        return FileResponse(str(FRONTEND_DIR / "register.html"))

    @app.get("/dev/backend/ui/register", include_in_schema=False)
    async def dev_backend_ui_register():
        return FileResponse(str(FRONTEND_DIR / "register.html"))

    @app.get("/ui/login", include_in_schema=False)
    async def ui_login():
        return FileResponse(str(FRONTEND_DIR / "login.html"))

    @app.get("/backend/ui/login", include_in_schema=False)
    async def backend_ui_login():
        return FileResponse(str(FRONTEND_DIR / "login.html"))

    @app.get("/dev/backend/ui/login", include_in_schema=False)
    async def dev_backend_ui_login():
        return FileResponse(str(FRONTEND_DIR / "login.html"))

    @app.get("/ui/review", include_in_schema=False)
    async def ui_review():
        return FileResponse(str(FRONTEND_DIR / "review.html"))

    @app.get("/backend/ui/review", include_in_schema=False)
    async def backend_ui_review():
        return FileResponse(str(FRONTEND_DIR / "review.html"))

    @app.get("/dev/backend/ui/review", include_in_schema=False)
    async def dev_backend_ui_review():
        return FileResponse(str(FRONTEND_DIR / "review.html"))

    @app.get("/ui/driver-sw.js", include_in_schema=False)
    async def ui_driver_service_worker():
        return FileResponse(str(FRONTEND_DIR / "driver-sw.js"), media_type="application/javascript")

    @app.get("/backend/ui/driver-sw.js", include_in_schema=False)
    async def backend_ui_driver_service_worker():
        return FileResponse(str(FRONTEND_DIR / "driver-sw.js"), media_type="application/javascript")

    @app.get("/dev/backend/ui/driver-sw.js", include_in_schema=False)
    async def dev_backend_ui_driver_service_worker():
        return FileResponse(str(FRONTEND_DIR / "driver-sw.js"), media_type="application/javascript")

    @app.get("/ui/config", include_in_schema=False)
    async def ui_config():
        return _ui_config_payload(
            admin_redirect_path="/ui/admin",
            driver_redirect_path="/ui/driver",
            register_redirect_path="/ui/register",
            review_redirect_path="/ui/review",
        )

    @app.get("/backend/ui/config", include_in_schema=False)
    async def backend_ui_config():
        return _ui_config_payload(
            admin_redirect_path="/backend/ui/admin",
            driver_redirect_path="/backend/ui/driver",
            register_redirect_path="/backend/ui/register",
            review_redirect_path="/backend/ui/review",
        )

    @app.get("/dev/backend/ui/config", include_in_schema=False)
    async def dev_backend_ui_config():
        return _ui_config_payload(
            admin_redirect_path="/dev/backend/ui/admin",
            driver_redirect_path="/dev/backend/ui/driver",
            register_redirect_path="/dev/backend/ui/register",
            review_redirect_path="/dev/backend/ui/review",
        )

    @app.get("/ui/auth/session", include_in_schema=False)
    @app.get("/backend/ui/auth/session", include_in_schema=False)
    @app.get("/dev/backend/ui/auth/session", include_in_schema=False)
    async def ui_auth_session(request: Request, response: Response):
        try:
            identity = await get_optional_authenticated_identity(request)
        except HTTPException as exc:
            if exc.status_code == status.HTTP_401_UNAUTHORIZED:
                response.delete_cookie(key=web_auth_cookie_name(), path="/")
                return {"active": False}
            raise
        return {
            "active": identity is not None,
            "user": _user_response_payload(identity),
        }

    @app.post("/ui/auth/hosted-login/callback", include_in_schema=False)
    @app.post("/backend/ui/auth/hosted-login/callback", include_in_schema=False)
    @app.post("/dev/backend/ui/auth/hosted-login/callback", include_in_schema=False)
    async def ui_auth_hosted_login_callback(request: Request, response: Response):
        try:
            payload = await request.json()
            if not isinstance(payload, dict):
                payload = {}
        except Exception:
            payload = {}

        code = str(payload.get("code") or "").strip()
        state = str(payload.get("state") or "").strip()
        expected_state = str(payload.get("expected_state") or "").strip()
        code_verifier = str(payload.get("code_verifier") or "").strip()
        redirect_uri = str(payload.get("redirect_uri") or "").strip()
        domain = str(payload.get("domain") or "").strip() or str(os.environ.get("COGNITO_HOSTED_UI_DOMAIN") or "").strip()
        client_id = (
            str(payload.get("client_id") or "").strip()
            or str(os.environ.get("FRONTEND_COGNITO_CLIENT_ID") or "").strip()
            or str(os.environ.get("COGNITO_AUDIENCE") or "").strip()
        )

        if not code:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Missing authorization code")
        if not state or not expected_state or state != expected_state:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Hosted login state check failed.")
        if not code_verifier:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Hosted login verifier is missing.")
        if not redirect_uri:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Hosted login redirect URI is missing.")
        if not domain or not client_id:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Hosted login domain/client config is missing.",
            )

        token_payload = _exchange_hosted_code_for_token(
            domain=domain,
            client_id=client_id,
            code=code,
            redirect_uri=redirect_uri,
            code_verifier=code_verifier,
        )
        token = (token_payload.get("id_token") or token_payload.get("access_token") or "").strip()
        if not token:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Hosted login response did not include a token.",
            )

        response.set_cookie(
            key=web_auth_cookie_name(),
            value=token,
            max_age=web_auth_ttl_seconds(),
            httponly=True,
            secure=_cookie_secure(request),
            samesite="lax",
            path="/",
        )
        return {"ok": True}

    @app.post("/ui/auth/logout", include_in_schema=False)
    @app.post("/backend/ui/auth/logout", include_in_schema=False)
    @app.post("/dev/backend/ui/auth/logout", include_in_schema=False)
    async def ui_auth_logout(request: Request, response: Response):
        try:
            payload = await request.json()
            if not isinstance(payload, dict):
                payload = {}
        except Exception:
            payload = {}

        domain = str(payload.get("domain") or "").strip() or str(os.environ.get("COGNITO_HOSTED_UI_DOMAIN") or "").strip()
        client_id = (
            str(payload.get("client_id") or "").strip()
            or str(os.environ.get("FRONTEND_COGNITO_CLIENT_ID") or "").strip()
            or str(os.environ.get("COGNITO_AUDIENCE") or "").strip()
        )
        logout_uri = str(payload.get("logout_uri") or "").strip()

        response.delete_cookie(key=web_auth_cookie_name(), path="/")

        logout_url = ""
        if domain and client_id and logout_uri:
            normalized_domain = _normalize_hosted_domain(domain)
            if normalized_domain:
                target = f"https://{normalized_domain}/logout"
                url = urllib_parse.urlencode({"client_id": client_id, "logout_uri": logout_uri})
                logout_url = f"{target}?{url}"
        return {"ok": True, "logout_url": logout_url}

    @app.get("/ui/dev-auth/session", include_in_schema=False)
    @app.get("/backend/ui/dev-auth/session", include_in_schema=False)
    @app.get("/dev/backend/ui/dev-auth/session", include_in_schema=False)
    async def ui_dev_auth_session(request: Request):
        if not is_dev_auth_enabled():
            return {"active": False}
        user = get_dev_auth_user(request)
        return {
            "active": user is not None,
            "user": _user_response_payload(user),
        }

    @app.post("/ui/dev-auth/login", include_in_schema=False)
    @app.post("/backend/ui/dev-auth/login", include_in_schema=False)
    @app.post("/dev/backend/ui/dev-auth/login", include_in_schema=False)
    async def ui_dev_auth_login(request: Request, response: Response):
        if not is_dev_auth_enabled():
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Dev auth is disabled")

        try:
            payload = await request.json()
            if not isinstance(payload, dict):
                payload = {}
        except Exception:
            payload = {}

        role = normalize_dev_auth_role(payload.get("role"))
        user_id = str(payload.get("user_id") or "").strip() or _default_user_id_for_role(role)
        org_id = str(payload.get("org_id") or "").strip() or dev_auth_default_org_id()
        email_value = str(payload.get("email") or "").strip()
        email = email_value or None

        cookie_value = build_dev_auth_session_value(
            user_id=user_id,
            role=role,
            org_id=org_id,
            email=email,
        )
        response.set_cookie(
            key=dev_auth_cookie_name(),
            value=cookie_value,
            max_age=dev_auth_ttl_seconds(),
            httponly=True,
            secure=_cookie_secure(request),
            samesite="lax",
            path="/",
        )
        return {
            "ok": True,
            "user": {
                "sub": user_id,
                "username": user_id,
                "email": email,
                "org_id": org_id,
                "groups": [role],
            },
        }

    @app.post("/ui/dev-auth/logout", include_in_schema=False)
    @app.post("/backend/ui/dev-auth/logout", include_in_schema=False)
    @app.post("/dev/backend/ui/dev-auth/logout", include_in_schema=False)
    async def ui_dev_auth_logout(response: Response):
        response.delete_cookie(key=dev_auth_cookie_name(), path="/")
        return {"ok": True}

    app.include_router(identity_router)
    app.include_router(orders_router)
    app.include_router(drivers_router)
    app.include_router(pod_router)
    app.include_router(routes_router)
    app.include_router(reports_router)
    app.include_router(billing_router)
    app.include_router(onboarding_router)
    app.include_router(identity_router, prefix="/backend")
    app.include_router(orders_router, prefix="/backend")
    app.include_router(drivers_router, prefix="/backend")
    app.include_router(pod_router, prefix="/backend")
    app.include_router(routes_router, prefix="/backend")
    app.include_router(reports_router, prefix="/backend")
    app.include_router(billing_router, prefix="/backend")
    app.include_router(onboarding_router, prefix="/backend")
    app.include_router(identity_router, prefix="/dev/backend")
    app.include_router(orders_router, prefix="/dev/backend")
    app.include_router(drivers_router, prefix="/dev/backend")
    app.include_router(pod_router, prefix="/dev/backend")
    app.include_router(routes_router, prefix="/dev/backend")
    app.include_router(reports_router, prefix="/dev/backend")
    app.include_router(billing_router, prefix="/dev/backend")
    app.include_router(onboarding_router, prefix="/dev/backend")

    return app


app = create_app()

_lambda_adapter = None


def _get_lambda_adapter():
    global _lambda_adapter
    if _lambda_adapter is not None:
        return _lambda_adapter

    # Mangum uses asyncio.get_event_loop() internally. On newer Python versions,
    # ensure a loop exists before constructing the adapter.
    try:
        asyncio.get_running_loop()
    except RuntimeError:
        asyncio.set_event_loop(asyncio.new_event_loop())

    _lambda_adapter = Mangum(app, lifespan="off")
    return _lambda_adapter


# Lambda entrypoint for AWS SAM/API Gateway HTTP API.
def handler(event, context):
    return _get_lambda_adapter()(event, context)
