<#
.SYNOPSIS
  Apply Discra dark theme CSS to Cognito Hosted UI.

.DESCRIPTION
  Uses aws cognito-idp set-ui-customization to apply the dark theme CSS
  to the Cognito Hosted UI for the Discra user pool.

.PARAMETER UserPoolId
  Cognito User Pool ID (e.g., us-east-1_ABC123)

.PARAMETER ClientId
  Cognito App Client ID. Use "ALL" to apply to all clients.

.PARAMETER CssFile
  Path to the CSS file. Defaults to cognito-dark-theme.css in the same directory.

.PARAMETER LogoFile
  Optional path to a logo image file (PNG/JPG, max 100KB).

.EXAMPLE
  .\apply-branding.ps1 -UserPoolId us-east-1_ABC123 -ClientId 4abc123def
  .\apply-branding.ps1 -UserPoolId us-east-1_ABC123 -ClientId ALL
  .\apply-branding.ps1 -UserPoolId us-east-1_ABC123 -ClientId ALL -LogoFile .\logo.png
#>
param(
    [Parameter(Mandatory)] [string] $UserPoolId,
    [Parameter(Mandatory)] [string] $ClientId,
    [string] $CssFile = (Join-Path $PSScriptRoot "cognito-dark-theme.css"),
    [string] $LogoFile = ""
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

if (-not (Test-Path $CssFile)) {
    Write-Error "CSS file not found: $CssFile"
    exit 1
}

$css = Get-Content -Raw $CssFile
Write-Host "Applying Cognito UI customization..."
Write-Host "  User Pool: $UserPoolId"
Write-Host "  Client:    $ClientId"
Write-Host "  CSS:       $CssFile ($($css.Length) chars)"

$args = @(
    "cognito-idp", "set-ui-customization",
    "--user-pool-id", $UserPoolId,
    "--client-id", $ClientId,
    "--css", $css
)

if ($LogoFile -and (Test-Path $LogoFile)) {
    $logoBytes = [System.IO.File]::ReadAllBytes((Resolve-Path $LogoFile))
    $logoBase64 = [Convert]::ToBase64String($logoBytes)
    $args += @("--image-file", $logoBase64)
    Write-Host "  Logo:      $LogoFile ($($logoBytes.Length) bytes)"
}

aws @args | Out-Null

if ($LASTEXITCODE -eq 0) {
    Write-Host "`nDone! Cognito Hosted UI now uses the Discra dark theme." -ForegroundColor Green
    Write-Host "Clear your browser cache or open an incognito window to see the changes."
} else {
    Write-Error "Failed to apply UI customization. Check your AWS credentials and parameters."
}
