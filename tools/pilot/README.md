# Pilot tools

- `seed_orders_webhook.py`:
  - Sends batches of demo orders to `/backend/webhooks/orders`.
- `export-pilot-summary.ps1`:
  - Pulls CloudFormation stack outputs and writes a tester-friendly summary markdown file.

Example:

```powershell
tools\pilot\export-pilot-summary.ps1 `
  -StackName "discra-api-dev" `
  -Region "us-east-1"
```
