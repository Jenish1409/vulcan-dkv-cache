<#
.SYNOPSIS
  Vulcan Phase 7 — Chaos Testing Suite

.DESCRIPTION
  Checks the Docker cluster, installs chaos/ dependencies if needed,
  runs the 3-minute chaos experiment (load + fault injection),
  and prints the linearizability report.

  The cluster must already be running: docker compose up -d

.PARAMETER DurationSec
  Total experiment duration in seconds. Default: 180 (3 minutes).

.PARAMETER RatePerSec
  Target requests per second from the load generator. Default: 20.

.PARAMETER KeyCount
  Size of the key pool (chaos-key-0 through chaos-key-N). Default: 50.

.EXAMPLE
  # Default 3-minute run
  .\scripts\run-chaos.ps1

  # Longer run, higher rate
  .\scripts\run-chaos.ps1 -DurationSec 300 -RatePerSec 30
#>

param(
  [int]$DurationSec = 180,
  [int]$RatePerSec  = 20,
  [int]$KeyCount    = 50
)

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot  # project root (d:\Projects\Vulcan)

Write-Host ""
Write-Host "============================================================" -ForegroundColor Cyan
Write-Host "  Vulcan Phase 7 — Chaos Testing" -ForegroundColor Cyan
Write-Host "============================================================" -ForegroundColor Cyan
Write-Host ""

# ── Step 0: Verify Docker cluster is up ──────────────────────────────────
Write-Host "-- Step 0: Checking Vulcan cluster (localhost:5001/5002/5003) --"
$allUp = $true
foreach ($port in @(5001, 5002, 5003)) {
  try {
    $resp = Invoke-WebRequest -Uri "http://localhost:$port/health" -UseBasicParsing -TimeoutSec 3 -ErrorAction Stop
    if ($resp.StatusCode -ne 200) { $allUp = $false }
  } catch {
    Write-Host "  ⚠️  localhost:$port not reachable" -ForegroundColor Yellow
    $allUp = $false
  }
}
if (-not $allUp) {
  Write-Host ""
  Write-Host "  ERROR: Not all nodes are reachable." -ForegroundColor Red
  Write-Host "  Run: docker compose up -d" -ForegroundColor Red
  Write-Host "  Then wait ~15 seconds for health checks to pass." -ForegroundColor Red
  exit 1
}
Write-Host "  All 3 nodes are healthy." -ForegroundColor Green
Write-Host ""

# ── Step 1: Install chaos/ dependencies ──────────────────────────────────
Write-Host "-- Step 1: Installing chaos/ dependencies (if needed) --"
$chaosDir = Join-Path $Root "chaos"
if (-not (Test-Path (Join-Path $chaosDir "node_modules"))) {
  Write-Host "  Running npm install in chaos/..."
  Push-Location $chaosDir
  npm install --silent 2>&1
  Pop-Location
  Write-Host "  Dependencies installed." -ForegroundColor Green
} else {
  Write-Host "  node_modules already present, skipping." -ForegroundColor DarkGray
}
Write-Host ""

# ── Step 2: Run the chaos experiment ─────────────────────────────────────
Write-Host "-- Step 2: Running chaos experiment --"
Write-Host "   Duration : ${DurationSec}s"
Write-Host "   Rate     : ${RatePerSec} req/s"
Write-Host "   Keys     : chaos-key-0 .. chaos-key-$($KeyCount - 1)"
Write-Host ""

Push-Location $Root
try {
  & npx --prefix chaos ts-node chaos/src/runner.ts `
      --duration $DurationSec `
      --rate     $RatePerSec  `
      --keys     $KeyCount
  $exitCode = $LASTEXITCODE
} finally {
  Pop-Location
}

Write-Host ""
if ($exitCode -eq 0) {
  Write-Host "============================================================" -ForegroundColor Green
  Write-Host "  Chaos run PASSED. See report above." -ForegroundColor Green
  Write-Host "============================================================" -ForegroundColor Green
} else {
  Write-Host "============================================================" -ForegroundColor Red
  Write-Host "  Chaos run FAILED or checker self-test failed." -ForegroundColor Red
  Write-Host "  Review the linearizability report above." -ForegroundColor Red
  Write-Host "============================================================" -ForegroundColor Red
}
Write-Host ""
exit $exitCode
