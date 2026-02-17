<!--
This file guides AI coding agents (Copilot/assistant bots) so they become productive quickly.
It was generated with repository-specific details from `cody-carmichael/discra`.
-->

# AI Coding Agent Instructions (repo: discra)

Purpose: Help an AI agent quickly understand and work on this repository (Java 21 + Maven + AWS SAM Lambdas).

- Repo type & entrypoints:
  - Language: Java 21 (see `pom.xml`).
  - Packaging: fat JAR named `app` created by Maven shade plugin (`target/app.jar`).
  - Lambda handlers live in `src/main/java/com/discra/api/`:
    - `HealthHandler.java` — `com.discra.api.HealthHandler::handleRequest` (GET /health)
    - `VersionHandler.java` — `com.discra.api.VersionHandler::handleRequest` (GET /version)
    - `AdminPingHandler.java` — `com.discra.api.AdminPingHandler::handleRequest` (GET /admin/ping, requires `ADMIN_TOKEN`)
  - Infrastructure: AWS SAM template in `template.yaml` and `samconfig.toml` — use SAM for local testing and deploys.

- Quick build & test (PowerShell)
  - Build and run unit tests:
    - mvn clean package
  - The repository produces `target/app.jar` (finalName `app`) via `maven-shade-plugin`.
  - Local SAM run (requires AWS SAM CLI and Docker):
    - sam build -t template.yaml
    - sam local start-api --template template.yaml
  - Example curl tests (after `sam local start-api` on default localhost:3000):
    - GET health:
      - curl http://127.0.0.1:3000/dev/health
    - GET version:
      - curl http://127.0.0.1:3000/dev/version
    - GET admin ping (requires admin token env set in SAM or via `--env-vars`):
      - curl -H "x-admin-token: <ADMIN_TOKEN>" http://127.0.0.1:3000/dev/admin/ping

- Code patterns & conventions (discoverable in repo)
  - Handlers implement `com.amazonaws.services.lambda.runtime.RequestHandler<APIGatewayV2HTTPEvent, APIGatewayV2HTTPResponse>`.
  - Handlers build responses with `APIGatewayV2HTTPResponse.builder()` and set headers including CORS.
  - `AdminPingHandler` reads `ADMIN_TOKEN` from environment and checks header `x-admin-token`.
  - To add new endpoints: implement a new handler in `src/main/java/com/discra/api`, then add the resource/event mapping in `template.yaml`.

- CI commands (exact commands extracted from `.github/workflows/*`)
  - `.github/workflows/ci.yml`
    - The workflow detects the `pom.xml` location and then runs:
      - mvn -B -f "$POM_PATH" clean verify
    - (It uses `actions/setup-java@v4` with `distribution: temurin` and `java-version: '21'`, caching `maven`.)
  - `.github/workflows/deploy-dev.yml`
    - Key commands / sequence used in CI:
      - sam build -t "$TEMPLATE_PATH" --no-cached --debug
      - sam validate --lint --template-file .aws-sam/build/template.yaml
      - (checks that handler classes exist in `.aws-sam/build`)
      - sam deploy --template-file .aws-sam/build/template.yaml --stack-name "$STACK_NAME" --region "$AWS_REGION" --capabilities CAPABILITY_IAM --no-confirm-changeset --no-fail-on-empty-changeset --resolve-s3 --force-upload --parameter-overrides Version="${{ github.sha }}" AdminToken="${{ secrets.ADMIN_TOKEN }}"
    - (Workflow also uses `aws-actions/setup-sam@v2`, `aws-actions/configure-aws-credentials@v4` with OIDC role assumption, and `actions/setup-java@v4` for Java.)
  - `.github/workflows/validate-openapi.yml`
    - Commands used:
      - npm -g install @stoplight/spectral-cli
      - spectral lint docs/api-contract.yaml

- Integration & infra notes
  - AWS SAM (`template.yaml`) defines `HttpApi` and `AWS::Serverless::Function` resources (Health, Version, AdminPing).
  - The project expects `ADMIN_TOKEN` and `VERSION` environment variables (see `template.yaml`).
  - For deploy jobs, CI uses OIDC to assume a deploy role and runs `sam build` + `sam deploy` with parameter overrides.

- Recommended PR workflow for AI-generated changes
  - Create a small focused branch (e.g., `bot/fix-xxx`).
  - Run `mvn -DskipTests=false test` and `mvn package` locally.
  - If runtime changes are made, run `sam local start-api` and execute the curl tests above to verify behavior.
  - Add/modify unit tests under `src/test/java` (or `test` if used) to exercise behavior.
  - Mirror the CI steps locally (see CI commands above) and include them in the PR description.

- Safety & merging
  - Do not modify `template.yaml` deploy-sensitive settings without noting security implications (Admin tokens, IAM roles).
  - Avoid hardcoding secrets — use `samconfig.toml`, parameter overrides, or CI secrets.

- What I looked at (useful files to check first)
  - `pom.xml` — build and dependencies (Java 21; AWS Lambda libs; Shade plugin).
  - `template.yaml` — SAM mappings and environment variables/paths.
  - `src/main/java/com/discra/api/*.java` — handler implementations (Health, Version, AdminPing).
  - `.github/workflows/*` — CI steps (listed above) to mirror locally.
  - `tools/openapi/` and `docs/` — API docs and openapi tooling.

If you want me to tweak the content (e.g., add more precise `sam deploy` flags, or include tests/coverage commands), tell me which details to expand and I will update the file text.
