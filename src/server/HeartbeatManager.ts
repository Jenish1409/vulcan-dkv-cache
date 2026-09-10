/**
 * HeartbeatManager — Vulcan Phase 3: Peer failure detection & ring recovery.
 *
 * ─── What it does ────────────────────────────────────────────────────────────
 * Each node runs one HeartbeatManager that periodically pings every known
 * peer via GET /health.  It tracks consecutive failures per peer and, once
 * a configured threshold is exceeded, marks that peer DEAD and removes it
 * from the local HashRing so requests stop routing there.  If the peer
 * recovers, it is marked ALIVE again and re-added to the ring.
 *
 * ─── Why these values? ───────────────────────────────────────────────────────
 *
 *   intervalMs = 2 000 ms
 *     Pings every 2 seconds.  Fast enough to detect failures in ~6 s;
 *     slow enough not to flood peers with health-check traffic.
 *
 *   timeoutMs = 1 500 ms
 *     Must be shorter than intervalMs so pings don't pile up when a node
 *     is slow.  500 ms slack per cycle absorbs most LAN jitter.
 *
 *   failureThreshold = 3
 *     3 × 2 s = 6 seconds before declaring DEAD.  This tolerates up to
 *     two transient packet losses / GC pauses before acting.  Production
 *     systems (Cassandra: ~10 s, etcd: 5–10 s) use similar reasoning.
 *
 * ─── "Local view" semantics ──────────────────────────────────────────────────
 * Each node runs its heartbeat loop independently.  There is NO distributed
 * consensus on cluster membership.  During the ~2 s convergence window
 * after a failure, two nodes may disagree about which peers are alive.
 * This is acceptable: the window is bounded (≤ 1 heartbeat interval), and
 * the worst case is a 502 that the client can retry.  Raft / Paxos is a
 * later-phase concern.
 *
 * ─── Testability ─────────────────────────────────────────────────────────────
 * The core state-machine method `processPingResult(nodeId, alive)` is PUBLIC
 * and SYNCHRONOUS — it takes a pre-computed boolean rather than making any
 * network calls itself.  Unit tests call it directly without spinning up HTTP
 * servers or fake timers.  The network layer (`pingFn`) is injected and can
 * be replaced with a stub in tests.
 */

import axios from "axios";
import type { NodeConfig, PeerHealth } from "./types";
import type { HashRing } from "../routing/HashRing";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export interface HeartbeatConfig {
  /** How often to ping all peers, in milliseconds. */
  intervalMs: number;
  /** Per-ping HTTP request timeout, in milliseconds. Must be < intervalMs. */
  timeoutMs: number;
  /** Number of CONSECUTIVE failures before a peer is declared DEAD. */
  failureThreshold: number;
}

export const DEFAULT_HEARTBEAT_CONFIG: HeartbeatConfig = {
  intervalMs: 2_000,
  timeoutMs: 1_500,
  failureThreshold: 3,
};

// ---------------------------------------------------------------------------
// Ping function type (injectable for testing)
// ---------------------------------------------------------------------------

/**
 * A function that attempts to health-check a peer node.
 * Returns true if the peer responded within the timeout, false otherwise.
 */
export type PingFn = (target: NodeConfig) => Promise<boolean>;

/** Production ping: calls GET /health on the target via axios. */
export function makeAxiosPingFn(timeoutMs: number): PingFn {
  return async (target: NodeConfig): Promise<boolean> => {
    try {
      await axios.get(`http://${target.host}:${target.port}/health`, {
        timeout: timeoutMs,
        // Never throw on non-2xx — a 500 still means the node is up.
        validateStatus: () => true,
      });
      return true;
    } catch {
      // ECONNREFUSED, ETIMEDOUT, etc. → node is unreachable.
      return false;
    }
  };
}

// ---------------------------------------------------------------------------
// Internal tracker (one per peer)
// ---------------------------------------------------------------------------

/** Mutable tracking record for one peer node. */
interface PeerTracker {
  config: NodeConfig;
  state: "ALIVE" | "DEAD";
  consecutiveFailures: number;
  /** Unix-ms of the last successful ping.  null = never seen since startup. */
  lastSeenMs: number | null;
}

// ---------------------------------------------------------------------------
// HeartbeatManager
// ---------------------------------------------------------------------------

export class HeartbeatManager {
  private readonly selfId: string;
  private readonly config: HeartbeatConfig;
  private readonly ring: HashRing;
  private readonly pingFn: PingFn;
  private readonly trackers: Map<string, PeerTracker>;
  private timer: ReturnType<typeof setInterval> | null = null;

  /**
   * @param selfId   The NODE_ID of the running process (never pings itself).
   * @param peers    NodeConfig for every OTHER node in the cluster.
   * @param ring     The shared HashRing that this node uses for key routing.
   *                 HeartbeatManager will call addNode/removeNode on it when
   *                 peer state changes.
   * @param config   Heartbeat timing and threshold configuration.
   * @param pingFn   Optional custom ping function (used by tests to avoid HTTP).
   */
  constructor(
    selfId: string,
    peers: NodeConfig[],
    ring: HashRing,
    config: HeartbeatConfig = DEFAULT_HEARTBEAT_CONFIG,
    pingFn?: PingFn,
    /**
     * Optional callback fired when a peer transitions DEAD → ALIVE.
     * Called AFTER the ring has been updated (addNode already ran).
     * Used by node.ts to trigger re-sync for the rejoining peer.
     */
    public readonly onRejoin?: (nodeId: string, config: NodeConfig) => void
  ) {
    this.selfId = selfId;
    this.ring = ring;
    this.config = config;
    this.pingFn = pingFn ?? makeAxiosPingFn(config.timeoutMs);

    // All peers start ALIVE — they were live at startup since we parsed
    // PEERS from the environment.  If a peer is already down, the first
    // few heartbeat rounds will drive it to DEAD state.
    this.trackers = new Map(
      peers.map((p) => [
        p.id,
        {
          config: p,
          state: "ALIVE",
          consecutiveFailures: 0,
          lastSeenMs: Date.now(),
        } satisfies PeerTracker,
      ])
    );
  }

  // ------------------------------------------------------------------
  // Public API
  // ------------------------------------------------------------------

  /** Start the background heartbeat interval. */
  start(): void {
    if (this.timer !== null) return; // already running
    this.timer = setInterval(() => {
      void this.tick();
    }, this.config.intervalMs);

    // Don't hold the Node.js event loop open just for heartbeats.
    if (typeof (this.timer as NodeJS.Timeout).unref === "function") {
      (this.timer as NodeJS.Timeout).unref();
    }
  }

  /** Stop the heartbeat interval. Call during graceful shutdown. */
  stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /**
   * Return the current liveness view of all tracked peers.
   * Used by GET /health to expose cluster state over HTTP.
   */
  getPeerStatuses(): PeerHealth[] {
    return [...this.trackers.values()].map((t) => ({
      nodeId: t.config.id,
      host: t.config.host,
      port: t.config.port,
      status: t.state,
      lastSeenMs: t.lastSeenMs,
      consecutiveFailures: t.consecutiveFailures,
    }));
  }

  // ------------------------------------------------------------------
  // Core state machine — PUBLIC so unit tests can drive it directly
  // ------------------------------------------------------------------

  /**
   * Process the result of a single ping attempt for a peer.
   *
   * This is the heart of the failure-detection logic.  It is intentionally
   * synchronous and network-free so that unit tests can call it directly
   * without spinning up HTTP servers or fake timers.
   *
   * State transitions:
   *   ALIVE →(consecutiveFailures >= threshold)→ DEAD   [ring.removeNode]
   *   DEAD  →(any successful ping)              → ALIVE  [ring.addNode]
   *   ALIVE →(failure before threshold)         → ALIVE  [no ring change]
   *   DEAD  →(another failure)                  → DEAD   [no ring change]
   *
   * @param nodeId The peer that was pinged.
   * @param alive  true if the ping succeeded, false if it failed/timed out.
   */
  processPingResult(nodeId: string, alive: boolean): void {
    const tracker = this.trackers.get(nodeId);
    if (tracker === undefined) return; // unknown peer — ignore

    if (alive) {
      tracker.lastSeenMs = Date.now();
      tracker.consecutiveFailures = 0;

      if (tracker.state === "DEAD") {
        tracker.state = "ALIVE";
        // Re-add to the ring so new requests start routing to this node again.
        this.ring.addNode(nodeId);
        console.log(
          `[${this.selfId}] ✅ PEER REJOINED: "${nodeId}" is back ALIVE — re-added to ring.`
        );
        // Notify node.ts so it can trigger data re-sync from surviving peers.
        this.onRejoin?.(nodeId, tracker.config);
      }
    } else {
      tracker.consecutiveFailures++;

      if (
        tracker.state === "ALIVE" &&
        tracker.consecutiveFailures >= this.config.failureThreshold
      ) {
        tracker.state = "DEAD";
        // Remove from the ring so the next clockwise node takes over its range.
        this.ring.removeNode(nodeId);
        console.log(
          `[${this.selfId}] ❌ PEER DEAD: "${nodeId}" failed ${tracker.consecutiveFailures} ` +
          `consecutive health checks — removed from ring.  Its key range now routes to the next node.`
        );
      } else if (tracker.state === "ALIVE") {
        // Not yet at threshold — log at debug level for visibility.
        console.log(
          `[${this.selfId}]    ⚠️  "${nodeId}" missed check #${tracker.consecutiveFailures} ` +
          `(threshold: ${this.config.failureThreshold})`
        );
      }
      // If already DEAD, keep counting but take no additional ring action.
    }
  }

  // ------------------------------------------------------------------
  // Private — background tick
  // ------------------------------------------------------------------

  /**
   * One heartbeat cycle: ping all peers in parallel, process results.
   * Promise.allSettled ensures one slow peer doesn't block others.
   */
  private async tick(): Promise<void> {
    const pings = [...this.trackers.entries()].map(async ([nodeId, tracker]) => {
      const alive = await this.pingFn(tracker.config);
      this.processPingResult(nodeId, alive);
    });

    await Promise.allSettled(pings);
  }
}
