import asyncio
import json
import logging
import os
import time
import uuid
from pathlib import Path

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
        is_dev_auth_enabled,
        normalize_dev_auth_role,
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
        is_dev_auth_enabled,
        normalize_dev_auth_role,
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
        "map_style_url": os.environ.get("FRONTEND_MAP_STYLE_URL", "https://demotiles.maplibre.org/style.json"),
        "dev_auth_enabled": dev_auth_enabled,
        "dev_auth_profiles": _dev_auth_profiles() if dev_auth_enabled else [],
    }


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
            secure=request.url.scheme == "https",
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
