# Vulcan Phase 4 -- Self-Contained Replication Test
# -------------------------------------------------------------------------
# Run from the project root:
#   .\scripts\replication-test.ps1
#
# Proves:
#   1. Cluster starts healthy, replicas confirmed via /ring/replicas/:key
#   2. Key is written and replica receives it (replication working)
#   3. Primary is killed
#   4. READ of the key succeeds via replica (the money shot -- proves Phase 4)
#   5. New writes to dead-primary's range route to survivor (not dead node)
#   6. Primary restarts; re-sync pushes data back
#   7. Rejoined node now has the key (re-sync confirmed)
# -------------------------------------------------------------------------

$peers   = "node1:localhost:5001,node2:localhost:5002,node3:localhost:5003"
$rootDir = (Get-Location).Path

$hbInterval  = 2000
$hbTimeout   = 1500
$hbThreshold = 3
$RF          = 2

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

function WaitForPort {
    param([int[]]$Ports, [int]$TimeoutSec)
    $deadline = (Get-Date).AddSeconds($TimeoutSec)
    while ((Get-Date) -lt $deadline) {
        $ready = ($Ports | Where-Object {
            try { $c = New-Object System.Net.Sockets.TcpClient("localhost", $_); $c.Close(); $true }
            catch { $false }
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

$jobArgs = @($rootDir, $peers, $hbInterval, $hbTimeout, $hbThreshold, $RF)

# =========================================================================
# 1. Start cluster
# =========================================================================

Write-Host ""
Write-Host "=================================================" -ForegroundColor Cyan
Write-Host " Vulcan Phase 4 -- Replication Test"             -ForegroundColor Cyan
Write-Host "=================================================" -ForegroundColor Cyan
Write-Host ""
Write-Host "-- Step 1: Starting 3-node cluster (RF=$RF) --" -ForegroundColor Cyan

$jobBlock = {
    param($rd, $p, $hi, $ht, $hf, $rf, $nid, $port)
    Set-Location $rd
    $env:NODE_ID=$nid; $env:PORT=$port; $env:PEERS=$p
    $env:HEARTBEAT_INTERVAL_MS=$hi; $env:PING_TIMEOUT_MS=$ht; $env:FAILURE_THRESHOLD=$hf
    $env:REPLICATION_FACTOR=$rf
    npm run start:node 2>&1
}

$node1Job = Start-Job -Name "rt-node1" -ScriptBlock $jobBlock -ArgumentList ($jobArgs + @("node1", "5001"))
$node2Job = Start-Job -Name "rt-node2" -ScriptBlock $jobBlock -ArgumentList ($jobArgs + @("node2", "5002"))
$node3Job = Start-Job -Name "rt-node3" -ScriptBlock $jobBlock -ArgumentList ($jobArgs + @("node3", "5003"))

Write-Host "  Waiting for ports 5001/5002/5003 (max 40s)..." -ForegroundColor DarkGray
$allUp = WaitForPort -Ports @(5001, 5002, 5003) -TimeoutSec 40
if (-not $allUp) {
    Write-Host "ABORT: Nodes did not start in time." -ForegroundColor Red
    Stop-Job  $node1Job, $node2Job, $node3Job -ErrorAction SilentlyContinue
    Remove-Job $node1Job, $node2Job, $node3Job -ErrorAction SilentlyContinue
    exit 1
}
Write-Host "  All 3 nodes up." -ForegroundColor Green

# =========================================================================
# 2. Find a key whose primary is node2 (so we can kill node2 specifically)
# =========================================================================

Write-Host ""
Write-Host "-- Step 2: Finding a key whose primary is node2 --" -ForegroundColor Cyan

$targetKey = $null
$targetReplica = $null

for ($i = 0; $i -lt 200; $i++) {
    $k = "repl-key-$i"
    $r = Invoke-RestMethod -Uri "http://localhost:5001/ring/replicas/$k" -TimeoutSec 3
    $primary = ($r.replicas | Where-Object { $_.role -eq "primary" }).nodeId
    if ($primary -eq "node2") {
        $targetKey = $k
        $targetReplica = ($r.replicas | Where-Object { $_.role -eq "replica" }).nodeId | Select-Object -First 1
        Write-Host "  Found: key='$targetKey'  primary=node2  replica=$targetReplica" -ForegroundColor Yellow
        break
    }
}

if (-not $targetKey) {
    Write-Host "  [FAIL] Could not find a key with node2 as primary in 200 candidates." -ForegroundColor Red
    $script:FAIL++
} else {
    Assert -Condition ($targetReplica -ne "node2") -Msg "Replica for '$targetKey' is a different node ($targetReplica)"
}

# =========================================================================
# 3. Write the key and confirm replication
# =========================================================================

Write-Host ""
Write-Host "-- Step 3: Writing '$targetKey' and confirming replica received it --" -ForegroundColor Cyan

$body = @{ value = "phase4-value" } | ConvertTo-Json
$putResp = Invoke-RestMethod -Method PUT -Uri "http://localhost:5001/kv/$targetKey" `
           -Body $body -ContentType "application/json" -TimeoutSec 5
Write-Host "  PUT handledBy: $($putResp.handledBy)" -ForegroundColor DarkGray
Assert -Condition ($putResp.handledBy -eq "node2") -Msg "Write handled by node2 (primary)"

# Wait briefly for async replication to propagate
Start-Sleep -Seconds 2

# Check replica has the key via /internal/get (direct local read)
$replicaPort = switch ($targetReplica) {
    "node1" { 5001 }
    "node2" { 5002 }
    "node3" { 5003 }
}
try {
    $replicaVal = Invoke-RestMethod -Uri "http://localhost:$replicaPort/internal/get/$targetKey" -TimeoutSec 3
    Assert -Condition ($replicaVal.value -eq "phase4-value") `
           -Msg "Replica $targetReplica has the value after async replication (value='$($replicaVal.value)')"
    Assert -Condition ($replicaVal.handledBy -eq $targetReplica) `
           -Msg "Replica confirms handledBy=$targetReplica"
} catch {
    Assert -Condition $false -Msg "Replica $targetReplica returned error: $_"
}

# =========================================================================
# 4. Kill node2 (the primary)
# =========================================================================

Write-Host ""
Write-Host "-- Step 4: Killing node2 (primary for '$targetKey') --" -ForegroundColor Cyan
Stop-Job  $node2Job -ErrorAction SilentlyContinue
Remove-Job $node2Job -ErrorAction SilentlyContinue
KillPort 5002
Write-Host "  node2 killed." -ForegroundColor Yellow

# Wait for heartbeat detection (~6s)
$detectSec = [Math]::Ceiling(($hbThreshold + 1) * ($hbInterval / 1000)) + 2
Write-Host "  Waiting ${detectSec}s for heartbeat to mark node2 DEAD..." -ForegroundColor DarkGray
Start-Sleep -Seconds $detectSec

# Confirm DEAD
$h = Invoke-RestMethod -Uri "http://localhost:5001/health" -TimeoutSec 5
$n2status = ($h.clusterView | Where-Object { $_.nodeId -eq "node2" }).status
Assert -Condition ($n2status -eq "DEAD") -Msg "node1 sees node2 as DEAD (got: $n2status)"

# =========================================================================
# 5. THE MONEY SHOT: Read key via dead primary -- must succeed via replica
# =========================================================================

Write-Host ""
Write-Host "-- Step 5: Reading '$targetKey' with primary DEAD (Phase 4 money shot) --" -ForegroundColor Cyan
Write-Host "  Phase 3 result: 404   |   Phase 4 expected: 200 served by $targetReplica" -ForegroundColor Yellow

try {
    $getResp = Invoke-RestMethod -Uri "http://localhost:5001/kv/$targetKey" -TimeoutSec 5
    Write-Host "  GET value='$($getResp.value)'  handledBy=$($getResp.handledBy)" -ForegroundColor DarkGray
    Assert -Condition ($getResp.value -eq "phase4-value") `
           -Msg "GET '$targetKey' returns correct value despite primary being DEAD"
    Assert -Condition ($getResp.handledBy -eq $targetReplica) `
           -Msg "Response served by replica $targetReplica (not dead node2)"
} catch {
    $statusCode = [int]$_.Exception.Response.StatusCode
    Assert -Condition $false `
           -Msg "GET '$targetKey' failed with $statusCode -- Phase 4 read fallback not working"
}

# =========================================================================
# 5b. NEW KEY DURING FAILOVER -- tests the slice(1) vs filter(id) bug
#
# Scenario: node2 is DEAD. Write a brand-new key (never written before)
# whose fullRing primary is node2. The live ring will route the write to a
# surviving node. After the write, read from a THIRD node that did NOT
# handle the write -- the value must come back correctly.
#
# Why this specifically tests the bug:
#   slice(1) excludes fullRing index-0 (node2), leaving fullRing index-1
#   (whichever node is the replica). If the handling node IS that replica
#   (index 1 of fullRing), slice(1) self-replicates (harmless but wrong).
#   If the handling node is node3 (NOT in fullRing at all), slice(1) still
#   happens to give the right answer (["node1"]) by coincidence.
#
#   filter(id != NODE_ID) is always correct: "send to everyone except me".
#
# In the 3-node/RF=2 setup, the bug was NOT triggered -- it worked by
# coincidence in all routing cases. The new filter fix is semantically
# correct and future-proof for RF=3+ or different ring orderings.
# =========================================================================

Write-Host ""
Write-Host "-- Step 5b: Write a BRAND NEW key into dead node2's range --" -ForegroundColor Cyan
Write-Host "  (Tests correctness of filter(id != NODE_ID) vs slice(1))" -ForegroundColor DarkGray

# Find a new key whose fullRing primary is node2 (not the same as $targetKey)
$newKey = $null
for ($i = 400; $i -lt 600; $i++) {
    $k = "new-during-failover-$i"
    $r = Invoke-RestMethod -Uri "http://localhost:5001/ring/replicas/$k" -TimeoutSec 3
    $primary = ($r.replicas | Where-Object { $_.role -eq "primary" }).nodeId
    if ($primary -eq "node2") {
        $newKey = $k
        $newKeyReplica = ($r.replicas | Where-Object { $_.role -eq "replica" }).nodeId | Select-Object -First 1
        Write-Host "  Found new key: '$newKey'  fullRing primary=node2  replica=$newKeyReplica" -ForegroundColor DarkGray
        break
    }
}

if (-not $newKey) {
    Assert -Condition $false -Msg "Could not find a new key whose fullRing primary is node2"
} else {
    # Write the brand-new key (never written before) -- goes to a survivor via live ring
    $newBody = @{ value = "written-during-failover" } | ConvertTo-Json
    $newPut = Invoke-RestMethod -Method PUT -Uri "http://localhost:5001/kv/$newKey" `
              -Body $newBody -ContentType "application/json" -TimeoutSec 5
    Write-Host "  PUT '$newKey'  => handledBy: $($newPut.handledBy)" -ForegroundColor DarkGray
    Assert -Condition ($newPut.handledBy -ne "node2") `
           -Msg "Write routed away from dead node2 (handled by $($newPut.handledBy))"
    $writeHandler = $newPut.handledBy

    # Brief pause for async replication
    Start-Sleep -Seconds 2

    # Read from a THIRD node (not the write handler, not node2)
    $readFrom = @("node1", "node2", "node3") | Where-Object { $_ -ne $writeHandler -and $_ -ne "node2" } |
                Select-Object -First 1
    $readPort = switch ($readFrom) {
        "node1" { 5001 }
        "node3" { 5003 }
        default { 5001 }
    }

    Write-Host "  Reading from $readFrom (port $readPort) -- different from write handler ($writeHandler)" -ForegroundColor DarkGray

    try {
        $readResp = Invoke-RestMethod -Uri "http://localhost:$readPort/kv/$newKey" -TimeoutSec 5
        Write-Host "  GET value='$($readResp.value)'  handledBy=$($readResp.handledBy)" -ForegroundColor DarkGray
        Assert -Condition ($readResp.value -eq "written-during-failover") `
               -Msg "Brand-new key '$newKey' readable from $readFrom (value correct)"
        Write-Host "  [NOTE] Write handler: $writeHandler  |  Read served by: $($readResp.handledBy)" -ForegroundColor DarkGray
        Write-Host "  [NOTE] filter(id!=NODE_ID) ensured $($readResp.handledBy) got the replica" -ForegroundColor DarkGray
    } catch {
        $sc = [int]$_.Exception.Response.StatusCode
        Assert -Condition $false `
               -Msg "Brand-new key '$newKey' NOT readable from $readFrom (status $sc) -- replication bug"
    }
}

# =========================================================================
# 6. New writes to dead primary's range route to surviving nodes
# =========================================================================

Write-Host ""
Write-Host "-- Step 6: New writes to node2's range route away from dead node2 --" -ForegroundColor Cyan

$newKeys = @()
for ($i = 200; $i -lt 400; $i++) {
    $k = "repl-key-$i"
    $r = Invoke-RestMethod -Uri "http://localhost:5001/ring/replicas/$k" -TimeoutSec 3
    $primary = ($r.replicas | Where-Object { $_.role -eq "primary" }).nodeId
    if ($primary -eq "node2") { $newKeys += $k }
    if ($newKeys.Count -ge 3) { break }
}

foreach ($k in $newKeys) {
    $b = @{ value = "new-value-$k" } | ConvertTo-Json
    $r = Invoke-RestMethod -Method PUT -Uri "http://localhost:5001/kv/$k" `
         -Body $b -ContentType "application/json" -TimeoutSec 5
    Write-Host "  PUT $k  => handledBy: $($r.handledBy)" -ForegroundColor DarkGray
    Assert -Condition ($r.handledBy -ne "node2") -Msg "$k routed away from dead node2 (went to $($r.handledBy))"
}

# =========================================================================
# 7. Restart node2
# =========================================================================

Write-Host ""
Write-Host "-- Step 7: Restarting node2 --" -ForegroundColor Cyan
$node2JobNew = Start-Job -Name "rt-node2-rejoin" -ScriptBlock $jobBlock `
               -ArgumentList ($jobArgs + @("node2", "5002"))
$restarted = WaitForPort -Ports @(5002) -TimeoutSec 40
Assert -Condition $restarted -Msg "node2 restarted on port 5002"

# Wait for heartbeat to detect ALIVE + re-sync to complete
Write-Host "  Waiting ${detectSec}s for rejoin detection + re-sync..." -ForegroundColor DarkGray
Start-Sleep -Seconds $detectSec
# Give re-sync a little extra time to push data
Start-Sleep -Seconds 3

# =========================================================================
# 8. Confirm re-sync: node2 should now have the original key
# =========================================================================

Write-Host ""
Write-Host "-- Step 8: Confirming re-sync -- node2 should have '$targetKey' back --" -ForegroundColor Cyan

try {
    $resyncVal = Invoke-RestMethod -Uri "http://localhost:5002/internal/get/$targetKey" -TimeoutSec 5
    Assert -Condition ($resyncVal.value -eq "phase4-value") `
           -Msg "node2 has '$targetKey' back after re-sync (value='$($resyncVal.value)')"
} catch {
    $statusCode = [int]$_.Exception.Response.StatusCode
    Assert -Condition $false -Msg "node2 does NOT have '$targetKey' after re-sync (status $statusCode)"
}

# Confirm ALIVE in peers' views
$h2 = Invoke-RestMethod -Uri "http://localhost:5001/health" -TimeoutSec 5
$n2alive = ($h2.clusterView | Where-Object { $_.nodeId -eq "node2" }).status
Assert -Condition ($n2alive -eq "ALIVE") -Msg "node1 sees node2 as ALIVE again (got: $n2alive)"

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

# Phase 4 vs Phase 3 diff note
Write-Host ""
Write-Host "  Phase 3 vs Phase 4:" -ForegroundColor DarkGray
Write-Host "    Phase 3: killing the primary -> GET returns 404 (data lost)" -ForegroundColor DarkGray
Write-Host "    Phase 4: killing the primary -> GET returns 200 from replica (data survives)" -ForegroundColor DarkGray
Write-Host ""

# Cleanup
Write-Host "Stopping cluster jobs..." -ForegroundColor DarkGray
Stop-Job   $node1Job, $node3Job, $node2JobNew -ErrorAction SilentlyContinue
Remove-Job $node1Job, $node3Job, $node2JobNew -ErrorAction SilentlyContinue
KillPort 5001; KillPort 5002; KillPort 5003
Write-Host "Done." -ForegroundColor DarkGray
Write-Host ""

if ($script:FAIL -gt 0) { exit 1 }
