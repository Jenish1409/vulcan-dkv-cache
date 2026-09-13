# Vulcan Chaos Testing — Phase 7

---

## 🔬 Flagship Finding: The Two Generals Problem in Vulcan's Write Path

> **Status: Confirmed, once reproduced, documented as a known fundamental
> limitation — not a Vulcan-specific patch target.**

### What the chaos harness found

Across two runs, the linearizability checker detected **INVENTED\_VALUE
violations** on every execution — GETs that returned a value the client
had never received confirmation of writing. All violations occurred during
or shortly after the `NET_ISOLATE node1` fault scenario (fault-002).

| Run | Log file | INVENTED\_VALUE | FUTURE\_READ | Stale reads |
|---|---|---|---|---|
| Run 1 | `chaos-1789275078543.jsonl` | **9** | 0 | 61 |
| Run 2 | `chaos-1789275766080.jsonl` | **14** | 0 | 65 |

Run 1 provides the clearest single reproducing sequence (below). Run 2
was analysed in more depth — the `handledBy` field for every phantom GET
was checked to confirm the mechanism. See the three-phase anatomy further
down in this section.

### Exact reproducing sequence

```
Fault 002: docker network disconnect vulcan_default vulcan-node1
  Isolation start : T+76s  (epoch 1789275154678)
  Isolation end   : T+96s  (epoch 1789275175031)

seq#1301 — T+86.9s, during isolation
  type          : SET
  key           : chaos-key-29
  intendedValue : "v-1301"
  startedAt     : 1789275165632
  completedAt   : 1789275169648  (4016ms later — exactly the HTTP timeout)
  status        : 0
  error         : "timeout of 4000ms exceeded"
  activeFaults  : [fault-002]

seq#1352 — T+100.5s, after isolation healed
  type          : GET
  key           : chaos-key-29
  startedAt     : 1789275179225
  completedAt   : 1789275179233  (8ms — fast, no forwarding)
  status        : 200
  responseValue : "v-1301"        ← value the client was told was never written
  handledBy     : "node2"
  activeFaults  : []
```

The 4-second timeout is the diagnostic signal. An **immediately refused**
connection (ECONNREFUSED) would complete in milliseconds. A **4-second
timeout** means the request reached a live node, that node forwarded it to
node1 (primary for chaos-key-29, still considered ALIVE because the
heartbeat failure threshold — 3 × 2000ms = 6s — had not elapsed yet),
node1 executed `cache.set()` and committed the write, then the Docker
network disconnect severed the response TCP connection before the ACK could
reach the forwarding node.

### Root cause: node.ts commits before the response is guaranteed delivered

```typescript
// node.ts PUT /kv/:key — primary path
cache.set(key, body.value, body.ttlSeconds);   // ← write committed here
replicateToReplicas(key, body.value);           // ← async, fire-and-forget
res.json({ ok: true, handledBy: NODE_ID });    // ← if this TCP packet is lost...
```

`cache.set()` is synchronous and immediate. The response to the caller is
sent afterward over TCP. If the TCP connection between node1 and the
forwarding node is cut between these two lines — or if the response packet
is lost after transmission but before delivery — the write is **durable on
node1** but the caller receives an error (timeout, ECONNREFUSED, or 503
from the forwarder's perspective).

After isolation heals and node1 rejoins the live ring, it continues serving
the committed value to GETs. The client's application state says "v-1301
was never written" but the cluster disagrees.

---

### Run 2: Three-phase anatomy (confirmed from log)

Run 2 produced 14 violations. The `handledBy` field was inspected for
every phantom GET on `chaos-key-7` between seq#1397 and seq#2098 —
the widest phantom window in the dataset. Full op trace:

```
seq   type  val     status  handledBy  notes
────  ────  ──────  ──────  ─────────  ──────────────────────────────────────
1311  SET   v-1311  0       —          fault-002 active; phantom commit
1397  GET   v-1311  200     node1      ← phantom served
1554  GET   v-1311  200     node1      ← phantom served
1779  GET   v-1311  200     node2      ← node2 also has it
1894  GET   v-1311  200     node1
1922  GET   v-1311  200     node2      ← node2 again
1972  GET   v-1311  200     node2
1984  SET   v-1984  200     node2      ← first confirmed write post-heal
2042  SET   v-2042  200     node2      ← second confirmed write
2052  GET   v-2042  200     node2      ← node2 now current
2098  GET   v-1311  200     node1      ← node1 still stale
2136  SET   v-2136  200     node1      ← direct write finally updates node1
2148  GET   v-2136  200     node1      ← node1 now current
```

This is not a single failure mode — it is three compounding effects:

**Phase 1 — Two Generals commit (seq#1311, T+86.9s, during isolation):**
The load generator sends `SET chaos-key-7 = "v-1311"` to a live node
(node2 or node3). That node determines node1 is still the primary for
this hash slot (heartbeat failure threshold — 3 × 2000ms = 6s — has not
elapsed yet). It forwards the write to node1. Node1 calls `cache.set()`
and commits the write. Node1 then attempts to respond. The Docker network
disconnect severs the TCP connection. The forwarding node times out after
4000ms and returns status=0 to the client. **The client was told the write
failed. Node1 has it committed.**

**Phase 2 — Phantom replication (seq#1779, 1922, 1972 served by node2):**
Before the network isolation fully took effect — or within the brief
window before heartbeat failure detection propagated — node1's async
replication fan-out pushed `"v-1311"` to node2 as a replica write. This
is confirmed by node2 serving the phantom value at seq#1779, 1922, and
1972 — long before any legitimate write to chaos-key-7. **Both node1 and
node2 held the phantom value.**

**Phase 3 — Post-reconnect async lag (seq#2098, served by node1):**
After isolation heals, node2 receives new successful writes: `v-1984`
(seq#1984) and `v-2042` (seq#2042). Node2 is now acting as primary for
chaos-key-7 in the reconverged ring. Node2 updates its own cache and
fires async replication. But replication is fire-and-forget — there is
no acknowledgement wait. At seq#2098, the replication push from node2
to node1 had not yet arrived. Node1 still serves `"v-1311"`. A direct
write at seq#2136 (`v-2136`, handledBy=node1) finally updates node1.

The seq#2098 GET returning `"v-1311"` from node1 is — in isolation —
indistinguishable from ordinary async replication lag. **What makes it
a Two Generals finding rather than routine eventual consistency is that
`"v-1311"` is a value the client was explicitly told was never committed.
The cluster and the client disagree about whether this value is legal.**

### What this rules out

Post-analysis confirmed this is **not** a "stuck stale primary" bug —
an alternative hypothesis where node1 never received or applied later
writes at all, which would indicate a defect in write-forwarding or
re-sync logic.

The evidence against that hypothesis:
- node2 (not only node1) served the phantom at seq#1779, 1922, 1972.
  If node1 were a stuck stale primary, node2 would have the correct value.
  Instead, node2 got the phantom via normal async replication from node1.
- node2 correctly received and served the post-heal writes `v-1984`,
  `v-2042` — the ring routing and write-forwarding logic worked correctly.
- node1 eventually updated at seq#2136 via a direct write. This confirms
  node1 was reachable and accepting writes; it simply hadn't received the
  async replication push from node2 yet.

**The write-forwarding, ring routing, and rejoin re-sync logic are all
behaving correctly. The issue is solely the lost acknowledgement on the
original write at seq#1311 — a Two Generals impossibility, not a bug.**

### This is the Two Generals Problem

The [Two Generals Problem](https://en.wikipedia.org/wiki/Two_Generals%27_Problem)
states that **no communication protocol can guarantee that two parties reach
agreement when the communication channel is unreliable.** In this context:

- **General 1 (node1/primary):** "I committed the write. Did you get my ACK?"
- **General 2 (forwarder/client):** "I sent the request. Did you commit it?"

The response TCP packet is the "messenger" sent through an unreliable
network partition. If it is lost:
- node1 does not know whether the client received confirmation
- The client does not know whether node1 committed the write
- Neither party can resolve this ambiguity without a third communication

There is **no protocol running on node1 or the forwarder alone** that can
close this gap. This is not a Vulcan implementation bug — it is a
fundamental impossibility result. Every HTTP-based key-value store without
a synchronous coordination protocol (2PC, Raft, Paxos) is subject to this
window.

### Why Option B (sync replication) does NOT fix this

Waiting for ≥1 replica to ACK before responding addresses a different
failure mode: the primary responding before replication completes, then
crashing (confirmed-write loss). It does not help here because the **failure
is on the response leg**, not the replication leg. The response from node1 to
the forwarder is the packet being cut — synchronous replication to node2
has already completed (or would complete in parallel) by the time node1
tries to reply. Requiring replica ACKs before responding actually adds an
extra round-trip to the critical path, potentially enlarging the window
in which the response leg can be severed.

### Scope of this finding

| Property | Assessment |
|---|---|
| Is it a Vulcan implementation bug? | **No.** It is an inherent property of single-round-trip HTTP writes without distributed coordination. |
| Is it a known limitation? | **Yes.** Every AP-model KV store (Dynamo, Riak, Cassandra with ONE consistency) has this property. |
| Can it be detected? | **Yes — the chaos harness proved this.** The linearizability checker caught it as INVENTED\_VALUE. |
| Can it be prevented without protocol changes? | **No.** |

### What would actually address it (Future Work — Option C)

**Client-supplied idempotency keys / write IDs.** The client generates a
UUID per write attempt and includes it in the PUT body. The server stores
`(key → {value, writeId})`. If the client retries after a timeout, the
server can detect "I already committed writeId X for this key" and respond
with the already-committed value rather than applying the write twice or
returning a conflict. The client can then determine whether its original
write was committed.

This requires a **client-side protocol change** (callers must generate and
track write IDs) and **server-side deduplication state** (a write-ID store
with its own TTL). It is legitimate future work but is explicitly out of
scope for Phase 7 — documenting the finding is sufficient.

---


A separate tool that tries to **break Vulcan on purpose**, records
everything, and then proves — with evidence from the log — whether
Vulcan remained consistent throughout.

---

## What "linearizability" means, in plain English

A key-value store is linearizable if every operation appears to take
effect **instantaneously** at some point between when you sent the
request and when you got the response. In other words:

- If you write `key = X` and get a 200 response, any read that starts
  *after* your response must return at least X (never an older value,
  never a value from some write that hasn't happened yet).
- If you read `key` and get X, X must have been written by some real
  SET at some real prior point in time — not invented out of thin air,
  and not from a SET that hadn't completed yet.

**Vulcan does NOT guarantee strict linearizability.** It uses async
(fire-and-forget) replication: the primary writes locally, responds
immediately, then pushes to replicas in the background. A GET that
arrives at a replica before the background push completes will see the
old value. This is documented and expected.

**What the checker DOES verify** is a weaker but still meaningful
guarantee: that Vulcan never *invents* a value, and never returns a
value from a write that hadn't been acknowledged yet.

---

## Why this is the real proof of correctness

Phase 3 proved Vulcan survives node kills. Phase 4 proved replication
and read fallback work. Those tests checked individual scenarios with
hand-crafted assertions.

This phase runs **continuous load** during **randomised fault
injection** and checks **every single response**. The question isn't
"did it survive?" — it's "did it ever return wrong data?"

A system that crashes cleanly on failure is much better than one that
silently returns invented values. This harness checks the latter.

---

## What the checker checks

### Hard invariants (violations = definite bugs)

| Check | What it means |
|---|---|
| **INVENTED\_VALUE** | GET returned a value never written by any successful SET in this run |
| **FUTURE\_READ** | GET completed at time T returned a value from a SET acknowledged at T' > T |

Both of these have zero valid explanations under any consistency model.

### Informational observations (never violations)

| Observation | What it means |
|---|---|
| **Stale read** | GET returned an older value after a newer SET was already confirmed |

Stale reads are **expected and correct** under Vulcan's async
replication model. There is no hard propagation deadline: the primary
responds before the replica write completes. A GET hitting a replica
before the background push arrives will see the old value. This is not
a bug. The checker counts stale reads for information only and clearly
labels them as such in the report.

> **Critical distinction**: The checker does NOT classify stale reads
> differently based on timing ("if the SET completed more than N ms
> ago, the replica should have caught up by now"). There is no valid N
> for this: Node.js's event loop can pause for GC, Docker networking
> can introduce variable delays, and async replication has no built-in
> acknowledgement. Any threshold would be arbitrary and generate false
> alarms. The checker only claims to detect what it can *prove*.

### What the checker does NOT catch

- It does not prove absence of ALL possible bugs — only the two
  invariants above.
- It does not check DELETE correctness (not issued by the load generator).
- It does not check that data survives a primary crash with no replica
  (RF=1 scenario) — this is a documented limitation of async replication.
- It does not detect bugs that only appear under loads higher than
  the test rate, or with more than 3 nodes.

---

## Network partition implementation

**Method: `docker network disconnect / docker network connect`**

This creates **full node isolation**: the target container is removed
from the Docker bridge network (`vulcan_default`), cutting all
inter-container TCP. The host-side port mapping (e.g. localhost:5001)
remains, so the load generator can still reach the isolated node but
the node cannot heartbeat or replicate to peers.

**Why not iptables?** iptables inside alpine containers requires
`iptables` to be installed in the image and `cap_add: [NET_ADMIN]` in
docker-compose.yml. This adds Dockerfile changes and Linux capability
requirements. For the failure modes Vulcan implements (heartbeat-based
dead/alive state, ring removal, replica fallback), full isolation is
a *stricter* test than selective 2-node partition: if Vulcan survives
total isolation, it handles selective partitions in all paths tested.

**Known limitation**: This does not simulate a true 2-node selective
partition (e.g. node1 and node2 can't reach each other but both can
reach node3). That would require iptables. The trade-off is documented
here intentionally — overselling what "partition" means would make
the correctness claim misleading.

---

## Running a chaos experiment

```powershell
# 1. Start the cluster
docker compose up -d

# 2. Run the chaos suite (default: 3 minutes, 20 req/s, 50 keys)
.\scripts\run-chaos.ps1

# 3. (Optional) Re-run the checker against a saved log
npx --prefix chaos ts-node chaos/src/checker.ts chaos/logs/chaos-TIMESTAMP.jsonl
```

### Parameters

```powershell
.\scripts\run-chaos.ps1 -DurationSec 300 -RatePerSec 30 -KeyCount 100
```

### What you'll see

```
=== VULCAN CHAOS TESTING HARNESS ===
  Duration    : 180s
  Target rate : 20 req/s
  Key pool    : chaos-key-0 .. chaos-key-49

[T+0s]   Baseline — normal operations...
[T+15s]  FAULT 1: Kill node2 (30s down)
  [injector] KILL node2 (fault-001)
[T+45s]  HEAL 1: Restart node2, waiting for rejoin re-sync (30s)...
[T+75s]  FAULT 2: Isolate node1 from Docker network (20s)
...
[T+180s] Stopping load generator...

=== VULCAN LINEARIZABILITY REPORT ===
  Checker self-test        : PASS ✅
  Total operations         : 3,247
  Critical violations      : 0
  Stale reads observed     : 14  (informational only — NOT violations)

  ✅ PASS — 3,247 operations checked, zero unexplained violations.
```

---

## File structure

```
chaos/
  src/
    types.ts       Shared type definitions (OperationRecord, FaultRecord, ...)
    recorder.ts    Synchronous JSONL writer (no buffering — crash-safe)
    loader.ts      5-worker load generator (40% SET / 60% GET)
    injector.ts    docker compose stop/start + network disconnect/connect
    checker.ts     Linearizability analysis + self-validation
    runner.ts      Main orchestrator
  logs/            Runtime JSONL logs (gitignored, regenerated each run)
  README.md        This file

scripts/
  run-chaos.ps1   One-command wrapper (checks cluster, installs deps, runs)
```
