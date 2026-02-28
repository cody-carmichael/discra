# Bootstrap Helpers

`bootstrap-dev.ps1` prepares common dev/pilot prerequisites before `sam deploy`:

- Ensures Cognito groups exist: `Admin`, `Dispatcher`, `Driver`
- Generates/reuses secrets for:
  - `AdminToken`
  - `OrdersWebhookToken`
  - `OrdersWebhookHmacSecret`
- Writes a SAM parameter override file (one `Key=Value` per line)

## Prerequisites

- AWS CLI (`aws`) installed and authenticated
- AWS SAM CLI (`sam`) installed
- Target Cognito user pool + app client already created

## Usage

```powershell
tools\bootstrap\bootstrap-dev.ps1 `
  -CognitoUserPoolId "us-east-1_abc123" `
  -CognitoAppClientId "1h57kf5cpq17m0eml12EXAMPLE"
```

Optional flags:

```powershell
# Skip Cognito group creation check
-SkipCognitoGroupBootstrap

# Do not auto-generate missing secrets
-SkipSecretAutoGenerate

# Override output file path
-OutFile "tools/bootstrap/.generated/sam-parameter-overrides.txt"
```

## Deploy with generated overrides

```powershell
$overrides = Get-Content "tools/bootstrap/.generated/sam-parameter-overrides.txt"
sam build -t template.yaml --use-container
sam deploy `
  --template-file .aws-sam/build/template.yaml `
  --stack-name discra-api-dev `
  --region us-east-1 `
  --capabilities CAPABILITY_IAM `
  --resolve-s3 `
  --parameter-overrides $overrides
```
