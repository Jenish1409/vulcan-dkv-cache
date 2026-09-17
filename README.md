# Vulcan -- Distributed Key-Value Cache

> A portfolio project building a distributed KV cache from scratch -- consistent hashing,
> replication, chaos testing, and a live visual dashboard -- one phase at a time.

---

## Phases at a glance

| Phase | What was built | Status |
|---|---|---|
| 1 | LRU in-memory store (HashMap + DLL + TTL) | Done |
| 2 | HTTP layer + consistent hash ring + request routing | Done |
| 3 | Heartbeat, failure detection, ring recovery | Done |
| 4 | Async replication, read fallback, rejoin re-sync | Done |
| 5 | Docker containerisation (3-node compose cluster) | Done |
| 6 | Benchmarking (Vulcan vs Redis) | Done |
| 7/8 | Chaos testing harness + linearizability checker | Done |
| 9 | Live visual dashboard (hash ring, event log, chaos controls) | Done |

---

## Phase 1 -- LRU In-Memory Store

### What is built

A single-process, in-memory key-value store backed by a HashMap + doubly linked list.

| Feature | Detail |
|---|---|
| `SET / GET / DELETE` | O(1) average via `Map<string, Node>` |
| TTL per key | Optional expiry in seconds |
| LRU eviction | Bounded memory; O(1) promote and evict |
| Generic type `LRUCache<V>` | Value type enforced at compile time |
| `destroy()` | Clears the sweep interval; prevents timer leaks in tests |

### How LRU works

```
HashMap  ->  { key: Node }                          O(1) lookup
DLL      ->  head <-> [MRU] <-> ... <-> [LRU] <-> tail   O(1) promote and evict
```

Every DLL node also lives in the map. Promoting a node to MRU is O(1) pointer rewiring -- no scan. Two sentinel head/tail nodes eliminate null checks at the edges.

**TTL strategy -- lazy expiry + active sweep (both always running):**
- *Lazy*: every `GET` checks `Date.now() >= expiresAt`. Free on the hot path.
- *Active sweep*: `setInterval` walks the map every N ms and purges expired entries. Prevents unbounded memory growth for cold keys never read again.
- Timer is `.unref()`-ed so it never blocks process exit.

### Files

```
src/store/LRUCache.ts          core implementation
src/store/index.ts             barrel re-export
tests/store/LRUCache.test.ts   Jest unit tests
```

### Tests and build

```bash
npm install
npm test              # 27 tests (LRUCache suite)
npm run test:watch
npm run test:coverage
npm run build         # tsc, zero errors
```

Jest fake timers (`jest.useFakeTimers()`) are used so TTL tests run instantly.

---

## Phase 2 -- HTTP Layer + Consistent Hashing Ring

### What is built

| Feature | Detail |
|---|---|
| REST API per node | `PUT /kv/:key`, `GET /kv/:key`, `DELETE /kv/:key`, `GET /health` |
| Consistent hash ring | SHA-256 (Node.js `crypto`), 150 virtual nodes per physical node, O(log n) lookup |
| Embedded routing | Any node accepts any request and forwards to the correct owner |
| `GET /ring/owner/:key` | Returns the predicted owner without storing anything |
| Static peer config | `PEERS` env var (`nodeId:host:port,...`) |

### Why consistent hashing

With naive `hash(key) % N`, adding one node changes `N` for every key -- ~80% of keys remap. Consistent hashing places nodes and keys on a fixed circular ring; adding one node moves only ~1/(N+1) of keys. Measured: adding a 5th node to a 4-node ring remapped ~20% of 10,000 test keys.

### Why 150 virtual nodes

One ring point per physical node causes uneven arc sizes. 150 proxy points per node smooth the distribution. Our HashRing test verifies no single node owns more than ~40% of keys. Cassandra uses 256; 150 is a common production default.

### Why embedded routing (not a coordinator)

A dedicated coordinator is a single point of failure. Every Vulcan node holds its own copy of `HashRing`. If it receives a request for a key it does not own, it forwards to the owner and relays the response -- transparent to the client.

### Files

```
src/routing/HashRing.ts           consistent hash ring
src/server/node.ts                HTTP server + routing logic
src/server/router.ts              forward-request helper
src/server/types.ts               shared TypeScript types
tests/routing/HashRing.test.ts    17 unit tests
```

### Running the cluster

```powershell
# Three-terminal helper script
.\scripts\start-cluster.ps1

# Or manually (one terminal per node):
$env:NODE_ID="node1"; $env:PORT="5001"; $env:PEERS="node1:localhost:5001,node2:localhost:5002,node3:localhost:5003"; npm run start:node
$env:NODE_ID="node2"; $env:PORT="5002"; $env:PEERS="node1:localhost:5001,node2:localhost:5002,node3:localhost:5003"; npm run start:node
$env:NODE_ID="node3"; $env:PORT="5003"; $env:PEERS="node1:localhost:5001,node2:localhost:5002,node3:localhost:5003"; npm run start:node
```

```powershell
# Smoke test (cross-node routing)
.\scripts\smoke-test.ps1

# Manual check
Invoke-RestMethod -Method PUT -Uri 'http://localhost:5001/kv/hello' `
  -Body '{"value":"world"}' -ContentType 'application/json'
Invoke-RestMethod 'http://localhost:5003/kv/hello'
# -> { key: "hello", value: "world", handledBy: "node1" }
```

### Tests and build

```bash
npm test        # 27 (Phase 1) + 17 (HashRing) = 44 tests, 2 suites
npm run build   # zero errors
```

---

## Phase 3 -- Heartbeat, Failure Detection, Ring Recovery

### What is built

| Feature | Detail |
|---|---|
| Heartbeat | Each node pings every peer via `GET /health` on an interval |
| Failure detection | 3 consecutive missed pings -> peer marked DEAD, removed from local ring |
| Automatic rerouting | `HashRing.removeNode()` shifts the dead node's key range to the next clockwise node |
| Rejoin detection | First successful ping after DEAD -> peer re-added to ring |
| Observable cluster state | `GET /health` includes `clusterView`: per-peer ALIVE/DEAD status |
| Ring owner debug endpoint | `GET /ring/owner/:key` |

### Heartbeat defaults (all env-var overridable)

| Setting | Default | Rationale |
|---|---|---|
| `HEARTBEAT_INTERVAL_MS` | 2000 ms | ~6 s detection; not too chatty |
| `PING_TIMEOUT_MS` | 1500 ms | Shorter than interval so pings don't pile up |
| `FAILURE_THRESHOLD` | 3 | 3 x 2 s = 6 s before declaring DEAD; absorbs 2 transient losses |

### Architecture: testable state machine

`HeartbeatManager` separates I/O from logic:
- `tick()` -- runs on the interval, calls `pingFn(peer)` in parallel
- `processPingResult(nodeId, alive)` -- public, synchronous state machine

Unit tests call `processPingResult` directly with a boolean -- no HTTP servers, no timers, no mocks of axios needed.

### "Local view" -- no distributed consensus

Each node runs its heartbeat independently. During the ~2 s convergence window after a failure, two nodes may briefly disagree on topology. Worst case: one 502 that the client retries. Raft/Paxos would eliminate this window but is out of scope here.

### Files

```
src/server/HeartbeatManager.ts          heartbeat + failure detection
tests/server/HeartbeatManager.test.ts   19 unit tests
scripts/failure-test.ps1                live demo script
```

### Failure demo

```powershell
.\scripts\failure-test.ps1
```

Proves (with real output):
1. All 3 nodes start ALIVE
2. Keys are written to node2 (confirmed via `GET /ring/owner/:key`)
3. node2 is killed
4. After ~6 s: node1 and node3 both show node2 DEAD in `/health`
5. Those keys now return 404 (no replication yet -- expected)
6. New writes to the same keys route to node1/node3 (rerouting confirmed)
7. node2 restarts; after ~6 s both surviving nodes show it ALIVE again

### Tests and build

```bash
npm test        # 44 (Phase 1+2) + 19 (HeartbeatManager) = 63 tests, 3 suites
npm run build   # zero errors
```

---

## Phase 4 -- Async Replication, Read Fallback, Rejoin Re-sync

### What is built

| Feature | Detail |
|---|---|
| Replication factor | `REPLICATION_FACTOR` env var, default 2. Each key lives on 1 primary + N-1 replicas. |
| Replica placement | `HashRing.getReplicaNodes(key, RF)` walks clockwise from primary, collecting distinct physical nodes |
| Async write replication | Primary writes locally, returns 200, fans out to replicas in background |
| `GET /ring/replicas/:key` | Returns full replica list for a key |
| Read fallback | If primary is DEAD, reader falls back to the next live replica |
| Two-ring architecture | `ring` (modified by heartbeat) for live routing; `fullRing` (all peers, read-only) for replica placement |
| Rejoin re-sync | When a dead node rejoins, surviving nodes push back only the keys that node is responsible for |
| Internal endpoints | `PUT /internal/replicate/:key`, `GET /internal/get/:key`, `GET /internal/dump` |

### Why two rings

After a node dies, `ring.removeNode()` removes it -- so `ring.getReplicaNodes()` can no longer return it. But read fallback needs to know who *was* holding the replica. `fullRing` (never modified) preserves that information.

### Consistency model: async replication

Primary writes locally, responds to client, then fans out to replicas in the background. Trade-off: if the primary crashes after responding but before a replica write completes, that write is permanently lost. A sync mode (wait for at least one replica ack before responding) eliminates this at the cost of write latency -- not implemented here, noted as future work.

### Rejoin re-sync filtering

When node2 rejoins, surviving nodes filter their entire cache dump:

```typescript
const owners = fullRing.getReplicaNodes(key, REPLICATION_FACTOR);
if (owners.includes(rejoinedNodeId)) {
  // only push this key
}
```

Prevents node2 from receiving keys it is not responsible for.

### Files

```
src/server/node.ts            replication + fallback + re-sync logic (in same file as Phase 2/3)
scripts/replication-test.ps1  live demo script
```

### Replication demo

```powershell
.\scripts\replication-test.ps1
```

Proves:
1. Key written to node2 (primary), confirmed on node1 (replica)
2. node2 killed
3. `GET key` returns correct value served by node1 (replica) -- not 404 as in Phase 3
4. node2 restarts; re-sync pushes the key back to node2

### Tests and build

```bash
npm test        # 76 tests total, 3 suites (getReplicaNodes tests are in HashRing suite)
npm run build   # zero errors
```

---

## Phase 5 -- Docker Containerisation

### What is built

A three-node Docker Compose cluster. Each node runs in its own container on an isolated bridge network.

```yaml
# docker-compose.yml -- 3 services: node1, node2, node3
# Each uses the same Dockerfile, different NODE_ID/PORT/PEERS
# Host port mapping: 5001:5001, 5002:5002, 5003:5003
```

Multi-stage Dockerfile:
- *Builder stage*: installs all dev dependencies, compiles `src/` to `dist/`
- *Runtime stage*: installs production dependencies only, copies `dist/`, runs as non-root user `vulcan` (UID 1001)

### Quick start

```powershell
docker compose up --build -d   # build images + start cluster
docker compose ps              # verify all 3 containers healthy
docker compose logs -f node1   # stream logs
docker compose down            # tear down
```

### Running test scripts against Docker

```powershell
.\scripts\smoke-test.ps1                      # talks to localhost:5001/5002/5003
.\scripts\failure-test.ps1 -UseDocker         # uses docker compose stop/start
.\scripts\replication-test.ps1 -UseDocker
```

Verified results:

| Script | Result |
|---|---|
| smoke-test.ps1 | 5/5 PASS |
| failure-test.ps1 -UseDocker | 35/35 PASS |
| replication-test.ps1 -UseDocker | 15/15 PASS |

### Container networking

Inside Docker, `localhost` refers to the container itself -- not peers. Compose creates a shared bridge network and makes each service name a DNS hostname:

```
PEERS=node1:node1:5001,node2:node2:5002,node3:node3:5003
       ^^^^^         ^^^^^ Docker DNS hostname
       nodeId
```

Host-to-container traffic (test scripts) uses the `ports: 5001:5001` mappings -- no script changes needed.

---

## Phase 6 -- Benchmarking (Vulcan vs Redis)

Full results and raw data: [`benchmarks/README.md`](./benchmarks/README.md)

**Environment:** Windows 11, Docker Desktop (WSL2), Node.js v22.19.0

### Headline numbers

| Scenario | Vulcan (3-node, RF=2) | Redis (Node client) | Redis (redis-benchmark ceiling) |
|---|---|---|---|
| GET throughput (c=50, 10s) | **2,193 req/s** | 14,162 ops/s | 167,504 ops/s |
| PUT throughput (c=50, 10s) | **1,119 req/s** | 13,854 ops/s | 158,228 ops/s |
| Mixed 80/20 (c=50, 10s) | **1,942 req/s** | 13,556 ops/s | ~160,000 ops/s |
| GET p50 / p99 (c=10, 30s) | **4 ms / 11 ms** | 0.74 ms / 2.55 ms | 0.15 ms / 0.44 ms |

### Forwarding-hop cost

| Scenario | req/s | p50 | p99 |
|---|---|---|---|
| Local GET (node1 owns key) | 4,959 | 1 ms | 5 ms |
| Forwarded GET (node2 owns key, node1 proxies) | 1,526 | 6 ms | 13 ms |
| Delta | 3.25x slower | +5 ms | +8 ms |

### Why the gap exists

1. HTTP/JSON vs Redis RESP binary protocol -- headers, parse/stringify, Express middleware
2. Node.js (V8 GC pauses) vs Redis (C, no GC)
3. Cross-node forwarding -- doubles HTTP overhead per proxied request
4. Async replication fan-out -- PUT p99 (112 ms) is ~2x GET p99 (56 ms)

### Run benchmarks

```powershell
docker compose up -d
.\scripts\run-benchmarks.ps1   # results saved to benchmarks/raw/
```

---

## Phase 7/8 -- Chaos Testing Harness

A standalone tool (`chaos/`) that runs continuous load against the live cluster,
injects failure scenarios, and checks every response for linearizability violations.

### What is built

| Component | File | Description |
|---|---|---|
| Load generator | `chaos/src/loader.ts` | 5 workers, configurable req/s, 40% SET / 60% GET |
| Fault injector | `chaos/src/injector.ts` | Node kill (`docker compose stop`), network isolation (`docker network disconnect`), malformed value injection |
| Flight recorder | `chaos/src/recorder.ts` | Synchronous JSONL log, one entry per operation |
| Linearizability checker | `chaos/src/checker.ts` | Detects INVENTED_VALUE and FUTURE_READ violations |
| Runner | `chaos/src/runner.ts` | Orchestrates all of the above |

### Fault sequence (fixed in the harness)

```
T+0-15s    Baseline -- normal ops, building write history
T+15-45s   Kill node2 (30s down)
T+45-75s   node2 rejoin + re-sync window
T+75-95s   Isolate node1 from Docker network (20s)
T+95-115s  Restore node1, reconverge
T+115-120s Malformed value injection (expects 400 rejection)
T+120-180s Final baseline
```

### Findings (5 runs across Phase 7 and Phase 8)

**Bug found and fixed (Run 1):** Express's default 100 KB body-parser limit rejected the 1 MB malformed-value test payload before our validator ran, returning 500. Fixed: `express.json({ limit: '2mb' })`. All subsequent runs correctly returned 400.

**Two Generals Problem -- observed in every run (5/5):**

A write that appeared to fail (HTTP timeout during the isolation window) was actually committed on the primary. After reconnection, the primary served this "phantom" value to subsequent GETs. The linearizability checker detected these as INVENTED_VALUE violations.

This is a fundamental property of single-round-trip HTTP writes without distributed coordination. It is not a Vulcan implementation bug. Every AP-model store without 2PC/Raft/Paxos has this window.

| Run | Duration | Rate | Ops | INVENTED_VALUE | FUTURE_READ | Stale reads |
|---|---|---|---|---|---|---|
| 1 (Ph.7) | 180s | 20/s | ~2,900 | 9 | 0 | 61 |
| 2 (Ph.7) | 180s | 20/s | ~2,900 | 14 | 0 | 65 |
| A (Ph.8) | 300s | 20/s | ~4,800 | 34 | 0 | 110 |
| B (Ph.8) | 180s | 40/s | ~5,800 | 35 | 0 | 288 |
| C (Ph.8) | 180s | 20/s | ~2,900 | 31 | 0 | 162 |

Higher load (40 req/s) produced ~2.5x more violations for the same duration -- more concurrent writes in-flight during the fault window. No new violation category appeared at any load level.

Full evidence and analysis: [`chaos/RESULTS.md`](chaos/RESULTS.md)

### Run it

```powershell
# Cluster must be running first
docker compose up -d

# Default run (180s, 20 req/s, 50 keys)
.\scripts\run-chaos.ps1

# Custom run
.\scripts\run-chaos.ps1 -DurationSec 300 -RatePerSec 30 -KeyCount 100

# Re-analyze a saved log without re-running
.\chaos\node_modules\.bin\ts-node.cmd chaos/src/checker.ts chaos/logs/chaos-TIMESTAMP.jsonl
```

> **Windows note:** `run-chaos.ps1` invokes ts-node via the local `.cmd` shim
> (`chaos\node_modules\.bin\ts-node.cmd`) rather than `npx ts-node`. This avoids
> a Windows `npx.ps1` bug where the leading character is stripped from the
> package name (`ts-node` becomes `px`), causing "could not determine executable
> to run".

---

## Phase 9 -- Live Visual Dashboard

A browser dashboard that visualises the Vulcan cluster in real time: hash ring,
live traffic, node health, and chaos injection controls.

### What is built

```
dashboard/
  server/index.ts        aggregator -- SSE consumer + WebSocket broadcaster + chaos REST API
  src/App.tsx            root component
  src/components/
    HashRing.tsx         SVG ring with animated packet ripples
    EventLog.tsx         rolling last-20 events, colour-coded by type
    StatsBar.tsx         node health count, op totals, replication failure count
    ChaosControls.tsx    inject/restore buttons with per-node failure-mode tracking
  src/hooks/
    useVulcanEvents.ts   WebSocket connection + state management
  src/types.ts           shared TypeScript types
```

### Architecture

```
Vulcan nodes (5001-5003)
  GET /events (SSE)  ------>  dashboard/server/index.ts  (port 4000)
                              merges 3 SSE streams
                              broadcasts to browser via WebSocket
                              executes docker commands for POST /chaos/*
                                    |
                              ws://localhost:4000
                                    |
                              React/Vite UI  (port 5173)
```

**SSE (node -> aggregator):** The `/events` route on each Vulcan node emits
a Server-Sent Event for every SET, GET, replication attempt, and heartbeat.
Zero cost on the hot path -- emits are in-memory EventEmitter calls.

**WebSocket (aggregator -> browser):** The aggregator merges all three SSE
streams and broadcasts every event to connected browsers. Also exposes a
REST API for chaos commands.

### How to run

```powershell
# Terminal 1
docker compose up -d

# Terminal 2 -- aggregator
cd dashboard
npm install       # first time only
npm run server    # tsx server/index.ts -> ws://localhost:4000

# Terminal 3 -- frontend
cd dashboard
npm run dev       # Vite -> http://localhost:5173
```

Open **http://localhost:5173**.

### Dashboard panels

| Panel | What it shows |
|---|---|
| Hash ring (SVG) | 3 nodes at 120-degree intervals; green = ALIVE, red = DEAD; animated packet ripples per operation |
| Stats bar | Healthy node count, RF, total ops, SET count, GET count, replication failure count |
| Event log | Rolling last-20 events; colour-coded: SET (blue), GET (green), REPL (orange), HB (grey) |
| Chaos controls | Kill/Isolate/Restore buttons |

### Chaos controls -- per-node failure tracking

The aggregator tracks which failure mode was applied to each node (`killed` or `isolated`).
When a node is in a failed state, targeted fix buttons appear automatically:

- Node was **killed** (container stopped) -> "Revive nodeX" button (red `killed` pill)
- Node was **isolated** (network disconnected) -> "Reconnect nodeX" button (orange `isolated` pill)
- **Restore All** reads the tracked state and applies the correct fix per node

**Chaos buttons are disabled until the aggregator confirms the docker command completed** -- not a fixed timer -- to prevent double-firing.

**Docker Desktop / Windows isolation behaviour (confirmed empirically):**
`docker network disconnect` drops the container's host port binding, not just the inter-container path. `docker network connect` and `docker compose restart` do not restore it. Only `docker compose up -d <service>` (which recreates the container) restores both network membership and the host port binding. The aggregator uses `docker compose up -d` for both kill recovery and isolation recovery.

### Generating a demo video

1. `docker compose up -d` + `npm run server` + `npm run dev`
2. Open http://localhost:5173
3. Click **Kill node2** -- node2 turns red within ~6 s
4. Click **Restore All** -- node2 turns green, re-sync event appears in log
5. Run `.\scripts\run-chaos.ps1` in a 4th terminal -- ring pulses with live traffic
6. Screen-record the browser window; trim to 2-3 min

> Screenshot / GIF placeholder -- add after recording
