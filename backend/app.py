import json
import logging
import os
import time
import uuid

from fastapi import FastAPI, Request
from mangum import Mangum

try:
    from backend.routers import (
        billing_router,
        drivers_router,
        identity_router,
        orders_router,
        pod_router,
        routes_router,
    )
except ModuleNotFoundError:  # local run from backend/ directory
    from routers import billing_router, drivers_router, identity_router, orders_router, pod_router, routes_router

LOG_LEVEL = os.environ.get("LOG_LEVEL", "INFO").upper()
logging.basicConfig(level=LOG_LEVEL)
logger = logging.getLogger("discra.backend")


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

    app.include_router(identity_router)
    app.include_router(orders_router)
    app.include_router(drivers_router)
    app.include_router(pod_router)
    app.include_router(routes_router)
    app.include_router(billing_router)

    return app


app = create_app()

# Lambda entrypoint for AWS SAM/API Gateway HTTP API.
handler = Mangum(app, lifespan="off")
