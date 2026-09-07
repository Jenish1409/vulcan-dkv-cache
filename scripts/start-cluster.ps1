# Vulcan Phase 2 — Start 3-Node Local Cluster
# ─────────────────────────────────────────────────────────────────────────────
# Run this from the project root:
#   .\scripts\start-cluster.ps1
#
# Opens THREE separate PowerShell windows, one per Vulcan node.
# Each window runs `npm run start:node` with unique NODE_ID / PORT.
# All windows share the same PEERS string so every node knows the others.
#
# After all three windows say "Vulcan node started", run:
#   .\scripts\smoke-test.ps1
# ─────────────────────────────────────────────────────────────────────────────

$peers   = "node1:localhost:5001,node2:localhost:5002,node3:localhost:5003"
$rootDir = (Get-Location).Path

Write-Host ""
Write-Host "Starting Vulcan 3-node cluster..." -ForegroundColor Cyan
Write-Host "PEERS : $peers"  -ForegroundColor DarkGray
Write-Host "Root  : $rootDir" -ForegroundColor DarkGray
Write-Host ""

# Helper — launches one node in a new, stay-open PowerShell window.
function StartNode($nodeId, $port) {
    $cmd = "`$env:NODE_ID='$nodeId'; " +
           "`$env:PORT='$port'; " +
           "`$env:PEERS='$peers'; " +
           "npm run start:node"

    Start-Process powershell -ArgumentList @(
        "-NoExit",
        "-NoLogo",
        "-WorkingDirectory", $rootDir,
        "-Command", $cmd
    )

    Write-Host "  Launched $nodeId on port $port" -ForegroundColor Green
}

# ── Launch nodes ──────────────────────────────────────────────────────────────
StartNode "node1" 5001
StartNode "node2" 5002
StartNode "node3" 5003

Write-Host ""
Write-Host "Three node windows opened." -ForegroundColor Green
Write-Host ""
Write-Host "Wait ~5 seconds for nodes to initialise, then run:" -ForegroundColor Yellow
Write-Host "  .\scripts\smoke-test.ps1" -ForegroundColor White
Write-Host ""
