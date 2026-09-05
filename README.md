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

| Concern | Phase |
|---------|-------|
| Network protocol (TCP/gRPC) | Phase 2 |
| Multi-node cluster | Phase 3 |
| Consistent hashing ring | Phase 4 |
| Replication / quorum | Phase 5 |
| Persistence (WAL / snapshots) | Phase 6 |
| Chaos testing | Phase 7+ |
| Docker / deployment | Phase 8+ |

The `LRUCache` class is intentionally self-contained and import-friendly — later phases will wrap it behind a network handler without modifying this file.
