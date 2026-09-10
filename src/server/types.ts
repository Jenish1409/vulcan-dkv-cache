/**
 * Shared TypeScript interfaces for Vulcan Phase 2 + 3 + 4 server layer.
 *
 * Kept in a dedicated file so `node.ts`, `router.ts`, `HeartbeatManager.ts`,
 * and any future modules can import without circular dependencies.
 */

// ---------------------------------------------------------------------------
// Cluster configuration
// ---------------------------------------------------------------------------

/**
 * Identity and network address of a single Vulcan node.
 * Read from the `PEERS` environment variable at startup.
 */
export interface NodeConfig {
  /** Logical node identifier, e.g. "node1". */
  id: string;
  /** Hostname or IP address, e.g. "localhost". */
  host: string;
  /** TCP port the node's HTTP server is listening on. */
  port: number;
}

// ---------------------------------------------------------------------------
// HTTP request / response shapes
// ---------------------------------------------------------------------------

/**
 * Request body for `PUT /kv/:key`.
 */
export interface KVSetBody {
  /** The value to store.  Any JSON-serialisable type is accepted. */
  value: unknown;
  /**
   * Optional time-to-live in seconds.
   * Omit to store the key indefinitely.
   */
  ttlSeconds?: number;
}

/**
 * Response body for a successful `GET /kv/:key`.
 */
export interface KVGetResponse {
  key: string;
  value: unknown;
  /**
   * ID of the node that actually held (and returned) the value.
   * Will differ from the node the client hit when a forward occurred.
   */
  handledBy: string;
}

/**
 * Response body for `PUT /kv/:key` and `DELETE /kv/:key`.
 */
export interface KVMutateResponse {
  ok: boolean;
  /** ID of the node that executed the mutation. */
  handledBy: string;
}

// ---------------------------------------------------------------------------
// Phase 3 — Cluster health view
// ---------------------------------------------------------------------------

/**
 * This node's current belief about one peer's liveness.
 *
 * Populated by HeartbeatManager and included in the /health response so
 * cluster state is observable via HTTP without reading log files.
 */
export interface PeerHealth {
  nodeId: string;
  host: string;
  port: number;
  /** Current liveness state as seen by THIS node. */
  status: "ALIVE" | "DEAD";
  /**
   * Unix-ms timestamp of the last successful health-check response.
   * null means the node has not been seen since this process started.
   */
  lastSeenMs: number | null;
  /** Number of consecutive failed health checks (resets to 0 on any success). */
  consecutiveFailures: number;
}

/**
 * Response body for `GET /health`.
 *
 * Designed to be **easily extended** in later phases:
 * - Phase 4+: add `replicationLag`, `ringPosition`, `vnodeCount`
 *
 * The `status` field is intentionally a union so future states like
 * `"degraded"` or `"recovering"` can be added without a breaking change.
 */
export interface HealthResponse {
  nodeId: string;
  port: number;
  /** Seconds since this process started. */
  uptime: number;
  /** Current number of live keys in this node's local cache. */
  keyCount: number;
  /** Logical cluster peers this node knows about (human-readable strings). */
  peers: string[];
  /**
   * This node's current view of every peer's liveness status.
   * Self is always included with status "ALIVE".
   * Added in Phase 3.
   */
  clusterView: PeerHealth[];
  /**
   * "ok" = fully operational.
   * Future phases may add "degraded" | "recovering" | "unreachable".
   */
  status: "ok";
}

// ---------------------------------------------------------------------------
// Phase 4 — Replication types
// ---------------------------------------------------------------------------

/**
 * One entry in the ordered replica list for a key.
 * `role` is "primary" for the first node, "replica" for all others.
 * `status` reflects this node's current heartbeat view of the peer's liveness.
 */
export interface ReplicaInfo {
  nodeId: string;
  role: "primary" | "replica";
  /** Current liveness as seen by the node handling the request. */
  status: "ALIVE" | "DEAD";
}

/**
 * Response body for `GET /ring/replicas/:key`.
 *
 * Returns the full ordered replica list for a key with liveness status,
 * so clients and scripts can determine primary + fallback nodes.
 */
export interface ReplicaOwnerResponse {
  key: string;
  replicationFactor: number;
  replicas: ReplicaInfo[];
}

/** One entry in a cache dump (key + raw value). */
export interface DumpEntry {
  key: string;
  value: unknown;
}

/**
 * Response body for `GET /internal/dump`.
 * Used by rejoining nodes to pull data from peers for re-sync.
 */
export interface DumpResponse {
  nodeId: string;
  entryCount: number;
  entries: DumpEntry[];
}

