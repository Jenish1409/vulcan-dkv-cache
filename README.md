# Vulcan — Distributed Key-Value Cache

> A portfolio project building a distributed KV cache from scratch — consistent hashing, replication, and chaos testing — one phase at a time.

---

## Phase 1 — Single-Node In-Memory Store

### What it does

A single-process, in-memory key-value store with:

| Feature | Detail |
|---------|--------|
| **SET / GET / DELETE** | O(1) average-case via HashMap |
| **Optional TTL** | Per-key expiry in seconds |
| **LRU eviction** | Bounded memory with O(1) evict |

---

### Design Decisions

#### 1 — Why O(1) for everything?

The backing `Map<string, Node>` gives O(1) key lookup. Reads and deletes go straight to the map with no scanning. The doubly linked list (DLL) handles recency tracking in O(1) pointer rewires.

A naive "find the oldest entry" approach would be O(n) on every eviction — unacceptable at scale.

---

#### 2 — LRU via doubly linked list + HashMap

The cache maintains two data structures in sync:

```
HashMap  →  { key: Node }         ← O(1) lookup
DLL      →  head ↔ [MRU] ↔ … ↔ [LRU] ↔ tail   ← O(1) promote & evict
```

**Key insight:** every node in the DLL also lives in the map. So we can jump to any node by key in O(1), then rewire its `prev`/`next` pointers in O(1) to move it to the MRU position. No scanning needed.

Two sentinel nodes (head, tail) are permanently planted at each end. They eliminate `null` checks on the edge cases of an empty list, and make insertion/deletion code uniform.

**Operations:**
- `GET`: look up node in map → lazy-expire check → rewire to MRU → return value
- `SET`: if key exists, update + promote to MRU; if new, evict LRU if at cap, then insert at MRU
- `DELETE`: look up in map, remove from map and DLL

---

#### 3 — TTL: lazy expiry + active sweep (both, always)

Two strategies run in parallel — this is how Redis does it:

**Lazy expiry** (per-read)
- Every `GET` checks `Date.now() >= node.expiresAt`.
- If expired: delete node, return `null`.
- Cost: one comparison per read — effectively free.
- Problem: cold keys (written, never read) sit in memory forever.

**Active sweep** (background `setInterval`)
- Walks the entire map every N milliseconds and purges all expired entries.
- Bounds worst-case memory growth regardless of read activity.
- Cost: O(n) — runs infrequently (default: every 1 second).
- Problem if used *alone*: wastes CPU even when nothing is expiring.

**Why both?**
- Lazy alone: O(1) hot path, but you can leak unbounded memory for cold keys.
- Active alone: catches everything but burns CPU on every tick even if 0 keys expire.
- Together: the lazy path handles the common case for free; the sweep is the safety net. This is the industry standard (Redis, Memcached, Caffeine all use this pattern).

The sweep timer is `.unref()`-ed so it never prevents the Node.js process from exiting naturally.

---

#### 4 — Generic type parameter `LRUCache<V>`

The class is generic: `LRUCache<V = unknown>`. The value type is enforced at compile time so TypeScript consumers get full type safety — no `any`, no casting.

---

#### 5 — `destroy()` for resource cleanup

The sweep `setInterval` holds a reference that prevents garbage collection. Calling `destroy()` clears the interval and the map. This is critical in tests (prevents timer leaks between test cases).

---

### File Structure

```
vulcan/
├── src/
│   └── store/
│       ├── LRUCache.ts        ← Core implementation (DLL + HashMap + TTL)
│       └── index.ts           ← Barrel re-export for later phases
├── tests/
│   └── store/
│       └── LRUCache.test.ts   ← Jest unit tests
├── jest.config.ts
├── tsconfig.json
├── package.json
└── README.md
```

---

### Running the Tests

```bash
# Install dependencies
npm install

# Run all tests
npm test

# Run in watch mode (re-runs on file save)
npm run test:watch

# Run with coverage report
npm run test:coverage
```

Tests use **Jest fake timers** (`jest.useFakeTimers()`) so TTL expiry tests run instantly without `sleep`. No real time passes.

---

### What's deferred to later phases

| Feature | Phase |
|---------|-------|
| ~~Network protocol (TCP/gRPC)~~ | ~~Phase 2~~ ✅ Done |
| ~~Consistent hashing ring~~ | ~~Phase 2~~ ✅ Done |
| ~~Heartbeat / failure detection~~ | ~~Phase 3~~ ✅ Done |
| ~~Ring recovery on node failure~~ | ~~Phase 3~~ ✅ Done |
| ~~Replication / read fallback~~ | ~~Phase 4~~ ✅ Done |
| ~~Rejoin re-sync~~ | ~~Phase 4~~ ✅ Done |
| ~~Docker / containerised deployment~~ | ~~Phase 5~~ ✅ Done |
| ~~Benchmarking (Vulcan vs Redis)~~ | ~~Phase 6~~ ✅ Done |
| Dynamic node discovery (gossip) | Phase 7+ |
| Persistence (WAL / snapshots) | Phase 7+ |
| Chaos testing | Phase 7+ |

The `LRUCache` class is intentionally self-contained and import-friendly — the Phase 2 HTTP layer wraps it without modifying a single line.

---

## Phase 2 — HTTP Layer + Consistent Hashing Ring

### What it does

| Feature | Detail |
|---------|--------|
| **REST API per node** | `PUT /kv/:key`, `GET /kv/:key`, `DELETE /kv/:key`, `GET /health` |
| **Consistent hash ring** | SHA-256, 150 virtual nodes/physical node, O(log n) key lookup |
| **Embedded routing** | Any node accepts any request and forwards to the correct owner |
| **Static peer config** | `PEERS` env var — dynamic discovery is Phase 3 |

---

### Design Decisions

#### 1 — Why consistent hashing instead of `hash(key) % N`?

With naive modulo hashing, adding or removing **one** node causes almost
**all** keys to remap — because every key's modulus denominator `N` changes.
Example: with 4 nodes → 5 nodes, `key % 4` and `key % 5` rarely agree, so
~80% of keys move.  Cache hit rate crashes to near zero on any topology change.

**Consistent hashing** places nodes and keys on a circular hash ring
(0…2³²-1).  Each key is owned by the **first node clockwise** from it.
When a node is added, only the keys in its "arc" of the ring move — typically
`1/(N+1)` of total keys.  All other keys stay untouched.

Our measured result: adding a 5th node to a 4-node ring remapped **~20%**
of 10,000 test keys — exactly the theoretical expectation.  With naive
modulo, the same operation would remap ~80%.

#### 2 — Why virtual nodes (vnodes)?

With one ring position per physical node, random SHA-256 placement can
create highly uneven arcs.  One node might own 50% of the ring; another
only 5%.

Each physical node is assigned **150 virtual nodes** — proxy positions
spread across the ring.  With more points, the arc sizes average out via
the law of large numbers.  Our distribution test verifies no single node
owns more than 40% of keys.  Cassandra uses 256 vnodes per node; 150 is
a common production default.

#### 3 — Routing: embedded in each node (not a dedicated coordinator)

Every Vulcan node maintains its own copy of the `HashRing`.  When a request
arrives for a key owned by a different node, the receiving node forwards
the request via HTTP and relays the response.  The client sees a single
response regardless of which node it contacted.

**Why not a separate coordinator process?**
- Coordinator = single point of failure
- Every extra process to manage in ops
- Phase 3 replication will make reads local anyway — the forward hop
  disappears once any node can serve reads from a replica

#### 4 — `GET /health` is forward-compatible

The `HealthResponse` type in `src/server/types.ts` is designed to grow:
Phase 3 will add `replicationLag`, `peerStatuses`; Phase 4 may add
`vnodeCount`.  Clients can safely ignore unknown fields.

---

### Running the Cluster

#### Quick start (opens 3 terminal windows)

```powershell
.\scripts\start-cluster.ps1
```

#### Manual start (PowerShell — one terminal per node)

```powershell
# Terminal 1 — node1
$env:NODE_ID="node1"; $env:PORT="5001"; $env:PEERS="node1:localhost:5001,node2:localhost:5002,node3:localhost:5003"; npm run start:node

# Terminal 2 — node2
$env:NODE_ID="node2"; $env:PORT="5002"; $env:PEERS="node1:localhost:5001,node2:localhost:5002,node3:localhost:5003"; npm run start:node

# Terminal 3 — node3
$env:NODE_ID="node3"; $env:PORT="5003"; $env:PEERS="node1:localhost:5001,node2:localhost:5002,node3:localhost:5003"; npm run start:node
```

#### Verify cross-node routing

```powershell
# Run the automated smoke test
.\scripts\smoke-test.ps1

# Or manually:
# Write via node1
Invoke-RestMethod -Method PUT -Uri 'http://localhost:5001/kv/hello' `
  -Body '{"value":"world"}' -ContentType 'application/json'

# Read via node3 — the handledBy field shows which node actually stored it
Invoke-RestMethod -Uri 'http://localhost:5003/kv/hello'
# → { key: "hello", value: "world", handledBy: "node1" }  (or node2, depending on ring)
```

#### Run all tests

```bash
npm test          # 27 (Phase 1) + 17 (Phase 2 HashRing) = 44 tests
npm run build     # TypeScript compiles with no errors
```

---

## Phase 3 — Heartbeat, Failure Detection & Ring Recovery

### What it does

| Feature | Detail |
|---|---|
| **Heartbeat** | Each node pings every peer via `GET /health` every 2 s |
| **Failure detection** | 3 consecutive missed pings → peer marked DEAD, removed from local ring |
| **Automatic rerouting** | Once a node is removed from the ring, its key range falls to the next clockwise node — no extra code needed, `HashRing.removeNode()` handles it |
| **Rejoin handling** | First successful ping after DEAD → peer re-added to ring, logged clearly |
| **Observable state** | `GET /health` now includes `clusterView` — per-peer ALIVE/DEAD status readable over HTTP |
| **Ring owner debug** | `GET /ring/owner/:key` — returns predicted owner without storing anything |

---

### Heartbeat Config Values

| Setting | Default | Rationale |
|---|---|---|
| `HEARTBEAT_INTERVAL_MS` | **2 000 ms** | Fast enough for ~6 s detection; slow enough not to flood peers |
| `PING_TIMEOUT_MS` | **1 500 ms** | Shorter than interval so pings don't pile up. 500 ms slack per cycle |
| `FAILURE_THRESHOLD` | **3 consecutive failures** | 3 × 2 s = **6 s** to declare dead. Absorbs 2 transient packet losses before acting. Production Cassandra uses ~10 s; 6 s fits a dev cluster |

All three are overridable via environment variables.

---

### "Each node has its own local view" — what that means

There is **no distributed consensus** on cluster membership. Each node runs its own heartbeat loop independently and maintains its own copy of the ring.

**Convergence window**: if node1 detects node2 dead 2 s before node3 does, during that ~2 s window they briefly disagree on ring topology. The worst case is one forwarded request bounces off the dead node and returns a 502 — the client retries and succeeds once all nodes converge.

**Why this is acceptable at this stage**: Forcing agreement would require Raft or Paxos — a significant complexity jump that belongs in a later phase. The window is bounded to ≤ 1 heartbeat interval and resolves automatically. This is the same trade-off production gossip protocols (Cassandra, Consul) make — they call it *eventual consistency of cluster membership*.

---

### Architecture: `processPingResult` as the testable unit

`HeartbeatManager` separates network I/O from state-machine logic:
- `tick()` — runs on the interval, calls `pingFn(peer)` in parallel
- `processPingResult(nodeId, alive)` — **public, synchronous** state machine; takes a pre-computed boolean

This means unit tests call `processPingResult` directly — no HTTP servers, no fake timers, no mocks of axios. The `pingFn` is injected and replaced with a stub in tests.

---

### Running the failure demo

```powershell
# Self-contained — starts its own cluster, runs all 12 steps, cleans up
.\scripts\failure-test.ps1
```

What it proves (with real terminal output):
1. All 3 nodes start ALIVE
2. Keys are discovered on node2 using `GET /ring/owner/:key` (no guessing)
3. Those keys are written and confirmed `handledBy: node2`
4. node2 is killed
5. After ~6 s: node1 and node3 both show node2 as `DEAD` in `/health`
6. The same keys return `404` — **data is gone, as expected** (no replication yet)
7. Writing those keys again routes them to node1/node3 — **rerouting confirmed**
8. node2 is restarted; after ~6 s both surviving nodes show it `ALIVE` again
9. node2 rejoins empty — data written during the outage stays on node1/node3

#### Live results from an actual run

```
Ring ownership (100 keys via /ring/owner/:key):
  node1: 36  |  node2: 29  |  node3: 35

After killing node2 and waiting 10s:
  port 5001 sees node2 as: DEAD  (consecutiveFailures=8)
  port 5003 sees node2 as: DEAD  (consecutiveFailures=8)

Data on dead node (404 as expected):
  probe-key-0, probe-key-1, probe-key-5, probe-key-6, probe-key-9 -> all 404

New writes rerouted:
  probe-key-0 -> node1  |  probe-key-1 -> node3
  probe-key-5 -> node3  |  probe-key-6 -> node1  |  probe-key-9 -> node3

After restarting node2:
  port 5001 sees node2 as: ALIVE
  port 5003 sees node2 as: ALIVE

Results: 35 passed, 0 failed
```

#### Run all tests

```bash
npm test          # 44 (Phase 1+2) + 19 (Phase 3) = 63 tests
npm run build     # TypeScript compiles with no errors
```

---

### What's deferred to Phase 4+

| Feature | Why deferred |
|---|---|
| Data recovery on rejoin | node2 comes back empty -- requires replication to restore its key range |
| Keys migrated back to node2 | Needs gossip / data migration |
| Consensus on cluster membership | Raft/Paxos -- out of scope for Phase 3 |
| Docker / chaos harness | Phase 5+ |

---

## Phase 4 -- Replication, Read Fallback & Rejoin Re-sync

### What it does

| Feature | Detail |
|---|---|
| **Replication factor** | Configurable `REPLICATION_FACTOR` (default: 2). Each key lives on 1 primary + 1 replica. |
| **Replica placement** | `HashRing.getReplicaNodes(key, RF)` walks clockwise from primary, collecting N **distinct** physical nodes. Never picks the same physical node twice via a different virtual-node position. |
| **Async write replication** | Primary writes locally, returns 200 to client, fires replica writes in background (fire-and-forget). Client latency is unaffected by replica write time. |
| **Read fallback** | If the primary is DEAD, the reader falls back to the next live replica in order. Uses `fullRing` (stable, never modified) for replica placement and heartbeat status for liveness. |
| **Rejoin re-sync** | When a dead node comes back ALIVE, surviving nodes push the relevant key-value pairs back to it. Entries are **filtered** before sending -- only keys where `fullRing.getReplicaNodes(key, RF).includes(rejoinedNodeId)` are pushed. |
| **Two-ring architecture** | `ring` (modified by heartbeat) for live routing. `fullRing` (read-only, all peers) for stable replica placement. |

---

### Consistency model: Asynchronous replication

**What it is**: The primary writes locally, responds to the client with 200, then fires writes to replica nodes in the background. The client never waits for replicas to acknowledge.

**Why this choice**: It minimises write latency and is simple to implement correctly. For a portfolio project demonstrating distributed systems concepts, this is the right starting point.

**The durability risk**: If the primary crashes in the tiny window *after* returning 200 to the client but *before* the background replica write completes, that write is permanently lost -- neither the primary (dead) nor the replica (never received it) has the data.

**What a real system would do**: Offer a configurable `SYNC` mode: the primary waits for at least W replica acknowledgements before responding (W=1 means "at least one replica confirmed"). This eliminates the durability gap at the cost of added latency proportional to the slowest replica in your write quorum. Cassandra, DynamoDB, and Riak all expose this as a tunable `consistency_level` / `WriteConcern`.

**Interview explanation**: "We chose async replication because it keeps write latency identical to a single-node store. The trade-off is a small durability window between the primary's response and the replica commit. In production I'd add a sync mode with quorum writes for critical data -- the `REPLICATION_FACTOR` and `W` (write quorum) are already the natural configuration knobs for that."

---

### Two-ring architecture: why it exists

After a node dies, `HeartbeatManager` calls `ring.removeNode(deadNodeId)`. The dead node no longer exists in `ring`, so `ring.getReplicaNodes(key, RF)` can no longer return it.

But to serve a read fallback we need to know: *who was holding the replica before the primary died?* That requires the **original** consistent-hashing assignment, which includes the dead node's virtual positions.

Solution: maintain a **second ring** (`fullRing`) seeded from all configured peers and never modified. Rules:
- `ring` -- used for routing new writes to live nodes only.
- `fullRing` -- used for replica placement (read fallback, re-sync filtering). Read-only.

---

### Rejoin re-sync filtering (correctness invariant)

When node2 rejoins, surviving nodes collect dumps from all live peers and their own caches. A peer's dump contains keys for **many different** primary/replica assignments -- not just node2's range.

Before pushing anything to node2, each entry is filtered:

```typescript
const owners = fullRing.getReplicaNodes(key, REPLICATION_FACTOR);
if (owners.includes(rejoinedNodeId)) {
  // only push this key to the rejoining node
}
```

This prevents node2 from receiving keys it is not responsible for, which would corrupt the ownership model.

The filtering is **observable** in the logs:
```
[node1] RESYNC: 12/38 keys filtered for "node2" (26 skipped -- not in replica list)
[node1] RESYNC complete for "node2": 12 pushed, 0 failed
```

---

### Running the replication demo

```powershell
# Self-contained -- starts its own cluster, runs all 8 steps, cleans up
.\scripts\replication-test.ps1
```

What it proves:
1. Cluster starts with RF=2
2. A key is written to node2 (primary) and confirmed on node1 (replica)
3. node2 is killed
4. `GET key` still returns the correct value, served by node1 (replica)
5. This is **meaningfully different from Phase 3** -- Phase 3 returned 404
6. New writes to node2's range route to surviving nodes
7. node2 restarts, re-sync runs
8. node2 has the key back

#### Live results from an actual run

```
Step 2 -- key='repl-key-0'  primary=node2  replica=node1

Step 3 -- replication confirmed:
  PUT handledBy: node2
  Replica node1 has value='phase4-value' via /internal/get  [PASS]

Step 4 -- node2 killed. Heartbeat detects DEAD after 10s.

Step 5 -- THE MONEY SHOT:
  GET value='phase4-value'  handledBy=node1  [PASS]
  (Phase 3 would have returned 404 here)

Step 8 -- re-sync:
  node2 has 'repl-key-0' back after re-sync  [PASS]
  node1 sees node2 as ALIVE  [PASS]

Results: 13 passed, 0 failed
```

#### Run all tests

```bash
npm test          # 63 (Phase 1-3) + 13 (Phase 4 getReplicaNodes) = 76 tests
npm run build     # TypeScript compiles with no errors
```

---

### What's deferred to Phase 6+

| Feature | Why deferred |
|---|---|
| Delete replication | Replicas serve stale data after a delete until re-sync. Full delete fan-out deferred. |
| Incremental / range-scoped re-sync | Full dump is naive for large caches. Phase 6 can scope by key range. |
| Read quorum (R > 1) | Currently reads from first live replica. A quorum read provides stronger consistency. |
| Dynamic node discovery (gossip) | Phase 6+ |
| Persistence (WAL / snapshots) | Phase 6+ |
| Chaos testing harness | Phase 7+ |

---

## Phase 5 -- Docker Deployment

### Quick start

```powershell
# Build images and start the 3-node cluster
docker compose up --build -d

# Check all 3 containers are healthy
docker compose ps

# Stream logs from one node
docker compose logs -f node1

# Tear down
docker compose down
```

### Run test scripts against the Docker cluster

```powershell
# smoke-test.ps1 works with zero changes (talks to localhost:5001/5002/5003)
.\scripts\smoke-test.ps1

# failure-test.ps1: -UseDocker skips Start-Job, uses docker compose stop/start
.\scripts\failure-test.ps1 -UseDocker

# replication-test.ps1: same -UseDocker pattern
.\scripts\replication-test.ps1 -UseDocker
```

Phase 5 verified results (against live Docker cluster):

| Script | Result |
|---|---|
| smoke-test.ps1 | 5/5 PASS (zero changes required) |
| failure-test.ps1 -UseDocker | 35/35 PASS |
| replication-test.ps1 -UseDocker | 15/15 PASS |

### Container networking: how PEERS works inside Docker

Outside Docker, nodes reach each other via `localhost:500N`. Inside Docker each
container has its own network namespace -- `localhost` inside the container refers
to that container only, not its peers.

Docker Compose creates a shared bridge network and makes each service's name a
resolvable DNS hostname within that network. The `PEERS` env var therefore uses
Docker service names as the host field:

```
PEERS=node1:node1:5001,node2:node2:5002,node3:node3:5003
       ^^^^^ nodeId  ^^^^^ Docker DNS hostname  ^^^^^ port
```

Heartbeat pings, replica fan-out, and rejoin re-sync dump fetches are all
container-to-container calls that use these service-name addresses.

Host-side (`localhost:5001/5002/5003`) is handled by Docker port mapping:
`ports: 5001:5001` forwards host traffic to the matching container. The
existing test scripts run on the host and therefore need no changes at all.

### Why multi-stage build?

The builder stage installs all 396 packages (including TypeScript, ts-node, Jest)
and compiles `src/` to `dist/`. The runtime stage starts fresh and installs only
the 81 production packages (express, axios). This:

- Keeps the final image lean (no TypeScript compiler, no test runner shipped).
- Prevents accidental source-code leakage into the container.
- Means layer cache invalidation on source changes only rebuilds the compile step,
  not the much-slower full npm ci.

### Why non-root user?

The runtime stage creates a dedicated `vulcan` user (UID 1001) and runs the
Node process under that account. Two reasons worth knowing:

1. **Blast-radius containment**: if an attacker exploits the Node process and
   escapes the container, a root container grants host-root access to the kernel
   surface. A non-root user limits what they can do even if they escape.
2. **Production compliance**: GKE, ECS, and most enterprise Kubernetes policies
   enforce `runAsNonRoot` by default. Building this habit costs nothing.

### What's deferred to Phase 6+

- Multi-machine deployment (requires an orchestrator or bare-metal provisioning).
- Docker Swarm / Kubernetes manifests.
- Named volumes / persistence per container.
- Centralised log aggregation (e.g. Loki, CloudWatch).
- Per-container CPU/memory resource limits.

---

## Phase 6 -- Benchmarking (Vulcan vs Redis)

Full results, raw data, and honest analysis in [`benchmarks/README.md`](./benchmarks/README.md).

### Headline numbers

**Environment:** Docker Desktop (WSL2), Node.js v22.19.0, autocannon v8, redis npm client v4.

| Scenario | Vulcan (3-node, RF=2) | Redis (Node client) | Redis (native ceiling) |
|---|---|---|---|
| GET throughput (c=50) | **2,193 req/s** | 14,162 ops/s | 167,504 ops/s |
| PUT/SET throughput (c=50) | **1,119 req/s** | 13,854 ops/s | 158,228 ops/s |
| Mixed 80/20 (c=50) | **1,942 req/s** | 13,556 ops/s | ~160,000 ops/s |
| GET p50 / p99 (c=10) | **4 ms / 11 ms** | 0.74 ms / 2.55 ms | 0.15 ms / 0.44 ms |

### Forwarding-hop delta

Only variable: whether the key is owned by the node being hit, or must proxy to a peer.

| | req/s | p50 | p99 |
|---|---|---|---|
| Local GET (no hop) | 4,959 | 1 ms | 5 ms |
| Forwarded GET (proxy to node2) | 1,526 | 6 ms | 13 ms |
| **Hop cost** | **3.25× slower** | **+5 ms** | **+8 ms** |

### Why the gap exists (short version)

1. **HTTP/JSON vs RESP binary** -- headers, JSON parse/stringify, Express middleware (~5-10× alone)
2. **Node.js vs C** -- V8 GC pauses visible in p99 tails (~2-3× on top)
3. **Cross-node forwarding** -- doubles HTTP overhead per proxied request (measured: 3.25× throughput reduction, +5ms p50)
4. **Async replication** -- PUT fan-out adds background pressure; PUT p99 (112ms) is 2× GET p99 (56ms)

### Run benchmarks yourself

```powershell
# Cluster must be running first
docker compose up -d

# One-command full benchmark suite (autocannon + redis npm + redis-benchmark)
.\scripts\run-benchmarks.ps1

# Results saved to benchmarks/raw/ (JSON + txt)
```

### What's deferred to Phase 7+

- ~~Chaos testing harness~~ ✅ **Phase 7 complete — see below**
- Benchmark with RF=1 disabled to isolate replication overhead precisely
- Performance tuning (msgpack, multi-core Node.js cluster, HTTP/2) -- no code changes in Phase 6 per spec

---

## Phase 7 — Chaos Testing Harness

A separate tool (`chaos/`) that runs continuous load against the live cluster,
injects failure scenarios, and checks every response for consistency violations.

### What it does

| Component | Description |
|---|---|
| **Load generator** | 5 workers × 20 req/s, 40% SET / 60% GET, randomised key pool |
| **Fault injector** | Node kill (`docker compose stop`), network isolation (`docker network disconnect`), malformed value injection |
| **Flight recorder** | Synchronous JSONL log — crash-safe, one entry per operation |
| **Linearizability checker** | Self-validates, checks INVENTED\_VALUE and FUTURE\_READ hard invariants |

### Fault scenario sequence

```
T+0–15s    Baseline
T+15–45s   Kill node2 (30s down)
T+45–75s   node2 rejoin + re-sync window
T+75–95s   Isolate node1 from Docker network (20s)
T+95–115s  Restore node1, reconverge
T+115–120s Malformed value injection (expects 400)
T+120–180s Final baseline
```

### What the two runs found

**Malformed value (Run 1):** Express's default 100 KB body-parser limit
intercepted the 1 MB request and returned 500 before our validator ran.
Fixed: `app.use(express.json({ limit: '2mb' }))`.
**Malformed value (Run 2):** ✅ 400 correctly returned.

**Two Generals Problem — reproduced on BOTH runs:**

> A write that appeared to fail (HTTP timeout during network isolation)
> was actually committed on the primary node. After reconnection, the
> primary served this "phantom" value to subsequent GETs.

This is a **fundamental limitation of single-round-trip HTTP writes without
distributed coordination** — not a Vulcan implementation bug and not a
patch target. Every AP-model KV store without 2PC/Raft/Paxos has this window.

The linearizability checker correctly detected it as INVENTED\_VALUE:
the client's application state said "that value was never written" but
the cluster disagreed. The exact reproducing sequence is documented in
[`chaos/README.md`](chaos/README.md).

| Run | Operations | INVENTED_VALUE | FUTURE_READ | Stale reads | Malformed result |
|---|---|---|---|---|---|
| Run 1 | ~2,900 | **9** | 0 | 61 (informational) | ⚠️ 500 (body-parser) |
| Run 2 | ~2,900 | **14** | 0 | 65 (informational) | ✅ 400 |

### Run it

```powershell
docker compose up -d
.\scripts\run-chaos.ps1                      # default: 3 min, 20 req/s
.\scripts\run-chaos.ps1 -DurationSec 300     # longer run

# Re-analyze saved log without re-running:
npx --prefix chaos ts-node chaos/src/checker.ts chaos/logs/chaos-TIMESTAMP.jsonl
```

### What's deferred to Phase 8+

- Visual dashboard (Phase 8)
- Idempotency keys (Option C from Phase 7) — client-side protocol change, future work

