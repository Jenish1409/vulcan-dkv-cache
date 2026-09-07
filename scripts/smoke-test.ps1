# Vulcan Phase 2 — Cross-Node Routing Smoke Test
# ─────────────────────────────────────────────────────────────────────────────
# Prerequisite: 3-node cluster must already be running.
#   Run .\scripts\start-cluster.ps1 first, then wait ~3 seconds.
#
# This script:
#   1. Checks all three nodes are healthy
#   2. Writes several keys via node1
#   3. Reads each key via node3 (a different node)
#   4. Prints which node actually handled each request (proves forwarding)
# ─────────────────────────────────────────────────────────────────────────────

$node1 = "http://localhost:5001"
$node2 = "http://localhost:5002"
$node3 = "http://localhost:5003"

function CheckHealth($url, $name) {
    try {
        $h = Invoke-RestMethod -Uri "$url/health" -TimeoutSec 3
        Write-Host "  ✓ $name — uptime $($h.uptime)s, keyCount $($h.keyCount)" -ForegroundColor Green
    } catch {
        Write-Host "  ✗ $name — NOT REACHABLE" -ForegroundColor Red
        exit 1
    }
}

Write-Host ""
Write-Host "── Health checks ────────────────────────────────────────" -ForegroundColor Cyan
CheckHealth $node1 "node1 (port 5001)"
CheckHealth $node2 "node2 (port 5002)"
CheckHealth $node3 "node3 (port 5003)"

# ── Write keys via node1 ─────────────────────────────────────────────────────
$testKeys = @(
    @{ key = "hello";     value = "world" },
    @{ key = "phase";     value = 2 },
    @{ key = "project";   value = "vulcan" },
    @{ key = "language";  value = "typescript" },
    @{ key = "hashing";   value = "consistent" }
)

Write-Host ""
Write-Host "── Writing $($testKeys.Count) keys via node1 ───────────────────────────────" -ForegroundColor Cyan

foreach ($entry in $testKeys) {
    $body = @{ value = $entry.value } | ConvertTo-Json
    $r = Invoke-RestMethod -Method PUT `
        -Uri "$node1/kv/$($entry.key)" `
        -Body $body `
        -ContentType "application/json"
    Write-Host "  PUT /kv/$($entry.key)  →  handledBy: $($r.handledBy)" -ForegroundColor DarkGray
}

# ── Read keys via node3 ──────────────────────────────────────────────────────
Write-Host ""
Write-Host "── Reading same keys via node3 (cross-node routing test) ──" -ForegroundColor Cyan

$allPassed = $true
foreach ($entry in $testKeys) {
    try {
        $r = Invoke-RestMethod -Uri "$node3/kv/$($entry.key)" -TimeoutSec 5
        $match = ($r.value -eq $entry.value) -or ($r.value.ToString() -eq $entry.value.ToString())
        $icon = if ($match) { "✓" } else { "✗" }
        $color = if ($match) { "Green" } else { "Red" }
        Write-Host "  $icon GET /kv/$($entry.key)  →  value='$($r.value)'  handledBy: $($r.handledBy)" -ForegroundColor $color
        if (-not $match) { $allPassed = $false }
    } catch {
        Write-Host "  ✗ GET /kv/$($entry.key)  →  ERROR: $_" -ForegroundColor Red
        $allPassed = $false
    }
}

Write-Host ""
if ($allPassed) {
    Write-Host "All cross-node reads succeeded. Consistent hashing routing works!" -ForegroundColor Green
} else {
    Write-Host "Some reads failed. Check that all 3 nodes are running with the same PEERS config." -ForegroundColor Red
}
Write-Host ""
