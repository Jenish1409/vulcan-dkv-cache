/**
 * router.ts — Inter-node HTTP forwarding for Vulcan Phase 2.
 *
 * When a request arrives at a node that does NOT own the target key,
 * this module forwards the request to the correct owner node and relays
 * the response back to the original caller.
 *
 * The forwarding is transparent from the client's perspective — the
 * response body and status code are relayed unchanged.
 */

import axios from "axios";
import type { NodeConfig } from "./types";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ForwardResult {
  /** HTTP status code from the target node (or 502 on network failure). */
  status: number;
  /** Response body from the target node (or an error descriptor). */
  data: unknown;
}

// ---------------------------------------------------------------------------
// forwardRequest
// ---------------------------------------------------------------------------

/**
 * Forward an HTTP request to a peer node and return its response.
 *
 * Uses `axios` with `validateStatus: () => true` so non-2xx responses
 * are returned as-is rather than thrown as errors.  Network-level
 * failures (ECONNREFUSED, timeouts, etc.) are caught and returned as
 * a 502 Bad Gateway with a descriptive payload.
 *
 * @param target  The peer node to forward to.
 * @param method  HTTP verb to use.
 * @param path    Request path including leading slash, e.g. `/kv/foo`.
 * @param body    Optional request body (for PUT).
 */
export async function forwardRequest(
  target: NodeConfig,
  method: "GET" | "PUT" | "DELETE",
  path: string,
  body?: unknown
): Promise<ForwardResult> {
  const url = `http://${target.host}:${target.port}${path}`;

  try {
    const response = await axios({
      method,
      url,
      data: body,
      // Never throw on non-2xx — let the caller decide what to do with
      // the status code from the peer node.
      validateStatus: () => true,
      // Generous timeout — peer nodes on localhost should respond fast.
      // Phase 3 will tune this based on measured p99 latency.
      timeout: 5_000,
    });

    return { status: response.status, data: response.data };
  } catch (err: unknown) {
    // Network-level failure: the target node is unreachable, timed out,
    // or refused the connection.  Return a 502 so the client knows the
    // cluster is partially unavailable rather than getting a 500.
    //
    // Phase 3 (failover / replication) will handle this more gracefully
    // by retrying against a replica.
    const message =
      err instanceof Error ? err.message : "Unknown network error";

    return {
      status: 502,
      data: {
        error: "Failed to reach target node",
        targetNode: target.id,
        detail: message,
      },
    };
  }
}
