/**
 * chaos/src/loader.ts
 *
 * Continuous load generator.
 *
 * Sends a realistic mix of SET (40%) and GET (60%) operations to the Vulcan
 * cluster at a configurable rate, distributing requests across all nodes to
 * exercise the cluster's routing logic (not just one entry point).
 *
 * Architecture: N_WORKERS async workers, each sleeping between requests so
 * that the aggregate rate ≈ config.ratePerSec. Under fault conditions,
 * requests slow down (failover, retries), which naturally reduces the
 * effective rate -- this is intentional, not a bug.
 *
 * Values: every SET writes a unique value "v-{seqNum}" so the checker can
 * trace exactly which SET produced the value a GET returns.
 */

import axios from 'axios';
import type { ChaosConfig, NodeConfig, OperationType } from './types';
import type { Recorder } from './recorder';

const N_WORKERS = 5;
const SET_RATIO  = 0.4; // 40% SETs, 60% GETs
const HTTP_TIMEOUT_MS = 4000;

/** Shared mutable state between the runner and the load generator. */
export class ActiveFaultTracker {
  private readonly active = new Set<string>();
  add(id: string)    { this.active.add(id); }
  remove(id: string) { this.active.delete(id); }
  snapshot(): string[] { return [...this.active]; }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, Math.max(0, ms)));
}

interface RequestResult {
  status: number;
  responseValue?: string;
  handledBy?: string;
  error?: string;
}

async function sendRequest(
  node: NodeConfig,
  type: OperationType,
  key: string,
  value?: string
): Promise<RequestResult> {
  const url = `http://${node.host}:${node.port}/kv/${encodeURIComponent(key)}`;
  try {
    if (type === 'SET') {
      const resp = await axios.put(url, { value }, { timeout: HTTP_TIMEOUT_MS });
      return {
        status:    resp.status,
        handledBy: (resp.data as Record<string, string>).handledBy,
      };
    } else {
      const resp = await axios.get(url, { timeout: HTTP_TIMEOUT_MS });
      const data = resp.data as Record<string, unknown>;
      return {
        status:        resp.status,
        responseValue: data.value !== undefined ? String(data.value) : undefined,
        handledBy:     data.handledBy as string | undefined,
      };
    }
  } catch (err: unknown) {
    if (axios.isAxiosError(err) && err.response) {
      return { status: err.response.status, error: err.message };
    }
    // Network error: ECONNREFUSED, timeout, etc. (expected during faults)
    return { status: 0, error: err instanceof Error ? err.message : String(err) };
  }
}

export class LoadGenerator {
  private running  = false;
  private seqNum   = 0;
  private readonly workerIntervalMs: number;

  constructor(
    private readonly config: ChaosConfig,
    private readonly recorder: Recorder,
    private readonly faultTracker: ActiveFaultTracker
  ) {
    // Each worker fires once every (N_WORKERS / ratePerSec) seconds
    this.workerIntervalMs = Math.round((N_WORKERS * 1000) / config.ratePerSec);
  }

  /** Start N_WORKERS concurrent async loops. Returns a Promise that resolves when all workers exit. */
  start(): Promise<void> {
    this.running = true;
    const workers = Array.from({ length: N_WORKERS }, (_, i) => this.workerLoop(i));
    return Promise.all(workers).then(() => undefined);
  }

  stop(): void {
    this.running = false;
  }

  get totalIssued(): number {
    return this.seqNum;
  }

  private async workerLoop(workerId: number): Promise<void> {
    // Stagger worker starts so they don't all fire simultaneously
    await sleep(workerId * Math.round(this.workerIntervalMs / N_WORKERS));

    while (this.running) {
      const iterStart = Date.now();

      const thisSeqNum  = ++this.seqNum;
      const isSet       = Math.random() < SET_RATIO;
      const keyIndex    = Math.floor(Math.random() * this.config.keyCount);
      const key         = `chaos-key-${keyIndex}`;
      const nodeIndex   = Math.floor(Math.random() * this.config.nodes.length);
      const node        = this.config.nodes[nodeIndex]!;
      const value       = isSet ? `v-${thisSeqNum}` : undefined;
      const startedAt   = Date.now();

      const result = await sendRequest(node, isSet ? 'SET' : 'GET', key, value);
      const completedAt = Date.now();

      this.recorder.write({
        kind: 'OP',
        entry: {
          seqNum:        thisSeqNum,
          type:          isSet ? 'SET' : 'GET',
          key,
          intendedValue: value,
          startedAt,
          completedAt,
          status:        result.status,
          responseValue: result.responseValue,
          handledBy:     result.handledBy,
          activeFaultIds: this.faultTracker.snapshot(),
          error:         result.error,
        },
      });

      // Sleep the remainder of the interval (negative sleeps are no-ops via sleep(max(0,...)))
      await sleep(this.workerIntervalMs - (Date.now() - iterStart));
    }
  }
}
