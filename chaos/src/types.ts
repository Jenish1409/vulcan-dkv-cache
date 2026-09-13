/**
 * chaos/src/types.ts
 *
 * Shared type definitions for the Vulcan chaos-testing harness.
 * These are intentionally kept independent of the main src/ types
 * so the chaos tool can run as a standalone project.
 */

// ---------------------------------------------------------------------------
// Cluster configuration
// ---------------------------------------------------------------------------

export interface NodeConfig {
  id: string;
  host: string;
  port: number;
}

// ---------------------------------------------------------------------------
// Operation records (the flight recorder)
// ---------------------------------------------------------------------------

export type OperationType = 'SET' | 'GET';

/**
 * One operation attempted by the load generator.
 * Written to the JSONL log immediately after the HTTP response is received
 * (or on network error). Nothing is buffered -- if the runner crashes,
 * the log up to the crash is still valid.
 */
export interface OperationRecord {
  /** Monotonically increasing, globally unique across the run. */
  seqNum: number;
  type: OperationType;
  key: string;
  /** SET only: the value we attempted to write. */
  intendedValue?: string;
  /** Wall-clock ms when the HTTP request was dispatched. */
  startedAt: number;
  /** Wall-clock ms when the HTTP response was received (or error thrown). */
  completedAt: number;
  /**
   * HTTP status code returned.
   * 0 means a network-level error (ECONNREFUSED, timeout, etc.)
   * which is expected and normal while a node is killed/isolated.
   */
  status: number;
  /** GET only: the "value" field from the 200 response body. */
  responseValue?: string;
  /** The "handledBy" field from the response body, when present. */
  handledBy?: string;
  /**
   * Snapshot of which fault IDs were active at the instant the
   * HTTP response was received. Used by the checker to classify
   * stale reads as "during active fault" vs "no active fault".
   */
  activeFaultIds: string[];
  /** Network error message when status === 0. */
  error?: string;
}

// ---------------------------------------------------------------------------
// Fault records (the fault injection log)
// ---------------------------------------------------------------------------

export type FaultType =
  | 'NODE_KILL'          // docker compose stop <service>
  | 'NODE_RESTART'       // docker compose start <service>
  | 'NET_ISOLATE'        // docker network disconnect
  | 'NET_RESTORE'        // docker network connect
  | 'MALFORMED_VALUE';   // oversized HTTP PUT (expects 400)

export interface FaultRecord {
  faultId: string;
  type: FaultType;
  targetNodes: string[];
  startedAt: number;
  endedAt?: number;
  description: string;
}

// ---------------------------------------------------------------------------
// Log entry (union of both record types)
// ---------------------------------------------------------------------------

export type LogEntry =
  | { kind: 'OP';    entry: OperationRecord }
  | { kind: 'FAULT'; entry: FaultRecord };

// ---------------------------------------------------------------------------
// Chaos run configuration
// ---------------------------------------------------------------------------

export interface ChaosConfig {
  nodes: NodeConfig[];
  /** Target requests per second across all workers. */
  ratePerSec: number;
  /** Key pool size: chaos-key-0 through chaos-key-{keyCount-1}. */
  keyCount: number;
  /** Path to the output JSONL log file. */
  logFile: string;
  /** Total experiment wall-clock duration in ms. */
  durationMs: number;
  /** Project root (where docker-compose.yml lives). */
  projectRoot: string;
}

// ---------------------------------------------------------------------------
// Checker output
// ---------------------------------------------------------------------------

/** A hard invariant violation: definitely a bug. */
export interface CheckerViolation {
  /** INVENTED_VALUE: returned a value never written to this key.
   *  FUTURE_READ:    returned a value from a SET not yet completed. */
  type: 'INVENTED_VALUE' | 'FUTURE_READ';
  seqNum: number;
  key: string;
  returnedValue: string;
  explanation: string;
  /** seqNums of the related SET operations (for cross-referencing the log). */
  relatedSeqNums: number[];
}

/** A stale read: informational only, never a violation. See checker.ts. */
export interface StaleReadObservation {
  seqNum: number;
  key: string;
  returnedValue: string;
  latestConfirmedValue: string;
  /** ms between the superseding SET completing and this GET starting. Negative = concurrent. */
  gapMs: number;
  activeFaults: string[];
}

/** Malformed-value scenario result (Phase 7 item 2b). */
export interface MalformedValueResult {
  seqNum: number;
  targetKey: string;
  bytesSent: number;
  httpStatus: number;
  /** 'CORRECTLY_REJECTED' means 400 was returned as expected. */
  result: 'CORRECTLY_REJECTED' | 'INCORRECTLY_ACCEPTED' | 'NETWORK_ERROR';
}

export interface CheckerReport {
  logFile: string;
  selfCheckPassed: boolean;
  totalOps: number;
  successfulSets: number;
  successfulGets: number;
  /** ops that returned 503 (expected during fault windows) or 0 (network error). */
  failedOps: number;
  faultsInjected: number;
  violations: CheckerViolation[];
  /** All stale reads, regardless of whether a fault was active. */
  staleReads: StaleReadObservation[];
  staleReadsDuringFaults: number;
  staleReadsNoFault: number;
  malformedValueResults: MalformedValueResult[];
  passed: boolean;
}
