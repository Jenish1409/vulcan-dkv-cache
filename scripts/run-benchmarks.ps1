# Vulcan Phase 6 -- Full Benchmark Runner
# ============================================================
# Prereq: Vulcan Docker cluster already running.
#   docker compose up -d
#
# This script:
#   1. Starts a fresh Redis container on localhost:6379
#   2. Pre-populates Vulcan with 1,000 benchmark keys
#   3. Runs bench-vulcan.js  (autocannon, 5 scenarios)
#   4. Runs bench-redis.js   (redis npm client, apples-to-apples)
#   5. Runs redis-benchmark inside the Redis container (native ceiling)
#   6. Saves all raw output to benchmarks/raw/
#   7. Stops the Redis container
#
# Usage:
#   .\scripts\run-benchmarks.ps1
# ============================================================

param()

$rootDir  = (Get-Location).Path
$rawDir   = Join-Path $rootDir "benchmarks\raw"
$redisContainer = "vulcan-redis-bench"

function WaitForPort {
    param([int]$Port, [int]$TimeoutSec = 30)
    $deadline = (Get-Date).AddSeconds($TimeoutSec)
    while ((Get-Date) -lt $deadline) {
        try {
            $c = New-Object System.Net.Sockets.TcpClient("localhost", $Port)
            $c.Close()
            return $true
        } catch { Start-Sleep -Milliseconds 300 }
    }
    return $false
}

Write-Host ""
Write-Host "============================================================" -ForegroundColor Cyan
Write-Host "  Vulcan Phase 6 -- Benchmark Suite"                          -ForegroundColor Cyan
Write-Host "============================================================" -ForegroundColor Cyan

# ------------------------------------------------------------------
# 0. Confirm Vulcan cluster is up
# ------------------------------------------------------------------
Write-Host ""
Write-Host "-- Step 0: Checking Vulcan cluster (localhost:5001/5002/5003) --" -ForegroundColor Cyan
$vulcanUp = WaitForPort -Port 5001 -TimeoutSec 5
if (-not $vulcanUp) {
    Write-Host "ABORT: Vulcan not reachable on localhost:5001." -ForegroundColor Red
    Write-Host "       Run: docker compose up -d" -ForegroundColor Red
    exit 1
}
Write-Host "  Vulcan cluster is reachable." -ForegroundColor Green

# ------------------------------------------------------------------
# 1. Start Redis container
# ------------------------------------------------------------------
Write-Host ""
Write-Host "-- Step 1: Starting Redis container ($redisContainer) --" -ForegroundColor Cyan

# Remove stale container if exists
docker rm -f $redisContainer 2>&1 | Out-Null

docker run -d --name $redisContainer -p 6379:6379 redis:alpine 2>&1 | Out-Null

Write-Host "  Waiting for Redis on localhost:6379 (max 30s)..." -ForegroundColor DarkGray
$redisUp = WaitForPort -Port 6379 -TimeoutSec 30
if (-not $redisUp) {
    Write-Host "ABORT: Redis did not become ready." -ForegroundColor Red
    exit 1
}
Write-Host "  Redis is ready." -ForegroundColor Green
Start-Sleep -Seconds 1  # brief settle

# ------------------------------------------------------------------
# 2. Pre-populate Vulcan
# ------------------------------------------------------------------
Write-Host ""
Write-Host "-- Step 2: Pre-populating Vulcan with benchmark keys --" -ForegroundColor Cyan
node benchmarks\populate.js
if ($LASTEXITCODE -ne 0) {
    Write-Host "ABORT: populate.js failed." -ForegroundColor Red
    exit 1
}

# ------------------------------------------------------------------
# 3. Vulcan benchmarks (bench-vulcan.js)
# ------------------------------------------------------------------
Write-Host ""
Write-Host "-- Step 3: Vulcan benchmarks (autocannon, 5 scenarios, ~90s) --" -ForegroundColor Cyan
$vulcanOut = node benchmarks\bench-vulcan.js 2>&1
$vulcanOut | Write-Host
$vulcanOut | Out-File -Encoding utf8 "$rawDir\vulcan-stdout.txt" -Force
Write-Host ""
Write-Host "  Vulcan raw output -> benchmarks/raw/vulcan-stdout.txt" -ForegroundColor DarkGray

# ------------------------------------------------------------------
# 4. Redis benchmarks (bench-redis.js -- Node client)
# ------------------------------------------------------------------
Write-Host ""
Write-Host "-- Step 4: Redis benchmarks (redis npm client, 4 scenarios, ~60s) --" -ForegroundColor Cyan
$redisNodeOut = node benchmarks\bench-redis.js 2>&1
$redisNodeOut | Write-Host
$redisNodeOut | Out-File -Encoding utf8 "$rawDir\redis-node-stdout.txt" -Force
Write-Host ""
Write-Host "  Redis (Node) raw output -> benchmarks/raw/redis-node-stdout.txt" -ForegroundColor DarkGray

# ------------------------------------------------------------------
# 5. redis-benchmark (native, inside container -- Redis's ceiling)
# ------------------------------------------------------------------
Write-Host ""
Write-Host "-- Step 5: redis-benchmark (native C client, Redis ceiling) --" -ForegroundColor Cyan
Write-Host "  Running: SET 100k ops, c=50 ..." -ForegroundColor DarkGray
$rbSetOut = docker exec $redisContainer redis-benchmark -n 100000 -c 50 -t set 2>&1
Write-Host "  Running: GET 100k ops, c=50 ..." -ForegroundColor DarkGray
$rbGetOut = docker exec $redisContainer redis-benchmark -n 100000 -c 50 -t get 2>&1
Write-Host "  Running: mixed (GET+SET) 100k ops, c=50 ..." -ForegroundColor DarkGray
$rbMixOut = docker exec $redisContainer redis-benchmark -n 100000 -c 50 -t get,set 2>&1

$rbAll = "=== redis-benchmark SET ===`n$rbSetOut`n`n=== redis-benchmark GET ===`n$rbGetOut`n`n=== redis-benchmark GET+SET ===`n$rbMixOut"
$rbAll | Out-File -Encoding utf8 "$rawDir\redis-benchmark.txt" -Force
$rbAll | Write-Host
Write-Host ""
Write-Host "  redis-benchmark raw output -> benchmarks/raw/redis-benchmark.txt" -ForegroundColor DarkGray

# ------------------------------------------------------------------
# 6. Stop Redis
# ------------------------------------------------------------------
Write-Host ""
Write-Host "-- Step 6: Stopping Redis container --" -ForegroundColor Cyan
docker stop  $redisContainer 2>&1 | Out-Null
docker rm    $redisContainer 2>&1 | Out-Null
Write-Host "  Redis container stopped and removed." -ForegroundColor Green

# ------------------------------------------------------------------
# Done
# ------------------------------------------------------------------
Write-Host ""
Write-Host "============================================================" -ForegroundColor Cyan
Write-Host "  Benchmark complete."                                         -ForegroundColor Green
Write-Host "  All raw files are in benchmarks\raw\"                       -ForegroundColor Green
Write-Host "  JSON summaries: vulcan-summary.json, redis-node-summary.json" -ForegroundColor Green
Write-Host "============================================================" -ForegroundColor Cyan
Write-Host ""
