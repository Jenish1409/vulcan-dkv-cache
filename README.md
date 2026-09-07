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
| Replication / quorum | Phase 3 |
| Dynamic node discovery (gossip) | Phase 3 |
| Persistence (WAL / snapshots) | Phase 4+ |
| Chaos testing | Phase 5+ |
| Docker / deployment | Phase 6+ |

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
npm test          # 27 (Phase 1) + 13 (Phase 2 HashRing) = 40 tests
npm run build     # TypeScript compiles with no errors
```
