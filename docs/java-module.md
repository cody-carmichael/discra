# Java module (Discra) - module notes

This project contains a Java AWS SAM Lambda implementation under `src/main/java/com/discra`.

Handlers (found in `src/main/java/com/discra/api`):
- `HealthHandler` -> GET `/health`
- `VersionHandler` -> GET `/version` (reads `VERSION` env var)
- `AdminPingHandler` -> GET `/admin/ping` (requires `ADMIN_TOKEN` header `x-admin-token`)

Quick local build & test (PowerShell):
- Build & run unit tests for the Java code (use POM at repository root or module if present):
  - If a top-level `pom.xml` exists: `mvn -B -f "pom.xml" clean verify`
  - If a module `pom.xml` exists under a subdirectory, pass `-f "<path>/pom.xml"`.

SAM local run (from repository root):
- Build SAM artifacts:
  - `sam build -t template.yaml`
- Start local HTTP API:
  - `sam local start-api --template template.yaml`
- Test endpoints (after `sam local start-api`):
  - `curl http://127.0.0.1:3000/dev/health`
  - `curl http://127.0.0.1:3000/dev/version`
  - `curl -H "x-admin-token: <ADMIN_TOKEN>" http://127.0.0.1:3000/dev/admin/ping`

CI notes:
- Java build is driven by `.github/workflows/ci.yml` which detects the `pom.xml` and runs `mvn -B -f "$POM_PATH" clean verify`.

Notes for contributors:
- The repo now includes a Python FastAPI scaffold under `backend/` (FastAPI + Mangum). See `backend/README.md` for Python dev/test instructions.
- If you prefer a module-local README, consider adding `README.md` inside the Java module directory (e.g., alongside its `pom.xml`).
