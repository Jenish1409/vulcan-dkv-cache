/**
 * node.ts -- Vulcan Phase 2 + 3 + 4: Per-node HTTP server with heartbeat
 *            and asynchronous replication.
 *
 * Each instance of this process is ONE node in the Vulcan cluster.
 * It owns:
 *   1. A local LRUCache (Phase 1) -- stores keys it is responsible for.
 *   2. Two HashRing instances (Phase 2 + 4):
 *        ring     -- live ring, modified by HeartbeatManager (removes dead
 *                    nodes). Used for routing new client requests.
 *        fullRing -- read-only ring seeded from ALL configured peers.
 *                    Never modified. Used for replica-list lookup
 *                    (essential when the primary is dead and not in ring).
 *   3. A HeartbeatManager (Phase 3) -- pings peers, updates ring.
 *   4. Async replication (Phase 4) -- fan-out writes to replica nodes,
 *      read fallback to replicas when primary is dead, rejoin re-sync.
 *   5. An Express HTTP server.
 *
 * -- Consistency model (Phase 4) --
 * ASYNCHRONOUS replication. The primary writes locally, responds to the
 * client immediately, then fans out to replicas in the background.
 *
 * Trade-off: if the primary crashes AFTER responding but BEFORE a replica
 * write completes, that write is permanently lost. A synchronous model
 * (wait for at least one replica ack before replying) eliminates that risk
 * at the cost of added latency. We choose async here for simplicity and
 * note the limitation explicitly (see README Phase 4 section).
 *
 * -- Startup --
 * Required:
 *   NODE_ID   -- logical ID, e.g. "node1"
 *   PORT      -- TCP port, e.g. "5001"
 *   PEERS     -- "node1:localhost:5001,node2:localhost:5002,node3:localhost:5003"
 *
 * Optional:
 *   MAX_CAPACITY           -- LRUCache max keys       (default: 10000)
 *   SWEEP_INTERVAL         -- active-expiry sweep ms  (default: 5000)
 *   HEARTBEAT_INTERVAL_MS  -- ping interval ms        (default: 2000)
 *   PING_TIMEOUT_MS        -- per-ping timeout ms     (default: 1500)
 *   FAILURE_THRESHOLD      -- misses before DEAD      (default: 3)
 *   REPLICATION_FACTOR     -- copies per key          (default: 2)
 */

import express, { type Request, type Response, type NextFunction } from "express";
import { EventEmitter } from "events";
import { LRUCache } from "../store";
import { HashRing } from "../routing/HashRing";
import { forwardRequest } from "./router";
import { HeartbeatManager, DEFAULT_HEARTBEAT_CONFIG } from "./HeartbeatManager";
import type {
  NodeConfig,
  KVSetBody,
  KVGetResponse,
  KVMutateResponse,
  HealthResponse,
  PeerHealth,
  ReplicaInfo,
  ReplicaOwnerResponse,
  DumpResponse,
} from "./types";

/** Typed route params for /kv/:key and internal route handlers. */
interface KVParams { key: string; }

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const NODE_ID             = process.env["NODE_ID"] ?? "node1";
const PORT                = parseInt(process.env["PORT"] ?? "5001", 10);
const MAX_CAPACITY        = parseInt(process.env["MAX_CAPACITY"] ?? "10000", 10);
const SWEEP_INTERVAL_MS   = parseInt(process.env["SWEEP_INTERVAL"] ?? "5000", 10);
const HEARTBEAT_INTERVAL_MS = parseInt(
  process.env["HEARTBEAT_INTERVAL_MS"] ?? String(DEFAULT_HEARTBEAT_CONFIG.intervalMs), 10
);
const PING_TIMEOUT_MS = parseInt(
  process.env["PING_TIMEOUT_MS"] ?? String(DEFAULT_HEARTBEAT_CONFIG.timeoutMs), 10
);
const FAILURE_THRESHOLD = parseInt(
  process.env["FAILURE_THRESHOLD"] ?? String(DEFAULT_HEARTBEAT_CONFIG.failureThreshold), 10
);
/**
 * How many distinct physical nodes hold each key (primary + replicas).
 * Default: 2 (one primary + one replica). With 3 nodes, RF=2 tolerates
 * one node failure without data loss.
 */
const REPLICATION_FACTOR = parseInt(process.env["REPLICATION_FACTOR"] ?? "2", 10);

// ---------------------------------------------------------------------------
// Parse PEERS
// ---------------------------------------------------------------------------

function parsePeers(): NodeConfig[] {
  const raw = process.env["PEERS"] ?? `${NODE_ID}:localhost:${PORT}`;
  return raw.split(",").map((entry) => {
    const parts = entry.trim().split(":");
    if (parts.length !== 3) {
      throw new Error(
        `Invalid PEERS entry "${entry}". Expected format: "nodeId:host:port"`
      );
    }
    const [id, host, portStr] = parts;
    return { id, host, port: parseInt(portStr, 10) };
  });
}

// ---------------------------------------------------------------------------
// Cluster setup -- TWO rings
// ---------------------------------------------------------------------------

const peers   = parsePeers();
const nodeMap = new Map<string, NodeConfig>(peers.map((p) => [p.id, p]));

/**
 * LIVE ring -- starts with all peers, then HeartbeatManager removes dead nodes
 * and re-adds rejoined ones. Used for routing new client requests.
 */
const ring = new HashRing(peers.map((p) => p.id));

/**
 * FULL ring -- seeded once from all configured peers; NEVER modified.
 *
 * Why a second ring? After the primary dies, HeartbeatManager removes it
 * from ring. But to know which replica holds that key, we need the
 * original consistent-hashing assignment -- which still requires the dead
 * node's virtual positions on the ring. fullRing provides that stable view.
 *
 * Rule: fullRing is read-only. Only node.ts touches it (reads only).
 */
const fullRing = new HashRing(peers.map((p) => p.id));

if (!nodeMap.has(NODE_ID)) {
  throw new Error(
    `NODE_ID "${NODE_ID}" is not listed in PEERS. Add it to the PEERS env var.`
  );
}

const remotePeers = peers.filter((p) => p.id !== NODE_ID);

// ---------------------------------------------------------------------------
// Cache setup
// ---------------------------------------------------------------------------

const cache = new LRUCache<unknown>({
  maxCapacity: MAX_CAPACITY,
  sweepIntervalMs: SWEEP_INTERVAL_MS,
});

const startTime = Date.now();

// ---------------------------------------------------------------------------
// SSE event bus (Phase 9 — dashboard event streaming)
// ---------------------------------------------------------------------------

/**
 * In-memory pub/sub for the dashboard SSE stream.
 *
 * Performance note: emitEvent() is a synchronous in-memory function call.
 * It does NOT add a network hop to any existing handler. The replica-event
 * emits live inside the already-existing .then()/.catch() callbacks, so they
 * add zero latency to the primary write path. All Phase 6 benchmark numbers
 * remain valid.
 */
const eventBus = new EventEmitter();
eventBus.setMaxListeners(200); // allow many concurrent SSE subscribers

function emitEvent(payload: Record<string, unknown>): void {
  eventBus.emit("sse", { ...payload, ts: Date.now(), source: NODE_ID });
}

// ---------------------------------------------------------------------------
// Heartbeat status helpers
// ---------------------------------------------------------------------------

/**
 * Build a snapshot of this node's current ALIVE/DEAD view of the cluster.
 * Self is always ALIVE.
 */
function buildStatusMap(): Map<string, "ALIVE" | "DEAD"> {
  const map = new Map<string, "ALIVE" | "DEAD">();
  map.set(NODE_ID, "ALIVE");
  for (const p of heartbeat.getPeerStatuses()) {
    map.set(p.nodeId, p.status);
  }
  return map;
}

// ---------------------------------------------------------------------------
// Replica helpers (fullRing -- stable, never modified)
// ---------------------------------------------------------------------------

/**
 * Return the ordered replica NodeConfig list for key using fullRing.
 * Primary is index 0. Capped at REPLICATION_FACTOR (or cluster size).
 */
function getReplicaConfigs(key: string): NodeConfig[] {
  const nodeIds = fullRing.getReplicaNodes(key, REPLICATION_FACTOR);
  return nodeIds
    .map((id) => nodeMap.get(id))
    .filter((n): n is NodeConfig => n !== undefined);
}

/**
 * Return ReplicaInfo[] for the debug endpoint -- attaches ALIVE/DEAD per entry.
 */
function getReplicaInfos(key: string): ReplicaInfo[] {
  const configs = getReplicaConfigs(key);
  const statusMap = buildStatusMap();
  return configs.map((c, i) => ({
    nodeId: c.id,
    role: i === 0 ? "primary" : "replica",
    status: statusMap.get(c.id) ?? "DEAD",
  } as ReplicaInfo));
}

// ---------------------------------------------------------------------------
// Routing helpers (live ring)
// ---------------------------------------------------------------------------

/** Return the NodeConfig for the node that owns key on the LIVE ring. */
function ownerOf(key: string): NodeConfig {
  const ownerId = ring.getNodeForKey(key);
  const node = nodeMap.get(ownerId);
  if (node === undefined) {
    throw new Error(`Ring returned unknown node ID "${ownerId}" for key "${key}".`);
  }
  return node;
}

/** True if this process is the given node. */
function isSelf(node: NodeConfig): boolean {
  return node.id === NODE_ID;
}

// ---------------------------------------------------------------------------
// Async replication fan-out (write path)
// ---------------------------------------------------------------------------

/**
 * Fire-and-forget replica writes for a SET operation.
 *
 * Called AFTER the primary has already written locally and returned 200 to
 * the client. Failures are logged but never propagate to the client --
 * this is async (fire-and-forget) replication.
 *
 * Uses PUT /internal/replicate/:key on each replica so the replica writes
 * directly to its cache WITHOUT triggering another fan-out round (avoids
 * write storms and forwarding loops).
 */
function replicateToReplicas(key: string, body: KVSetBody): void {
  // FIX (Phase 4 bug): was getReplicaConfigs(key).slice(1), which assumed
  // NODE_ID is always fullRing's index-0 (primary). After failover, a
  // different node may handle the write -- e.g., if node2 is dead and the
  // live ring routes to node1 (fullRing's index-1 replica), slice(1) would
  // self-replicate to node1 instead of sending to node3.
  // Correct exclusion: send to every replica EXCEPT ourselves, by ID.
  const replicas = getReplicaConfigs(key).filter((n) => n.id !== NODE_ID);
  const statusMap = buildStatusMap();

  for (const replica of replicas) {
    if (statusMap.get(replica.id) === "DEAD") {
      console.warn(
        `[${NODE_ID}] REPLICATION SKIP: ${replica.id} is DEAD, skipping replica write for key "${key}"`
      );
      continue;
    }

    // Fire in background -- do NOT await
    forwardRequest(replica, "PUT", `/internal/replicate/${encodeURIComponent(key)}`, body)
      .then((result) => {
        const success = result.status === 200;
        emitEvent({ type: "replication", key, replicaId: replica.id, success });
        if (!success) {
          console.warn(
            `[${NODE_ID}] REPLICATION WARN: replica ${replica.id} returned ${result.status} for key "${key}"`
          );
        }
      })
      .catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        emitEvent({ type: "replication", key, replicaId: replica.id, success: false });
        console.warn(
          `[${NODE_ID}] REPLICATION ERROR: failed to replicate "${key}" to ${replica.id}: ${msg}`
        );
      });
  }
}

// ---------------------------------------------------------------------------
// Rejoin re-sync
// ---------------------------------------------------------------------------

/**
 * Triggered by HeartbeatManager's onRejoin callback when a peer comes back
 * ALIVE after being DEAD.
 *
 * Flow:
 *   1. Collect all live peers (excluding self and the rejoining node).
 *   2. Call GET /internal/dump on each, in parallel.
 *   3. Merge all entries (deduplicate by key -- last writer wins).
 *   4. FILTER: only keep entries where
 *        fullRing.getReplicaNodes(key, RF).includes(rejoinedNodeId)
 *      This prevents loading keys that do not belong to the rejoiner.
 *   5. Push each filtered entry to the rejoining node via
 *      PUT /internal/replicate/:key.
 *
 * This node acts as a coordinator -- it orchestrates the re-sync by
 * collecting data from its own cache and peers and pushing it to the
 * rejoining node.
 */
async function triggerRejoinResync(
  rejoinedNodeId: string,
  rejoinedConfig: NodeConfig
): Promise<void> {
  console.log(`[${NODE_ID}] RESYNC: initiating re-sync for rejoined peer "${rejoinedNodeId}"`);

  // Step 1: Collect dumps from self and all live non-rejoining peers.
  const statusMap = buildStatusMap();
  const sources: Array<{ id: string; entries: Array<{ key: string; value: unknown }> }> = [];

  // Include self's cache as one source.
  sources.push({ id: NODE_ID, entries: cache.entries() });

  // Include live remote peers (not self, not the rejoining node).
  const livePeers = remotePeers.filter(
    (p) => p.id !== rejoinedNodeId && statusMap.get(p.id) !== "DEAD"
  );

  const dumpResults = await Promise.allSettled(
    livePeers.map((p) => forwardRequest(p, "GET", "/internal/dump"))
  );

  for (let i = 0; i < livePeers.length; i++) {
    const result = dumpResults[i];
    if (result.status === "fulfilled" && result.value.status === 200) {
      const dump = result.value.data as DumpResponse;
      sources.push({ id: livePeers[i]!.id, entries: dump.entries });
    }
  }

  // Step 2: Merge entries (Map deduplicates; later source wins on collision).
  const merged = new Map<string, unknown>();
  for (const source of sources) {
    for (const { key, value } of source.entries) {
      merged.set(key, value);
    }
  }

  // Step 3: FILTER -- only keep keys where rejoinedNodeId is in the replica list.
  //
  // This is the critical correctness step. A peer's dump may contain keys
  // for ANY primary/replica assignment. We must only push keys that the
  // rejoining node is actually responsible for (primary or replica per fullRing).
  //
  //   fullRing.getReplicaNodes(key, RF) returns e.g. ["node2", "node3"]
  //   If rejoinedNodeId === "node2" --> keep this key.
  //   If rejoinedNodeId is NOT in the list --> skip it.
  //
  const keysToSync: Array<{ key: string; value: unknown }> = [];
  for (const [key, value] of merged) {
    const owners = fullRing.getReplicaNodes(key, REPLICATION_FACTOR);
    if (owners.includes(rejoinedNodeId)) {
      keysToSync.push({ key, value });
    }
  }

  console.log(
    `[${NODE_ID}] RESYNC: ${keysToSync.length}/${merged.size} keys filtered for "${rejoinedNodeId}" ` +
    `(${merged.size - keysToSync.length} skipped -- not in replica list)`
  );

  if (keysToSync.length === 0) {
    console.log(`[${NODE_ID}] RESYNC: nothing to send to "${rejoinedNodeId}"`);
    return;
  }

  // Step 4: Push filtered entries to the rejoining node in parallel.
  const pushResults = await Promise.allSettled(
    keysToSync.map(({ key, value }) =>
      forwardRequest(
        rejoinedConfig,
        "PUT",
        `/internal/replicate/${encodeURIComponent(key)}`,
        { value }
      )
    )
  );

  const ok     = pushResults.filter((r) => r.status === "fulfilled").length;
  const failed = pushResults.filter((r) => r.status === "rejected").length;
  console.log(
    `[${NODE_ID}] RESYNC complete for "${rejoinedNodeId}": ${ok} pushed, ${failed} failed`
  );
}

// ---------------------------------------------------------------------------
// HeartbeatManager
// ---------------------------------------------------------------------------

const heartbeat = new HeartbeatManager(
  NODE_ID,
  remotePeers,
  ring,
  { intervalMs: HEARTBEAT_INTERVAL_MS, timeoutMs: PING_TIMEOUT_MS, failureThreshold: FAILURE_THRESHOLD },
  undefined, // use default axios ping function
  (rejoinedNodeId, rejoinedConfig) => {
    // Kick off re-sync without blocking the heartbeat tick.
    triggerRejoinResync(rejoinedNodeId, rejoinedConfig).catch((err: unknown) => {
      console.error(`[${NODE_ID}] RESYNC ERROR for "${rejoinedNodeId}":`, err);
    });
  },
  // Phase 9: stream peer heartbeat transitions to the dashboard SSE bus.
  (peerId, status) => { emitEvent({ type: "heartbeat", peerId, status }); }
);

// ---------------------------------------------------------------------------
// Express app
// ---------------------------------------------------------------------------

const app = express();
// Body-parser limit is set to 2 MB so that requests up to 1 MB + overhead
// are parsed and reach our explicit MAX_VALUE_BYTES validator in PUT /kv/:key,
// which returns a clear 400. Without this, express's default 100 KB limit
// would intercept oversized payloads first and produce a confusing 500 via
// the generic error handler.
app.use(express.json({ limit: '2mb' }));

// ---------------------------------------------------------------------------
// Routes -- Health and Debug
// ---------------------------------------------------------------------------

/**
 * GET /health
 *
 * Returns this node's status + its current view of every peer's liveness.
 * Extended in Phase 4 to include replication factor.
 */
app.get("/health", (_req: Request, res: Response) => {
  const selfEntry: PeerHealth = {
    nodeId: NODE_ID,
    host: "localhost",
    port: PORT,
    status: "ALIVE",
    lastSeenMs: Date.now(),
    consecutiveFailures: 0,
  };

  const body: HealthResponse = {
    nodeId: NODE_ID,
    port: PORT,
    uptime: Math.floor((Date.now() - startTime) / 1000),
    keyCount: cache.size,
    peers: peers.map((p) => `${p.id}@${p.host}:${p.port}`),
    clusterView: [selfEntry, ...heartbeat.getPeerStatuses()],
    status: "ok",
  };
  res.json(body);
});

/**
 * GET /ring/owner/:key  (Phase 3 debug endpoint -- kept for backward compat)
 *
 * Returns the primary owner using the LIVE ring.
 */
app.get("/ring/owner/:key", (req: Request<KVParams>, res: Response) => {
  try {
    const { key } = req.params;
    const owner = ownerOf(key);
    res.json({ key, owner: owner.id, ringSize: ring.size });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(503).json({ error: "Ring unavailable.", detail: msg });
  }
});

/**
 * GET /ring/replicas/:key  (Phase 4 debug endpoint)
 *
 * Returns the full ordered replica list for a key using fullRing (stable,
 * includes dead nodes). Each entry shows ALIVE/DEAD status per this node's
 * current heartbeat view.
 *
 * Use this endpoint (not /ring/owner) to determine primary + replica placement.
 */
app.get("/ring/replicas/:key", (req: Request<KVParams>, res: Response) => {
  try {
    const { key } = req.params;
    const replicas = getReplicaInfos(key);
    const body: ReplicaOwnerResponse = {
      key,
      replicationFactor: REPLICATION_FACTOR,
      replicas,
    };
    res.json(body);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(503).json({ error: "Ring unavailable.", detail: msg });
  }
});

// ---------------------------------------------------------------------------
// Routes -- Internal (node-to-node only, not for external clients)
// ---------------------------------------------------------------------------

/**
 * PUT /internal/replicate/:key
 *
 * Writes a key directly to THIS node's local cache WITHOUT triggering
 * another replication fan-out. Used by:
 *   - The primary when fanning out writes to replica nodes.
 *   - The re-sync coordinator when pushing data to a rejoining node.
 *
 * This endpoint must NOT be confused with PUT /kv/:key (which routes to the
 * primary and then fans out).
 */
app.put("/internal/replicate/:key", (req: Request<KVParams>, res: Response) => {
  const { key } = req.params;
  const body = req.body as KVSetBody;

  if (!("value" in body)) {
    res.status(400).json({ error: 'Body must include a "value" field.' });
    return;
  }

  cache.set(key, body.value, body.ttlSeconds);
  const response: KVMutateResponse = { ok: true, handledBy: NODE_ID };
  res.json(response);
});

/**
 * GET /internal/get/:key
 *
 * Reads directly from THIS node's local cache WITHOUT forwarding anywhere.
 * Used by the read-fallback path to query specific replicas directly.
 *
 * Returns 404 if the key is absent or expired on this node.
 */
app.get("/internal/get/:key", (req: Request<KVParams>, res: Response) => {
  const { key } = req.params;
  const value = cache.get(key);

  if (value === null) {
    res.status(404).json({ error: "Key not found or expired on this node." });
    return;
  }

  const response: KVGetResponse = { key, value, handledBy: NODE_ID };
  res.json(response);
});

/**
 * GET /internal/dump
 *
 * Returns ALL live (non-expired) key-value pairs from this node's cache.
 * Used by the rejoin re-sync coordinator to gather data from peers.
 *
 * WARNING: Naive full-dump -- acceptable for Phase 4 dev cluster. A
 * production system would use range-scoped incremental sync (e.g. streaming
 * only the key ranges relevant to the requesting node).
 */
app.get("/internal/dump", (_req: Request, res: Response) => {
  const entries = cache.entries();
  const body: DumpResponse = {
    nodeId: NODE_ID,
    entryCount: entries.length,
    entries,
  };
  res.json(body);
});

// ---------------------------------------------------------------------------
// Routes -- Client-facing KV operations
// ---------------------------------------------------------------------------

/**
 * PUT /kv/:key
 *
 * Write path (Phase 4):
 *   1. If not primary: forward to primary (existing Phase 2 logic).
 *   2. If primary:
 *      a. Write locally.
 *      b. Return 200 to client immediately (async replication).
 *      c. Fire replica writes in background (non-blocking).
 *
 * The client never waits for replica writes -- this is async replication.
 * See the file-header comment for the consistency trade-off.
 */
app.put("/kv/:key", async (req: Request<KVParams>, res: Response, next: NextFunction) => {
  try {
    const { key } = req.params;
    const owner = ownerOf(key);

    if (isSelf(owner)) {
      const body = req.body as KVSetBody;

      if (!("value" in body)) {
        res.status(400).json({ error: 'Request body must include a "value" field.' });
        return;
      }

      // ── Phase 7 (2b): Value-size validation ─────────────────────────────
      // Intentional, scoped application-logic change for Phase 7 (the chaos
      // harness's malformed-value scenario verifies this rejection).
      //
      // Reject values whose JSON representation exceeds MAX_VALUE_BYTES.
      // This prevents a single write from consuming unbounded memory and
      // ensures bad input returns a clear 400 instead of silently being
      // stored or causing a crash.
      //
      // JSON.stringify returns `undefined` for un-serializable inputs
      // (functions, symbols, circular refs) -- we treat those as invalid too.
      const MAX_VALUE_BYTES = 1024 * 1024; // 1 MB
      let serializedSize: number;
      try {
        const serialized = JSON.stringify(body.value);
        if (serialized === undefined) {
          res.status(400).json({ error: "Value is not JSON-serializable." });
          return;
        }
        serializedSize = Buffer.byteLength(serialized, "utf8");
      } catch {
        res.status(400).json({ error: "Value is not JSON-serializable." });
        return;
      }
      if (serializedSize > MAX_VALUE_BYTES) {
        res.status(400).json({
          error:  `Value too large: ${serializedSize} bytes exceeds the 1 MB limit.`,
          limit:  MAX_VALUE_BYTES,
          actual: serializedSize,
        });
        return;
      }
      // ── End Phase 7 (2b) ─────────────────────────────────────────────────

      // Primary write.
      cache.set(key, body.value, body.ttlSeconds);

      // Phase 9: emit SET event to dashboard SSE bus.
      emitEvent({ type: "op:set", key, handledBy: NODE_ID, forwarded: false });

      // Respond to client BEFORE firing replicas -- async replication.
      const response: KVMutateResponse = { ok: true, handledBy: NODE_ID };
      res.status(200).json(response);

      // Background fan-out (non-blocking).
      replicateToReplicas(key, body);
    } else {
      // Not the primary -- forward to the live ring's owner.
      const { status, data } = await forwardRequest(
        owner, "PUT", `/kv/${encodeURIComponent(key)}`, req.body
      );
      // Phase 9: emit forwarded SET event.
      emitEvent({ type: "op:set", key, forwarded: true, forwardedTo: owner.id });
      res.status(status).json(data);
    }
  } catch (err) {
    next(err);
  }
});

/**
 * GET /kv/:key
 *
 * Read path (Phase 4):
 *   1. Compute the full replica list from fullRing (includes dead nodes).
 *   2. Walk the list in order (primary first, then replicas).
 *   3. For each node:
 *      - If DEAD: skip.
 *      - If self: read from local cache.
 *      - If live peer: forward to GET /internal/get/:key (direct local read,
 *        no further forwarding -- prevents forwarding loops).
 *   4. If all nodes are DEAD or return 404: return 503.
 *
 * This is the key behavior change from Phase 3: a dead primary is silently
 * bypassed and the replica answers instead.
 */
app.get("/kv/:key", async (req: Request<KVParams>, res: Response, next: NextFunction) => {
  try {
    const { key } = req.params;
    const replicaConfigs = getReplicaConfigs(key);
    const statusMap = buildStatusMap();

    for (const node of replicaConfigs) {
      const nodeStatus = statusMap.get(node.id) ?? "DEAD";
      if (nodeStatus === "DEAD") continue;

      if (isSelf(node)) {
        const value = cache.get(key);
        if (value !== null) {
          // Phase 9: emit GET served event.
          emitEvent({ type: "op:get", key, handledBy: NODE_ID });
          const response: KVGetResponse = { key, value, handledBy: NODE_ID };
          return res.json(response);
        }
        // Key absent locally -- try next replica.
        continue;
      }

      // Forward to the peer's direct local-read endpoint (no re-routing).
      const result = await forwardRequest(node, "GET", `/internal/get/${encodeURIComponent(key)}`);
      if (result.status === 200) {
        // Phase 9: emit GET served-by-peer event.
        emitEvent({ type: "op:get", key, handledBy: node.id });
        return res.status(200).json(result.data);
      }
      // 404 from peer -- try next replica.
    }

    // All live replicas exhausted.
    res.status(503).json({
      error: "Key not available -- all replicas are dead or do not have this key.",
      key,
    });
  } catch (err) {
    next(err);
  }
});

/**
 * DELETE /kv/:key
 *
 * Routes to the primary (live ring). No replication of deletes in Phase 4
 * -- replica nodes will serve stale data after a delete until re-sync.
 * Full delete replication is deferred to Phase 5.
 */
app.delete("/kv/:key", async (req: Request<KVParams>, res: Response, next: NextFunction) => {
  try {
    const { key } = req.params;
    const owner = ownerOf(key);

    if (isSelf(owner)) {
      const deleted = cache.delete(key);
      const response: KVMutateResponse = { ok: deleted, handledBy: NODE_ID };
      res.status(deleted ? 200 : 404).json(response);
    } else {
      const { status, data } = await forwardRequest(
        owner, "DELETE", `/kv/${encodeURIComponent(key)}`
      );
      res.status(status).json(data);
    }
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// Route -- SSE event stream (Phase 9 dashboard)
// ---------------------------------------------------------------------------

/**
 * GET /events
 *
 * Server-Sent Events stream consumed by the dashboard aggregator.
 * Each event is a JSON-encoded VulcanEvent on a `data:` line.
 *
 * Design note: This endpoint intentionally does NOT emit events for
 * internal replica writes (PUT /internal/replicate) or dump reads
 * (GET /internal/dump) -- those are node-to-node plumbing, not
 * client-facing operations worth surfacing in the dashboard.
 */
app.get("/events", (req: Request, res: Response) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.flushHeaders();

  // Keepalive comment every 15 s prevents proxy / load-balancer timeouts.
  const keepAlive = setInterval(() => { res.write(": keepalive\n\n"); }, 15_000);

  const onEvent = (event: Record<string, unknown>) => {
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  };

  eventBus.on("sse", onEvent);

  req.on("close", () => {
    clearInterval(keepAlive);
    eventBus.off("sse", onEvent);
  });
});

// ---------------------------------------------------------------------------
// Error handling middleware
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-unused-vars
app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
  console.error(`[${NODE_ID}] Unhandled error:`, err.message);
  res.status(500).json({ error: "Internal server error.", detail: err.message });
});

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

const server = app.listen(PORT, () => {
  console.log(`\n[${NODE_ID}] Vulcan node started`);
  console.log(`[${NODE_ID}]   Listening on      : http://localhost:${PORT}`);
  console.log(`[${NODE_ID}]   Cluster peers     : ${peers.map((p) => `${p.id}@${p.host}:${p.port}`).join(", ")}`);
  console.log(`[${NODE_ID}]   Cache capacity    : ${MAX_CAPACITY} keys`);
  console.log(`[${NODE_ID}]   Sweep interval    : ${SWEEP_INTERVAL_MS}ms`);
  console.log(`[${NODE_ID}]   Heartbeat         : every ${HEARTBEAT_INTERVAL_MS}ms, timeout ${PING_TIMEOUT_MS}ms, threshold ${FAILURE_THRESHOLD}`);
  console.log(`[${NODE_ID}]   Replication factor: ${REPLICATION_FACTOR}\n`);

  heartbeat.start();
});

// ---------------------------------------------------------------------------
// Graceful shutdown
// ---------------------------------------------------------------------------

function shutdown(signal: string): void {
  console.log(`\n[${NODE_ID}] Received ${signal} -- shutting down gracefully`);
  heartbeat.stop();
  cache.destroy();
  server.close(() => {
    console.log(`[${NODE_ID}] HTTP server closed.`);
    process.exit(0);
  });
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT",  () => shutdown("SIGINT"));