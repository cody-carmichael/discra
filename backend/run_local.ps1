<#
Run this from anywhere; the script will locate the repository-level .venv
and activate it, install requirements if missing, then start uvicorn for
the FastAPI backend at http://127.0.0.1:8000

Usage:
  powershell ./backend/run_local.ps1

Notes:
- If `.venv` does not exist in the repo root, the script will instruct how
  to create it rather than creating it automatically.
#>

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Definition
$repoRoot = Resolve-Path (Join-Path $scriptDir '..')
$venvActivate = Join-Path $repoRoot '.venv\Scripts\Activate.ps1'
$requirements = Join-Path $scriptDir 'requirements.txt'

if (-not (Test-Path $venvActivate)) {
    Write-Host "No repository venv found at: $venvActivate" -ForegroundColor Yellow
    Write-Host "Create a new venv in the repo root and install requirements:" -ForegroundColor Cyan
    Write-Host "  python -m venv .venv" -ForegroundColor Green
    Write-Host "  .\\.venv\\Scripts\\Activate.ps1" -ForegroundColor Green
    Write-Host "  python -m pip install --upgrade pip" -ForegroundColor Green
    Write-Host "  pip install -r backend/requirements.txt" -ForegroundColor Green
    exit 1
}

# Activate the venv
& $venvActivate

# Ensure pip is recent and requirements installed
python -m pip install --upgrade pip
if (Test-Path $requirements) {
    pip install -r $requirements
}

# Start uvicorn
Write-Host "Starting FastAPI backend at http://127.0.0.1:8000" -ForegroundColor Cyan
python -m uvicorn backend.app:app --reload --host 127.0.0.1 --port 8000
