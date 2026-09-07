/**
 * node.ts — Vulcan Phase 2: Per-node HTTP server.
 *
 * Each instance of this process is ONE node in the Vulcan cluster.
 * It owns:
 *   1. A local LRUCache (from Phase 1) — stores the keys it is
 *      responsible for according to the consistent hash ring.
 *   2. A HashRing — used by EVERY node to deterministically route any
 *      key to its correct owner, with no central coordinator.
 *   3. An Express HTTP server — handles client requests and forwards
 *      to peer nodes when the current node isn't the owner.
 *
 * ─── Architecture note ───────────────────────────────────────────────
 * This uses the "every node is a router" pattern rather than a
 * dedicated coordinator.  Trade-off: each non-owner request costs one
 * extra hop (client→any-node→owner-node), but there is no single point
 * of failure.  Replication in Phase 3 will make any node able to serve
 * reads directly, eliminating even that extra hop.
 *
 * ─── Startup ─────────────────────────────────────────────────────────
 * Required environment variables:
 *   NODE_ID   — logical ID for this node, e.g. "node1"
 *   PORT      — TCP port to listen on, e.g. "5001"
 *   PEERS     — comma-separated list of ALL nodes (including self):
 *               "node1:localhost:5001,node2:localhost:5002,node3:localhost:5003"
 *
 * Optional:
 *   MAX_CAPACITY     — LRUCache max keys per node  (default: 10000)
 *   SWEEP_INTERVAL   — active-expiry sweep interval ms (default: 5000)
 *
 * Example (PowerShell):
 *   $env:NODE_ID="node1"; $env:PORT="5001"; $env:PEERS="node1:localhost:5001,node2:localhost:5002,node3:localhost:5003"; npm run start:node
 */

import express, { type Request, type Response, type NextFunction } from "express";
import { LRUCache } from "../store";
import { HashRing } from "../routing/HashRing";
import { forwardRequest } from "./router";
import type {
  NodeConfig,
  KVSetBody,
  KVGetResponse,
  KVMutateResponse,
  HealthResponse,
} from "./types";

/** Typed route params for `/kv/:key` routes. */
interface KVParams {
  key: string;
}

// ---------------------------------------------------------------------------
// Read configuration from environment
// ---------------------------------------------------------------------------

const NODE_ID = process.env["NODE_ID"] ?? "node1";
const PORT = parseInt(process.env["PORT"] ?? "5001", 10);
const MAX_CAPACITY = parseInt(process.env["MAX_CAPACITY"] ?? "10000", 10);
const SWEEP_INTERVAL_MS = parseInt(process.env["SWEEP_INTERVAL"] ?? "5000", 10);

/**
 * Parse PEERS env var into structured NodeConfig objects.
 *
 * Format: "nodeId:host:port[,nodeId:host:port,...]"
 * If PEERS is not set, defaults to only this node (single-node mode).
 *
 * Example:
 *   PEERS=node1:localhost:5001,node2:localhost:5002,node3:localhost:5003
 */
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
// Cluster setup
// ---------------------------------------------------------------------------

const peers = parsePeers();
const nodeMap = new Map<string, NodeConfig>(peers.map((p) => [p.id, p]));
const ring = new HashRing(peers.map((p) => p.id));

if (!nodeMap.has(NODE_ID)) {
  throw new Error(
    `NODE_ID "${NODE_ID}" is not listed in PEERS. Add it to the PEERS env var.`
  );
}

// ---------------------------------------------------------------------------
// Cache setup
// ---------------------------------------------------------------------------

const cache = new LRUCache<unknown>({
  maxCapacity: MAX_CAPACITY,
  sweepIntervalMs: SWEEP_INTERVAL_MS,
});

const startTime = Date.now();

// ---------------------------------------------------------------------------
// Express app
// ---------------------------------------------------------------------------

const app = express();
app.use(express.json());

// ---------------------------------------------------------------------------
// Routing helpers
// ---------------------------------------------------------------------------

/** Return the NodeConfig for the node that owns `key`. */
function ownerOf(key: string): NodeConfig {
  const ownerId = ring.getNodeForKey(key);
  const node = nodeMap.get(ownerId);
  if (node === undefined) {
    // This should never happen if PEERS is configured correctly, but
    // it's better to throw an informative error than silently return undefined.
    throw new Error(`Ring returned unknown node ID "${ownerId}" for key "${key}".`);
  }
  return node;
}

/** True if this process is the owner of the given key. */
function isSelf(node: NodeConfig): boolean {
  return node.id === NODE_ID;
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

/**
 * GET /health
 *
 * Returns lightweight status information about this node.
 * Designed to be extended in Phase 3 for heartbeat / health-check logic —
 * just add fields to the HealthResponse interface in types.ts.
 */
app.get("/health", (_req: Request, res: Response) => {
  const body: HealthResponse = {
    nodeId: NODE_ID,
    port: PORT,
    uptime: Math.floor((Date.now() - startTime) / 1000),
    keyCount: cache.size,
    peers: peers.map((p) => `${p.id}@${p.host}:${p.port}`),
    status: "ok",
  };
  res.json(body);
});

/**
 * PUT /kv/:key
 *
 * Body: { value: unknown, ttlSeconds?: number }
 *
 * Stores value under key.  If this node is not the key's owner,
 * forwards the request to the owner and relays its response.
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

      cache.set(key, body.value, body.ttlSeconds);

      const response: KVMutateResponse = { ok: true, handledBy: NODE_ID };
      res.status(200).json(response);
    } else {
      const { status, data } = await forwardRequest(owner, "PUT", `/kv/${encodeURIComponent(key)}`, req.body);
      res.status(status).json(data);
    }
  } catch (err) {
    next(err);
  }
});

/**
 * GET /kv/:key
 *
 * Returns the value stored under key, or 404 if absent / expired.
 * The `handledBy` field in the response reveals which node actually
 * served the data — useful for verifying cross-node routing.
 */
app.get("/kv/:key", async (req: Request<KVParams>, res: Response, next: NextFunction) => {
  try {
    const { key } = req.params;
    const owner = ownerOf(key);

    if (isSelf(owner)) {
      const value = cache.get(key);

      if (value === null) {
        res.status(404).json({ error: "Key not found or expired." });
      } else {
        const response: KVGetResponse = { key, value, handledBy: NODE_ID };
        res.json(response);
      }
    } else {
      const { status, data } = await forwardRequest(owner, "GET", `/kv/${encodeURIComponent(key)}`);
      res.status(status).json(data);
    }
  } catch (err) {
    next(err);
  }
});

/**
 * DELETE /kv/:key
 *
 * Deletes the key from its owner node.
 * Returns 200 if the key existed and was deleted, 404 if it was absent.
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
      const { status, data } = await forwardRequest(owner, "DELETE", `/kv/${encodeURIComponent(key)}`);
      res.status(status).json(data);
    }
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// Error handling middleware
// ---------------------------------------------------------------------------

// Must have four parameters for Express to recognise it as an error handler.
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
  console.log(`[${NODE_ID}]   Listening on  : http://localhost:${PORT}`);
  console.log(`[${NODE_ID}]   Cluster peers : ${peers.map((p) => `${p.id}@${p.host}:${p.port}`).join(", ")}`);
  console.log(`[${NODE_ID}]   Cache capacity: ${MAX_CAPACITY} keys`);
  console.log(`[${NODE_ID}]   Sweep interval: ${SWEEP_INTERVAL_MS}ms\n`);
});

// ---------------------------------------------------------------------------
// Graceful shutdown
// ---------------------------------------------------------------------------

function shutdown(signal: string): void {
  console.log(`\n[${NODE_ID}] Received ${signal} — shutting down gracefully…`);
  cache.destroy(); // stop the TTL sweep timer
  server.close(() => {
    console.log(`[${NODE_ID}] HTTP server closed.`);
    process.exit(0);
  });
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
