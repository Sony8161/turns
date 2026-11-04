# Turn everything off:
#   npm run down            stops the web app and the local Supabase stack
#   npm run down -- -docker also quits Docker Desktop
# Data is kept (the stack's volumes survive a stop). `npm run up` brings it back.
param([switch]$docker)

$ErrorActionPreference = 'Continue'
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

function Step($text) { Write-Host "`n== $text" -ForegroundColor Cyan }

Step 'Web app'
$listening = Get-NetTCPConnection -LocalPort 3000 -State Listen -ErrorAction SilentlyContinue
if ($listening) {
  foreach ($conn in $listening) {
    $proc = Get-Process -Id $conn.OwningProcess -ErrorAction SilentlyContinue
    if ($proc) {
      Stop-Process -Id $proc.Id -Force
      Write-Host "stopped $($proc.ProcessName) (pid $($proc.Id)) on port 3000"
    }
  }
} else {
  Write-Host 'not running'
}

Step 'Supabase local stack'
& cmd.exe /c 'docker info >nul 2>&1'
if ($LASTEXITCODE -eq 0) {
  npx supabase stop | Out-Null
  Write-Host 'stopped (data kept)'
} else {
  Write-Host 'Docker is not running, nothing to stop'
}

if ($docker) {
  Step 'Docker Desktop'
  $names = 'Docker Desktop', 'com.docker.backend', 'com.docker.build', 'com.docker.dev-envs'
  $any = $false
  foreach ($n in $names) {
    Get-Process -Name $n -ErrorAction SilentlyContinue | ForEach-Object {
      Stop-Process -Id $_.Id -Force -ErrorAction SilentlyContinue
      $any = $true
    }
  }
  Write-Host ($(if ($any) { 'quit' } else { 'was not running' }))
}

Write-Host "`nAll off. Start again with: npm run up"
