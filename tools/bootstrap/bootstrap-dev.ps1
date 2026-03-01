param(
    [Parameter(Mandatory = $false)]
    [string]$StackName = "discra-api-dev",

    [Parameter(Mandatory = $false)]
    [string]$Region = "us-east-1",

    [Parameter(Mandatory = $true)]
    [string]$CognitoUserPoolId,

    [Parameter(Mandatory = $true)]
    [string]$CognitoAppClientId,

    [Parameter(Mandatory = $false)]
    [string]$Version = "",

    [Parameter(Mandatory = $false)]
    [string]$AdminToken = "",

    [Parameter(Mandatory = $false)]
    [string]$OrdersWebhookToken = "",

    [Parameter(Mandatory = $false)]
    [string]$OrdersWebhookHmacSecret = "",

    [Parameter(Mandatory = $false)]
    [string]$OrdersWebhookMaxSkewSeconds = "300",

    [Parameter(Mandatory = $false)]
    [string]$LocationRouteCalculatorName = "",

    [Parameter(Mandatory = $false)]
    [string]$LocationPlaceIndexName = "",

    [Parameter(Mandatory = $false)]
    [string]$StripeSecretKey = "",

    [Parameter(Mandatory = $false)]
    [string]$StripeWebhookSecret = "",

    [Parameter(Mandatory = $false)]
    [string]$StripeDispatcherPriceId = "",

    [Parameter(Mandatory = $false)]
    [string]$StripeDriverPriceId = "",

    [Parameter(Mandatory = $false)]
    [string]$CognitoHostedUiDomain = "",

    [Parameter(Mandatory = $false)]
    [string]$FrontendMapStyleUrl = "https://demotiles.maplibre.org/style.json",

    [Parameter(Mandatory = $false)]
    [string]$OutFile = "tools/bootstrap/.generated/sam-parameter-overrides.txt",

    [Parameter(Mandatory = $false)]
    [switch]$SkipCognitoGroupBootstrap,

    [Parameter(Mandatory = $false)]
    [switch]$SkipSecretAutoGenerate
)

$ErrorActionPreference = "Stop"

function Require-Command {
    param([string]$Name)

    if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) {
        throw "Required command '$Name' was not found in PATH."
    }
}

function Invoke-AwsCli {
    param(
        [Parameter(Mandatory = $true)]
        [string[]]$Arguments,

        [Parameter(Mandatory = $false)]
        [switch]$IgnoreErrors
    )

    $output = & aws @Arguments 2>&1
    $exitCode = $LASTEXITCODE
    $outputText = ($output | Out-String).Trim()
    if ($exitCode -ne 0 -and -not $IgnoreErrors) {
        throw "AWS CLI command failed (exit $exitCode): aws $($Arguments -join ' ')`n$outputText"
    }
    return @{
        ExitCode = $exitCode
        OutputText = $outputText
    }
}

function New-SecretValue {
    param([int]$Bytes = 24)

    $buffer = New-Object byte[] $Bytes
    [System.Security.Cryptography.RandomNumberGenerator]::Fill($buffer)
    return [Convert]::ToBase64String($buffer).TrimEnd("=")
}

function Mask-Secret {
    param([string]$Value)

    if (-not $Value) {
        return ""
    }
    if ($Value.Length -le 8) {
        return "********"
    }
    return $Value.Substring(0, 4) + "..." + $Value.Substring($Value.Length - 4)
}

function Read-OverrideFile {
    param([string]$Path)

    if (-not (Test-Path $Path)) {
        return @{}
    }

    $values = @{}
    foreach ($line in Get-Content -Path $Path) {
        $text = ""
        if ($null -ne $line) {
            $text = [string]$line
        }
        $trimmed = $text.Trim()
        if (-not $trimmed) {
            continue
        }
        $eqIndex = $trimmed.IndexOf("=")
        if ($eqIndex -lt 1) {
            continue
        }
        $name = $trimmed.Substring(0, $eqIndex).Trim()
        $value = $trimmed.Substring($eqIndex + 1)
        $values[$name] = $value
    }
    return $values
}

function Resolve-ConfigValue {
    param(
        [string]$ExplicitValue,
        [hashtable]$ExistingValues,
        [string]$Key,
        [switch]$GenerateIfMissing
    )

    if ($ExplicitValue) {
        return $ExplicitValue
    }
    if ($ExistingValues.ContainsKey($Key) -and $ExistingValues[$Key]) {
        return $ExistingValues[$Key]
    }
    if ($GenerateIfMissing -and -not $SkipSecretAutoGenerate) {
        return New-SecretValue
    }
    return ""
}

function Ensure-CognitoGroup {
    param(
        [string]$UserPoolId,
        [string]$GroupName,
        [string]$AwsRegion
    )

    $getResult = Invoke-AwsCli -Arguments @(
        "cognito-idp",
        "get-group",
        "--user-pool-id", $UserPoolId,
        "--group-name", $GroupName,
        "--region", $AwsRegion
    ) -IgnoreErrors

    if ($getResult.ExitCode -eq 0) {
        Write-Host "Cognito group '$GroupName' already exists."
        return
    }

    if ($getResult.OutputText -match "ResourceNotFoundException") {
        Invoke-AwsCli -Arguments @(
            "cognito-idp",
            "create-group",
            "--user-pool-id", $UserPoolId,
            "--group-name", $GroupName,
            "--description", "Discra role group: $GroupName",
            "--region", $AwsRegion
        ) | Out-Null
        Write-Host "Created Cognito group '$GroupName'."
        return
    }

    throw "Failed to verify Cognito group '$GroupName': $($getResult.OutputText)"
}

Require-Command -Name "aws"
Require-Command -Name "sam"

$existingValues = Read-OverrideFile -Path $OutFile

if (-not $Version) {
    $Version = "local-" + (Get-Date -Format "yyyyMMddHHmmss")
}

$resolvedAdminToken = Resolve-ConfigValue -ExplicitValue $AdminToken -ExistingValues $existingValues -Key "AdminToken" -GenerateIfMissing
$resolvedOrdersWebhookToken = Resolve-ConfigValue -ExplicitValue $OrdersWebhookToken -ExistingValues $existingValues -Key "OrdersWebhookToken" -GenerateIfMissing
$resolvedOrdersWebhookHmacSecret = Resolve-ConfigValue -ExplicitValue $OrdersWebhookHmacSecret -ExistingValues $existingValues -Key "OrdersWebhookHmacSecret" -GenerateIfMissing

if (-not $SkipCognitoGroupBootstrap) {
    Write-Host "Ensuring Cognito groups exist in pool '$CognitoUserPoolId' ($Region)..."
    Ensure-CognitoGroup -UserPoolId $CognitoUserPoolId -GroupName "Admin" -AwsRegion $Region
    Ensure-CognitoGroup -UserPoolId $CognitoUserPoolId -GroupName "Dispatcher" -AwsRegion $Region
    Ensure-CognitoGroup -UserPoolId $CognitoUserPoolId -GroupName "Driver" -AwsRegion $Region
}

$deployParameters = [ordered]@{
    Version = $Version
    AdminToken = $resolvedAdminToken
    CognitoUserPoolId = $CognitoUserPoolId
    CognitoAppClientId = $CognitoAppClientId
    LocationRouteCalculatorName = $LocationRouteCalculatorName
    LocationPlaceIndexName = $LocationPlaceIndexName
    StripeSecretKey = $StripeSecretKey
    StripeWebhookSecret = $StripeWebhookSecret
    StripeDispatcherPriceId = $StripeDispatcherPriceId
    StripeDriverPriceId = $StripeDriverPriceId
    OrdersWebhookToken = $resolvedOrdersWebhookToken
    OrdersWebhookHmacSecret = $resolvedOrdersWebhookHmacSecret
    OrdersWebhookMaxSkewSeconds = $OrdersWebhookMaxSkewSeconds
    CognitoHostedUiDomain = $CognitoHostedUiDomain
    FrontendMapStyleUrl = $FrontendMapStyleUrl
}

$outDirectory = Split-Path -Path $OutFile -Parent
if ($outDirectory) {
    New-Item -ItemType Directory -Path $outDirectory -Force | Out-Null
}

$lines = @()
foreach ($key in $deployParameters.Keys) {
    $value = [string]$deployParameters[$key]
    $cleanValue = $value.Replace("`r", "").Replace("`n", "")
    $lines += "$key=$cleanValue"
}

Set-Content -Path $OutFile -Value $lines -Encoding UTF8

Write-Host ""
Write-Host "Bootstrap complete."
Write-Host "Parameter overrides file: $OutFile"
Write-Host ""
Write-Host "Secret summary:"
Write-Host "  AdminToken: $(Mask-Secret $resolvedAdminToken)"
Write-Host "  OrdersWebhookToken: $(Mask-Secret $resolvedOrdersWebhookToken)"
Write-Host "  OrdersWebhookHmacSecret: $(Mask-Secret $resolvedOrdersWebhookHmacSecret)"
Write-Host ""
Write-Host "Next deploy command:"
Write-Host "  `$overrides = Get-Content `"$OutFile`""
Write-Host "  sam deploy --template-file .aws-sam/build/template.yaml --stack-name $StackName --region $Region --capabilities CAPABILITY_IAM --resolve-s3 --parameter-overrides `$overrides"
