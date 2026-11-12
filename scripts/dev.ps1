# One command to run the turn system locally:
#   npm run up
# Starts Docker Desktop if needed, the local Supabase stack, applies migrations,
# seeds Heavenly with an owner and fresh invite codes, writes apps/web/.env.local,
# starts the web app, and opens the browser. Safe to run again any time.
# Local machine only: every key it handles is the local stack's demo key.

#   npm run up -- -Demo
# Same, but first resets the local database and loads the demo day: six
# technicians on the floor, appointments and clients waiting (docs/DEMO-EXPECTED.md).
param([switch]$Demo)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

function Step($text) { Write-Host "`n== $text" -ForegroundColor Cyan }

# 1. Docker Desktop -----------------------------------------------------------
Step 'Docker'
# Through cmd so stderr chatter cannot turn into a PowerShell error; only the exit code counts.
function DockerUp { & cmd.exe /c 'docker info >nul 2>&1'; return $LASTEXITCODE -eq 0 }
if (-not (DockerUp)) {
  $desktop = Join-Path $env:ProgramFiles 'Docker\Docker\Docker Desktop.exe'
  if (-not (Test-Path $desktop)) { throw "Docker Desktop not found at $desktop" }
  Write-Host 'Starting Docker Desktop...'
  Start-Process $desktop
  $deadline = (Get-Date).AddMinutes(3)
  while (-not (DockerUp)) {
    if ((Get-Date) -gt $deadline) { throw 'Docker did not start within 3 minutes' }
    Start-Sleep -Seconds 3
  }
}
Write-Host 'Docker is running'

# 2. Local Supabase stack ------------------------------------------------------
Step 'Supabase local stack'
npx supabase start | Out-Null
$status = npx supabase status -o json | ConvertFrom-Json
$dbUrl = $status.DB_URL
$apiUrl = $status.API_URL
$anonKey = $status.ANON_KEY
$serviceKey = $status.SERVICE_ROLE_KEY
if (-not $dbUrl -or -not $serviceKey) { throw 'Could not read the local stack status' }
Write-Host "Database  $dbUrl"
Write-Host "Studio    $($status.STUDIO_URL)"
Write-Host "Inbox     $($status.MAILPIT_URL)"

# 3. Web app environment (local keys only) -----------------------------------
Step 'apps/web/.env.local'
$envFile = Join-Path $root 'apps\web\.env.local'
@"
# Written by scripts/dev.ps1 for the local stack. Never commit; never put cloud keys here.
NEXT_PUBLIC_SUPABASE_URL=$apiUrl
NEXT_PUBLIC_SUPABASE_ANON_KEY=$anonKey
DATABASE_URL=$dbUrl
SUPABASE_SERVICE_ROLE_KEY=$serviceKey
"@ | Set-Content -Path $envFile -Encoding utf8
Write-Host 'written'

# 4. Migrations and seed ---------------------------------------------------------
Step 'Migrations and seed'
$env:DATABASE_URL = $dbUrl
$env:SUPABASE_SERVICE_ROLE_KEY = $serviceKey
if ($Demo) {
  Write-Host 'Demo: resetting the local database (local only)'
  npx supabase db reset | Out-Null
}
npm run -s -w @turn/db db:migrate
if ($Demo) {
  npm run -s -w @turn/db db:seed:demo | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'demo seed failed (see the message above)' }
  Write-Host 'demo day loaded: docs/DEMO-EXPECTED.md'
} else {
  npm run -s -w @turn/db db:seed:dev | Out-Null
}
Write-Host 'sample accounts and codes written to dev-codes.txt'

# 5. Web app ---------------------------------------------------------------------
Step 'Web app'
$listening = Get-NetTCPConnection -LocalPort 3000 -State Listen -ErrorAction SilentlyContinue
if ($listening) {
  Write-Host 'Already running on http://localhost:3000'
} else {
  Start-Process -FilePath 'cmd.exe' -ArgumentList '/k', 'npm run dev -w web' -WorkingDirectory $root
  $deadline = (Get-Date).AddSeconds(60)
  do {
    Start-Sleep -Seconds 2
    $listening = Get-NetTCPConnection -LocalPort 3000 -State Listen -ErrorAction SilentlyContinue
  } until ($listening -or (Get-Date) -gt $deadline)
  Write-Host 'Started in its own window (close that window to stop it)'
}

# 6. Open ---------------------------------------------------------------------------
Step 'Open'
Start-Process 'http://localhost:3000'
Write-Host ''
Get-Content (Join-Path $root 'dev-codes.txt')
Write-Host "`nFull guide: TESTING.md"
