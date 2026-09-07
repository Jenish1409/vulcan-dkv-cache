/**
 * Shared TypeScript interfaces for Vulcan Phase 2 server layer.
 *
 * Kept in a dedicated file so `node.ts`, `router.ts`, and any future
 * modules (replication, health-check daemon) can import without circular
 * dependencies.
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

/**
 * Response body for `GET /health`.
 *
 * Designed to be **easily extended** in later phases:
 * - Phase 3: add `replicationLag`, `peerStatuses`
 * - Phase 4+: add `ringPosition`, `vnodeCount`
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
  /** Logical cluster peers this node knows about. */
  peers: string[];
  /**
   * "ok" = fully operational.
   * Future phases may add "degraded" | "recovering" | "unreachable".
   */
  status: "ok";
}
