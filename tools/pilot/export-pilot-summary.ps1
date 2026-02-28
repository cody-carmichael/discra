[CmdletBinding()]
param(
    [string]$StackName = "discra-api-dev",
    [string]$Region = "us-east-1",
    [string]$OutputPath = "tools/pilot/.generated/pilot-summary.md"
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

function Get-CommandRequired {
    param([string]$CommandName)
    if (-not (Get-Command $CommandName -ErrorAction SilentlyContinue)) {
        throw "Required command '$CommandName' was not found on PATH."
    }
}

Get-CommandRequired -CommandName "aws"

$describeArgs = @(
    "cloudformation",
    "describe-stacks",
    "--stack-name", $StackName,
    "--region", $Region,
    "--output", "json"
)

$rawJson = aws @describeArgs
if (-not $rawJson) {
    throw "No CloudFormation response returned for stack '$StackName'."
}

$describe = $rawJson | ConvertFrom-Json -Depth 20
if (-not $describe.Stacks -or $describe.Stacks.Count -eq 0) {
    throw "Stack '$StackName' not found."
}

$stack = $describe.Stacks[0]
$outputs = @{}
foreach ($entry in $stack.Outputs) {
    $outputs[$entry.OutputKey] = $entry.OutputValue
}

$generatedAt = [DateTimeOffset]::UtcNow.ToString("yyyy-MM-dd HH:mm:ss 'UTC'")
$baseEndpoint = if ($outputs.ContainsKey("ApiEndpoint")) { ($outputs["ApiEndpoint"]).TrimEnd("/") } else { "" }
$devBaseUrl = if ($baseEndpoint) { "$baseEndpoint/dev" } else { "" }

$lines = @(
    "# Discra Pilot Summary",
    "",
    "- generated_at: $generatedAt",
    "- stack_name: $StackName",
    "- aws_region: $Region",
    ""
)

if ($outputs.ContainsKey("ApiId")) {
    $lines += "- api_id: $($outputs["ApiId"])"
}
if ($devBaseUrl) {
    $lines += "- api_base_url: $devBaseUrl"
}

$lines += ""
$lines += "## Key URLs"
$lines += ""

$keyUrls = @(
    "HealthUrl",
    "VersionUrl",
    "BackendHealthUrl",
    "BackendVersionUrl",
    "AdminUiUrl",
    "DriverUiUrl",
    "OrdersWebhookUrl"
)

foreach ($key in $keyUrls) {
    if ($outputs.ContainsKey($key)) {
        $lines += ("- {0}: {1}" -f $key, $outputs[$key])
    }
}

$lines += ""
$lines += "## Quick checks"
$lines += ""
if ($devBaseUrl) {
    $lines += '```powershell'
    $lines += ('tools\smoke\run-smoke.ps1 -ApiBaseUrl "{0}" -AdminToken "<ADMIN_TOKEN>" -OrdersWebhookToken "<ORDERS_WEBHOOK_TOKEN>"' -f $devBaseUrl)
    $lines += '```'
}
else {
    $lines += "- ApiEndpoint output not found on stack; cannot compose smoke command."
}

$parent = Split-Path -Parent $OutputPath
if ($parent -and -not (Test-Path $parent)) {
    New-Item -Path $parent -ItemType Directory | Out-Null
}

Set-Content -Path $OutputPath -Value $lines -Encoding UTF8
Write-Host "Wrote pilot summary: $OutputPath"
