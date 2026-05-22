[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$ApiBaseUrl,
    [string]$AdminToken = "",
    [string]$OrdersWebhookToken = "",
    [string]$OrdersWebhookHmacSecret = "",
    [string]$OrgId = "org-smoke",
    [int]$TimeoutSeconds = 60
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

# Use Invoke-RestMethod rather than Invoke-WebRequest. On Windows PowerShell
# 5.1 (still the default on most Windows installs), Invoke-WebRequest throws
# `NullReferenceException` from inside the cmdlet itself before any HTTP
# call is made, regardless of strict mode or splat shape. Invoke-RestMethod
# is unaffected and is sufficient here because the script only needs the
# parsed body. We treat "no exception" as HTTP 200; any non-2xx response
# from Invoke-RestMethod throws and is caught by the script's $ErrorActionPreference.
function Invoke-SmokeRequest {
    param(
        [string]$Method,
        [string]$Path,
        [hashtable]$Headers = $null,
        [string]$Body = ""
    )

    $uri = "$script:BaseUrl$Path"
    Write-Host "Checking $Method $uri"

    $invokeArgs = @{
        Uri         = $uri
        Method      = $Method
        TimeoutSec  = $script:TimeoutSeconds
        ErrorAction = "Stop"
    }
    if ($Headers -and $Headers.Count -gt 0) {
        $invokeArgs.Headers = $Headers
    }
    if (Is-Present $Body) {
        $invokeArgs.Body = $Body
        $invokeArgs.ContentType = "application/json"
    }

    $parsed = Invoke-RestMethod @invokeArgs

    # Synthesize a response-like object so callers can use $resp.StatusCode
    # and treat $resp.Content as a JSON string when needed. If we reach this
    # line Invoke-RestMethod did not throw, so HTTP status was 2xx.
    $rawContent = if ($null -eq $parsed) { "" } else { ConvertTo-Json -InputObject $parsed -Depth 20 -Compress }
    return [pscustomobject]@{
        StatusCode = 200
        Content    = $rawContent
        Parsed     = $parsed
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

$script:BaseUrl = Normalize-BaseUrl -Value $ApiBaseUrl
$script:TimeoutSeconds = $TimeoutSeconds
$script:Results = @()

Write-Host "Smoke target: $script:BaseUrl"

$backendHealth = Invoke-SmokeRequest -Method "GET" -Path "/backend/health"
Assert-Status -Name "Backend /backend/health" -Response $backendHealth
Add-Result -Check "GET /backend/health" -Outcome "PASS"

$backendVersion = Invoke-SmokeRequest -Method "GET" -Path "/backend/version"
Assert-Status -Name "Backend /backend/version" -Response $backendVersion
Add-Result -Check "GET /backend/version" -Outcome "PASS"

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
                reference_id      = "SMOKE-$($now.ToUnixTimeSeconds())"
                pick_up_street    = "1 Market St"
                pick_up_city      = "San Francisco"
                pick_up_state     = "CA"
                pick_up_zip       = "94105"
                delivery_street   = "1 Ferry Building"
                delivery_city     = "San Francisco"
                delivery_state    = "CA"
                delivery_zip      = "94111"
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

    $webhookBody = $webhookResponse.Parsed
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
$script:Results | Format-Table -AutoSize
Write-Host ""
Write-Host "All required smoke checks passed."
