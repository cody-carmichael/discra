import asyncio
import json
import logging
import os
import time
import uuid
from pathlib import Path

from fastapi import FastAPI, Request
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from mangum import Mangum

try:
    from backend.routers import (
        billing_router,
        drivers_router,
        identity_router,
        orders_router,
        pod_router,
        reports_router,
        routes_router,
    )
except ModuleNotFoundError:  # local run from backend/ directory
    from routers import billing_router, drivers_router, identity_router, orders_router, pod_router, reports_router, routes_router

LOG_LEVEL = os.environ.get("LOG_LEVEL", "INFO").upper()
logging.basicConfig(level=LOG_LEVEL)
logger = logging.getLogger("discra.backend")
FRONTEND_DIR = Path(__file__).resolve().parent / "frontend"
FRONTEND_ASSETS_DIR = FRONTEND_DIR / "assets"


def _json_log(fields):
    return json.dumps(fields, separators=(",", ":"))


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

    if FRONTEND_ASSETS_DIR.exists():
        app.mount("/ui/assets", StaticFiles(directory=str(FRONTEND_ASSETS_DIR)), name="ui-assets")

    @app.get("/ui", include_in_schema=False)
    async def ui_home():
        return FileResponse(str(FRONTEND_DIR / "index.html"))

    @app.get("/ui/admin", include_in_schema=False)
    async def ui_admin():
        return FileResponse(str(FRONTEND_DIR / "admin.html"))

    @app.get("/ui/admin-sw.js", include_in_schema=False)
    async def ui_admin_service_worker():
        return FileResponse(str(FRONTEND_DIR / "admin-sw.js"), media_type="application/javascript")

    @app.get("/ui/driver", include_in_schema=False)
    async def ui_driver():
        return FileResponse(str(FRONTEND_DIR / "driver.html"))

    @app.get("/ui/driver-sw.js", include_in_schema=False)
    async def ui_driver_service_worker():
        return FileResponse(str(FRONTEND_DIR / "driver-sw.js"), media_type="application/javascript")

    @app.get("/ui/config", include_in_schema=False)
    async def ui_config():
        return {
            "cognito_domain": os.environ.get("COGNITO_HOSTED_UI_DOMAIN", ""),
            "cognito_client_id": os.environ.get("FRONTEND_COGNITO_CLIENT_ID")
            or os.environ.get("COGNITO_AUDIENCE", ""),
            "admin_redirect_path": "/ui/admin",
            "driver_redirect_path": "/ui/driver",
            "map_style_url": os.environ.get("FRONTEND_MAP_STYLE_URL", "https://demotiles.maplibre.org/style.json"),
        }

    app.include_router(identity_router)
    app.include_router(orders_router)
    app.include_router(drivers_router)
    app.include_router(pod_router)
    app.include_router(routes_router)
    app.include_router(reports_router)
    app.include_router(billing_router)

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
