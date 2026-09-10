# Vulcan Phase 3 -- Self-Contained Failure & Recovery Test
# -------------------------------------------------------------------------
# Run from the project root:
#   .\scripts\failure-test.ps1              # local ts-node cluster (Phase 3)
#   .\scripts\failure-test.ps1 -UseDocker   # Docker cluster (Phase 5)
#
# -UseDocker:
#   Assumes 'docker compose up -d' was already run externally.
#   Kills/restarts node2 via 'docker compose stop/start node2'.
#   Sets RF=2 (matching docker-compose.yml) -- step 8 therefore expects 200
#   (replica serves the data) rather than 404 (Phase 3 no-replication behavior).
#
# Without -UseDocker (default):
#   Starts its own 3-node ts-node cluster as background jobs with RF=1
#   (no replication) so step 8 still confirms Phase 3 data-loss behavior.
# -------------------------------------------------------------------------

param([switch]$UseDocker)

$peers   = "node1:localhost:5001,node2:localhost:5002,node3:localhost:5003"
$rootDir = (Get-Location).Path

$hbInterval  = 2000
$hbTimeout   = 1500
$hbThreshold = 3
# RF=1 for local (Phase 3 semantics: data lost on kill).
# RF=2 for Docker (Phase 4 replication active: replica serves data after kill).
$RF = if ($UseDocker) { 2 } else { 1 }

$script:PASS = 0
$script:FAIL = 0

function Assert {
    param([bool]$Condition, [string]$Msg)
    if ($Condition) {
        Write-Host "  [PASS] $Msg" -ForegroundColor Green
        $script:PASS++
    } else {
        Write-Host "  [FAIL] $Msg" -ForegroundColor Red
        $script:FAIL++
    }
}

function WaitForPorts {
    param([int[]]$Ports, [int]$TimeoutSec)
    $deadline = (Get-Date).AddSeconds($TimeoutSec)
    while ((Get-Date) -lt $deadline) {
        $ready = ($Ports | Where-Object {
            try {
                $c = New-Object System.Net.Sockets.TcpClient("localhost", $_)
                $c.Close()
                $true
            } catch { $false }
        }).Count
        if ($ready -eq $Ports.Count) { return $true }
        Start-Sleep -Milliseconds 500
    }
    return $false
}

function KillPort {
    param([int]$Port)
    try {
        $pid = (Get-NetTCPConnection -LocalPort $Port -ErrorAction SilentlyContinue).OwningProcess |
               Select-Object -First 1
        if ($pid) { Stop-Process -Id $pid -Force -ErrorAction SilentlyContinue }
    } catch {}
}

# =========================================================================
# 1. Start the cluster
# =========================================================================

Write-Host ""
Write-Host "=================================================" -ForegroundColor Cyan
Write-Host " Vulcan Phase 3 -- Failure and Recovery Test"    -ForegroundColor Cyan
Write-Host "=================================================" -ForegroundColor Cyan
Write-Host ""
Write-Host "-- Step 1: Starting 3-node cluster --" -ForegroundColor Cyan

$node1Job = $null; $node2Job = $null; $node3Job = $null; $node2JobNew = $null

if (-not $UseDocker) {
    $jobArgs = @($rootDir, $peers, $hbInterval, $hbTimeout, $hbThreshold, $RF)

    $jobBlock = {
        param($rd, $p, $hi, $ht, $hf, $rf, $nid, $port)
        Set-Location $rd
        $env:NODE_ID=$nid; $env:PORT=$port; $env:PEERS=$p
        $env:HEARTBEAT_INTERVAL_MS=$hi; $env:PING_TIMEOUT_MS=$ht; $env:FAILURE_THRESHOLD=$hf
        $env:REPLICATION_FACTOR=$rf
        npm run start:node 2>&1
    }

    $node1Job = Start-Job -Name "ft-node1" -ScriptBlock $jobBlock -ArgumentList ($jobArgs + @("node1", "5001"))
    $node2Job = Start-Job -Name "ft-node2" -ScriptBlock $jobBlock -ArgumentList ($jobArgs + @("node2", "5002"))
    $node3Job = Start-Job -Name "ft-node3" -ScriptBlock $jobBlock -ArgumentList ($jobArgs + @("node3", "5003"))

    Write-Host "  Waiting for all 3 ports to bind (max 40s)..." -ForegroundColor DarkGray
    $allUp = WaitForPorts -Ports @(5001, 5002, 5003) -TimeoutSec 40
    if (-not $allUp) {
        Write-Host "ABORT: Nodes did not start within 40 seconds." -ForegroundColor Red
        Stop-Job  $node1Job, $node2Job, $node3Job -ErrorAction SilentlyContinue
        Remove-Job $node1Job, $node2Job, $node3Job -ErrorAction SilentlyContinue
        exit 1
    }
    Write-Host "  All 3 nodes are up (RF=$RF, ts-node mode)." -ForegroundColor Green
} else {
    Write-Host "  UseDocker mode -- assuming 'docker compose up -d' was run." -ForegroundColor DarkGray
    Write-Host "  Checking localhost:5001/5002/5003 are reachable (max 20s)..." -ForegroundColor DarkGray
    $allUp = WaitForPorts -Ports @(5001, 5002, 5003) -TimeoutSec 20
    if (-not $allUp) {
        Write-Host "ABORT: Docker cluster not reachable on localhost:5001/5002/5003." -ForegroundColor Red
        Write-Host "       Run: docker compose up -d" -ForegroundColor Red
        exit 1
    }
    Write-Host "  Docker cluster detected on ports 5001/5002/5003 (RF=$RF)." -ForegroundColor Green
}

# =========================================================================
# 2. Baseline health check
# =========================================================================

Write-Host ""
Write-Host "-- Step 2: Baseline health check --" -ForegroundColor Cyan

foreach ($port in @(5001, 5002, 5003)) {
    $h = Invoke-RestMethod -Uri "http://localhost:$port/health" -TimeoutSec 5
    $aliveCount = ($h.clusterView | Where-Object { $_.status -eq "ALIVE" }).Count
    Assert -Condition ($aliveCount -eq 3) -Msg "node on port $port sees all 3 nodes ALIVE (got $aliveCount)"
}

# =========================================================================
# 3. Discover node2-owned keys via /ring/owner/:key  (read-only, no writes)
# =========================================================================

Write-Host ""
Write-Host "-- Step 3: Discovering node2-owned keys via GET /ring/owner/:key --" -ForegroundColor Cyan
Write-Host "  Scanning probe-key-0 .. probe-key-99 (no writes)" -ForegroundColor DarkGray

$node2Keys = @()
$node1Keys = @()
$node3Keys = @()

for ($i = 0; $i -lt 100; $i++) {
    $k = "probe-key-$i"
    $r = Invoke-RestMethod -Uri "http://localhost:5001/ring/owner/$k" -TimeoutSec 3
    switch ($r.owner) {
        "node2" { $node2Keys += $k }
        "node1" { $node1Keys += $k }
        "node3" { $node3Keys += $k }
    }
}

Write-Host "  node1 owns : $($node1Keys.Count) keys" -ForegroundColor DarkGray
Write-Host "  node2 owns : $($node2Keys.Count) keys  <- these will be written then killed" -ForegroundColor Yellow
Write-Host "  node3 owns : $($node3Keys.Count) keys" -ForegroundColor DarkGray

Assert -Condition ($node2Keys.Count -gt 0)  -Msg "At least one probe key hashes to node2"
Assert -Condition ($node2Keys.Count -lt 80) -Msg "node2 owns less than 80% of probe keys (distribution check)"

# =========================================================================
# 4. Write node2 keys before the kill
# =========================================================================

Write-Host ""
Write-Host "-- Step 4: Writing node2 keys via node1 (stored on node2) --" -ForegroundColor Cyan

$testNode2Keys = $node2Keys | Select-Object -First 5

foreach ($k in $testNode2Keys) {
    $body = @{ value = "value-of-$k" } | ConvertTo-Json
    $r = Invoke-RestMethod -Method PUT -Uri "http://localhost:5001/kv/$k" `
         -Body $body -ContentType "application/json" -TimeoutSec 5
    Write-Host "  PUT $k  => handledBy: $($r.handledBy)" -ForegroundColor DarkGray
    Assert -Condition ($r.handledBy -eq "node2") -Msg "$k was stored on node2 (got: $($r.handledBy))"
}

# =========================================================================
# 5. Kill node2
# =========================================================================

Write-Host ""
Write-Host "-- Step 5: Killing node2 --" -ForegroundColor Cyan

if ($UseDocker) {
    Write-Host "  Stopping node2 container via docker compose..." -ForegroundColor DarkGray
    Push-Location $rootDir
    docker compose stop node2 2>&1 | Out-Null
    Pop-Location
    Start-Sleep -Milliseconds 500
} else {
    Stop-Job  $node2Job -ErrorAction SilentlyContinue
    Remove-Job $node2Job -ErrorAction SilentlyContinue
    KillPort -Port 5002
    Start-Sleep -Milliseconds 500
}

$port5002Closed = -not (WaitForPorts -Ports @(5002) -TimeoutSec 2)
Write-Host "  node2 killed. Port 5002 closed: $port5002Closed" -ForegroundColor Yellow

# =========================================================================
# 6. Wait for heartbeat detection
# =========================================================================

$detectSec = [Math]::Ceiling(($hbThreshold + 1) * ($hbInterval / 1000)) + 2
Write-Host ""
Write-Host "-- Step 6: Waiting ${detectSec}s for heartbeat to detect failure --" -ForegroundColor Cyan
Write-Host "  (threshold=$hbThreshold x interval=$($hbInterval/1000)s = $($hbThreshold * $hbInterval/1000)s to declare DEAD)" -ForegroundColor DarkGray
Start-Sleep -Seconds $detectSec

# =========================================================================
# 7. Confirm node2 is DEAD in surviving nodes
# =========================================================================

Write-Host ""
Write-Host "-- Step 7: Checking cluster view on surviving nodes --" -ForegroundColor Cyan

foreach ($port in @(5001, 5003)) {
    $h  = Invoke-RestMethod -Uri "http://localhost:$port/health" -TimeoutSec 5
    $n2 = $h.clusterView | Where-Object { $_.nodeId -eq "node2" }
    Write-Host "  port $port sees node2 as: $($n2.status)  (consecutiveFailures=$($n2.consecutiveFailures))" -ForegroundColor DarkGray
    Assert -Condition ($n2.status -eq "DEAD") -Msg "port $port -> node2 is DEAD"
}

# =========================================================================
# 8. Data check after kill
#
# Non-Docker (RF=1): data was NOT replicated -- expect 404 (data lost).
# UseDocker  (RF=2): replica holds the data -- expect 200 (Phase 4).
# =========================================================================

Write-Host ""
if ($UseDocker) {
    Write-Host "-- Step 8: Confirming replica serves node2's data (RF=2, Phase 4) --" -ForegroundColor Cyan
} else {
    Write-Host "-- Step 8: Confirming data on dead node2 is gone (RF=1, 404 expected) --" -ForegroundColor Cyan
}

foreach ($k in $testNode2Keys) {
    $gotStatus = 0
    try {
        $null = Invoke-RestMethod -Uri "http://localhost:5001/kv/$k" -TimeoutSec 5
        $gotStatus = 200
    } catch {
        $gotStatus = [int]$_.Exception.Response.StatusCode
    }

    if ($UseDocker) {
        Assert -Condition ($gotStatus -eq 200) `
               -Msg "$k returns 200 from replica (RF=2 replication active) [got $gotStatus]"
    } else {
        Assert -Condition ($gotStatus -eq 404) `
               -Msg "$k returns 404 (RF=1, data lost on kill -- Phase 3 behavior) [got $gotStatus]"
    }
}

# =========================================================================
# 9. Rerouting: write NEW values into node2's old range
# =========================================================================

Write-Host ""
Write-Host "-- Step 9: Writing NEW keys into node2's old range, verifying rerouting --" -ForegroundColor Cyan
Write-Host "  Using same probe-key-* confirmed in Step 3 to belong to node2's range" -ForegroundColor DarkGray

$reroutedTo = @{}
foreach ($k in $testNode2Keys) {
    $body = @{ value = "rerouted-$k" } | ConvertTo-Json
    $r = Invoke-RestMethod -Method PUT -Uri "http://localhost:5001/kv/$k" `
         -Body $body -ContentType "application/json" -TimeoutSec 5
    Write-Host "  PUT $k  => handledBy: $($r.handledBy)" -ForegroundColor DarkGray
    Assert -Condition ($r.handledBy -ne "node2") -Msg "$k rerouted away from dead node2 (went to $($r.handledBy))"
    Assert -Condition ($r.ok -eq $true)           -Msg "$k PUT ok=true"
    $reroutedTo[$k] = $r.handledBy
}

# Verify reads of rerouted keys from node3 (cross-node)
foreach ($k in $testNode2Keys) {
    $r = Invoke-RestMethod -Uri "http://localhost:5003/kv/$k" -TimeoutSec 5
    Assert -Condition ($r.value -eq "rerouted-$k") `
           -Msg "GET $k via node3 returns rerouted value (handledBy $($r.handledBy))"
}

Write-Host ""
Write-Host "  Rerouting summary:" -ForegroundColor DarkGray
foreach ($k in $reroutedTo.Keys) {
    Write-Host "    $k -> $($reroutedTo[$k])" -ForegroundColor DarkGray
}

# =========================================================================
# 10. Restart node2
# =========================================================================

Write-Host ""
Write-Host "-- Step 10: Restarting node2 --" -ForegroundColor Cyan

if ($UseDocker) {
    Write-Host "  Starting node2 container via docker compose..." -ForegroundColor DarkGray
    Push-Location $rootDir
    docker compose start node2 2>&1 | Out-Null
    Pop-Location
    $node2JobNew = $null
} else {
    $jobArgs = @($rootDir, $peers, $hbInterval, $hbTimeout, $hbThreshold, $RF)
    $jobBlock = {
        param($rd, $p, $hi, $ht, $hf, $rf, $nid, $port)
        Set-Location $rd
        $env:NODE_ID=$nid; $env:PORT=$port; $env:PEERS=$p
        $env:HEARTBEAT_INTERVAL_MS=$hi; $env:PING_TIMEOUT_MS=$ht; $env:FAILURE_THRESHOLD=$hf
        $env:REPLICATION_FACTOR=$rf
        npm run start:node 2>&1
    }
    $node2JobNew = Start-Job -Name "ft-node2-rejoin" -ScriptBlock $jobBlock `
                  -ArgumentList ($jobArgs + @("node2", "5002"))
}

Write-Host "  Waiting for port 5002 to bind (max 40s)..." -ForegroundColor DarkGray
$restarted = WaitForPorts -Ports @(5002) -TimeoutSec 40
Assert -Condition $restarted -Msg "node2 restarted and bound port 5002"

# =========================================================================
# 11. Wait for rejoin detection
# =========================================================================

Write-Host ""
Write-Host "-- Step 11: Waiting ${detectSec}s for heartbeat to detect rejoin --" -ForegroundColor Cyan
Start-Sleep -Seconds $detectSec

# =========================================================================
# 12. Confirm node2 is ALIVE again
# =========================================================================

Write-Host ""
Write-Host "-- Step 12: Confirming node2 is ALIVE again --" -ForegroundColor Cyan

foreach ($port in @(5001, 5003)) {
    $h  = Invoke-RestMethod -Uri "http://localhost:$port/health" -TimeoutSec 5
    $n2 = $h.clusterView | Where-Object { $_.nodeId -eq "node2" }
    Write-Host "  port $port sees node2 as: $($n2.status)" -ForegroundColor DarkGray
    Assert -Condition ($n2.status -eq "ALIVE") -Msg "port $port -> node2 is ALIVE again"
}

Write-Host ""
if ($UseDocker) {
    Write-Host "  RF=2: node2 rejoined and re-sync pushed relevant keys back." -ForegroundColor Yellow
} else {
    Write-Host "  NOTE: Keys written during node2 outage remain on node1/node3." -ForegroundColor Yellow
    Write-Host "  node2 rejoins EMPTY (RF=1) -- data recovery requires Phase 4 replication." -ForegroundColor Yellow
}

# =========================================================================
# Summary
# =========================================================================

Write-Host ""
Write-Host "=================================================" -ForegroundColor Cyan
if ($script:FAIL -eq 0) {
    Write-Host " Results: $($script:PASS) passed, 0 failed" -ForegroundColor Green
} else {
    Write-Host " Results: $($script:PASS) passed, $($script:FAIL) failed" -ForegroundColor Red
}
Write-Host "=================================================" -ForegroundColor Cyan
Write-Host ""

# =========================================================================
# Cleanup (local ts-node mode only -- Docker cluster managed externally)
# =========================================================================

if (-not $UseDocker) {
    Write-Host "Stopping cluster jobs..." -ForegroundColor DarkGray
    Stop-Job   $node1Job, $node3Job, $node2JobNew -ErrorAction SilentlyContinue
    Remove-Job $node1Job, $node3Job, $node2JobNew -ErrorAction SilentlyContinue
    KillPort 5001; KillPort 5002; KillPort 5003
    Write-Host "Done." -ForegroundColor DarkGray
} else {
    Write-Host "Docker cluster left running. Stop with: docker compose down" -ForegroundColor DarkGray
}
Write-Host ""

if ($script:FAIL -gt 0) { exit 1 }
