[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$ApiBaseUrl,
    [string]$AdminToken = "",
    [string]$OrdersWebhookToken = "",
    [string]$OrdersWebhookHmacSecret = "",
    [string]$OrgId = "org-smoke",
    [int]$TimeoutSeconds = 20
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

function Normalize-BaseUrl {
    param([string]$Value)
    return ($Value.Trim()).TrimEnd("/")
}

function Is-Present {
    param([string]$Value)
    return -not [string]::IsNullOrWhiteSpace($Value)
}

function Invoke-SmokeRequest {
    param(
        [string]$Method,
        [string]$Path,
        [hashtable]$Headers = @{},
        [string]$Body = ""
    )

    $uri = "$script:BaseUrl$Path"
    $request = @{
        Uri         = $uri
        Method      = $Method
        Headers     = $Headers
        TimeoutSec  = $script:TimeoutSeconds
        ErrorAction = "Stop"
    }

    if (Is-Present $Body) {
        $request.Body = $Body
        $request.ContentType = "application/json"
    }

    Write-Host "Checking $Method $uri"
    return Invoke-WebRequest @request
}

function Read-JsonOrNull {
    param([string]$RawText)
    if (-not (Is-Present $RawText)) {
        return $null
    }
    try {
        return $RawText | ConvertFrom-Json -Depth 20
    }
    catch {
        return $null
    }
}

function Assert-Status {
    param(
        [string]$Name,
        $Response,
        [int]$ExpectedStatus = 200
    )
    if ($Response.StatusCode -ne $ExpectedStatus) {
        throw "$Name returned HTTP $($Response.StatusCode), expected $ExpectedStatus."
    }
}

function New-WebhookSignature {
    param(
        [string]$Secret,
        [string]$Timestamp,
        [string]$RawBody
    )

    $message = "$Timestamp.$RawBody"
    $encoding = [System.Text.Encoding]::UTF8
    $keyBytes = $encoding.GetBytes($Secret)
    $dataBytes = $encoding.GetBytes($message)

    $hmac = [System.Security.Cryptography.HMACSHA256]::new($keyBytes)
    try {
        $hashBytes = $hmac.ComputeHash($dataBytes)
        return ([System.BitConverter]::ToString($hashBytes)).Replace("-", "").ToLowerInvariant()
    }
    finally {
        $hmac.Dispose()
    }
}

function Add-Result {
    param(
        [string]$Check,
        [string]$Outcome,
        [string]$Notes = ""
    )
    $script:Results += [pscustomobject]@{
        Check   = $Check
        Outcome = $Outcome
        Notes   = $Notes
    }
}

$BaseUrl = Normalize-BaseUrl -Value $ApiBaseUrl
$TimeoutSeconds = $TimeoutSeconds
$Results = @()

Write-Host "Smoke target: $BaseUrl"

$legacyHealth = Invoke-SmokeRequest -Method "GET" -Path "/health"
Assert-Status -Name "Legacy /health" -Response $legacyHealth
Add-Result -Check "GET /health" -Outcome "PASS"

$legacyVersion = Invoke-SmokeRequest -Method "GET" -Path "/version"
Assert-Status -Name "Legacy /version" -Response $legacyVersion
Add-Result -Check "GET /version" -Outcome "PASS"

$backendHealth = Invoke-SmokeRequest -Method "GET" -Path "/backend/health"
Assert-Status -Name "Backend /backend/health" -Response $backendHealth
Add-Result -Check "GET /backend/health" -Outcome "PASS"

$backendVersion = Invoke-SmokeRequest -Method "GET" -Path "/backend/version"
Assert-Status -Name "Backend /backend/version" -Response $backendVersion
Add-Result -Check "GET /backend/version" -Outcome "PASS"

if (Is-Present $AdminToken) {
    $adminPing = Invoke-SmokeRequest -Method "GET" -Path "/admin/ping" -Headers @{ "x-admin-token" = $AdminToken }
    Assert-Status -Name "Legacy /admin/ping" -Response $adminPing
    Add-Result -Check "GET /admin/ping" -Outcome "PASS"
}
else {
    Add-Result -Check "GET /admin/ping" -Outcome "SKIP" -Notes "Admin token not provided"
}

if (Is-Present $OrdersWebhookToken) {
    $now = [DateTimeOffset]::UtcNow
    $externalId = "smoke-$($now.ToUnixTimeSeconds())-$([guid]::NewGuid().ToString('N').Substring(0, 8))"

    $payload = [ordered]@{
        org_id = $OrgId
        source = "smoke-script"
        orders = @(
            [ordered]@{
                external_order_id = $externalId
                customer_name     = "Smoke Test Order"
                reference_number  = 100001
                pick_up_address   = "1 Market St, San Francisco, CA"
                delivery          = "1 Ferry Building, San Francisco, CA"
                dimensions        = "10x10x10 in"
                weight            = 2.5
                notes             = "Created by smoke check"
                num_packages      = 1
            }
        )
    }

    $rawPayload = $payload | ConvertTo-Json -Depth 10 -Compress
    $webhookHeaders = @{ "x-orders-webhook-token" = $OrdersWebhookToken }

    if (Is-Present $OrdersWebhookHmacSecret) {
        $timestamp = $now.ToUnixTimeSeconds().ToString()
        $signature = New-WebhookSignature -Secret $OrdersWebhookHmacSecret -Timestamp $timestamp -RawBody $rawPayload
        $webhookHeaders["x-orders-webhook-timestamp"] = $timestamp
        $webhookHeaders["x-orders-webhook-signature"] = "sha256=$signature"
    }

    $webhookResponse = Invoke-SmokeRequest -Method "POST" -Path "/backend/webhooks/orders" -Headers $webhookHeaders -Body $rawPayload
    Assert-Status -Name "POST /backend/webhooks/orders" -Response $webhookResponse

    $webhookBody = Read-JsonOrNull -RawText $webhookResponse.Content
    if ($null -eq $webhookBody) {
        throw "POST /backend/webhooks/orders returned non-JSON body."
    }
    if ([int]$webhookBody.accepted -lt 1) {
        throw "POST /backend/webhooks/orders accepted less than 1 order."
    }

    $notes = "accepted=$($webhookBody.accepted), created=$($webhookBody.created), updated=$($webhookBody.updated)"
    Add-Result -Check "POST /backend/webhooks/orders" -Outcome "PASS" -Notes $notes
}
else {
    Add-Result -Check "POST /backend/webhooks/orders" -Outcome "SKIP" -Notes "Orders webhook token not provided"
}

Write-Host ""
Write-Host "Smoke check summary:"
$Results | Format-Table -AutoSize
Write-Host ""
Write-Host "All required smoke checks passed."
