/**
 * chaos/src/injector.ts
 *
 * Fault injection: kills nodes, isolates them from the Docker network,
 * and sends malformed HTTP requests to test value-size validation.
 *
 * ── Network partition implementation ──────────────────────────────────────
 *
 * Method chosen: `docker network disconnect / docker network connect`
 *
 * This creates FULL NODE ISOLATION: the target container is temporarily
 * removed from the Docker bridge network (vulcan_default), cutting all
 * inter-container TCP connections. Other nodes detect this via heartbeat
 * failure and remove the isolated node from their live ring.
 *
 * Why this method (not iptables):
 *   • Works on Docker Desktop / Windows with no Dockerfile changes.
 *   • Fully reversible: `docker network connect` restores connectivity.
 *   • Does not require CAP_NET_ADMIN or installing iptables in the
 *     alpine container image.
 *
 * Known limitation: This is "full isolation" not a selective 2-node
 * partition. A true selective partition (node1↔node2 cut, node3 reachable
 * by both) would require iptables rules inside containers (needs iptables
 * in the image + CAP_NET_ADMIN in docker-compose.yml). The additional
 * complexity is not justified for the failure modes Vulcan implements --
 * full isolation is the harder test: the isolated node can't reach ANY
 * peer and is therefore removed from the live ring entirely.
 *
 * The host-side port mapping (localhost:5001 → container:5001) REMAINS
 * active during network isolation, so the load generator can still send
 * requests to the isolated node -- it just can't replicate or heartbeat.
 * ──────────────────────────────────────────────────────────────────────────
 */

import { execSync } from 'child_process';
import axios from 'axios';
import type { FaultRecord, NodeConfig } from './types';
import type { Recorder } from './recorder';
import type { ActiveFaultTracker } from './loader';

const DOCKER_NETWORK = 'vulcan_default';
const HTTP_TIMEOUT_MS = 5000;

/** Map from service name (node1, node2, node3) to Docker container name. */
const CONTAINER_NAME: Record<string, string> = {
  node1: 'vulcan-node1',
  node2: 'vulcan-node2',
  node3: 'vulcan-node3',
};

let faultCounter = 0;
function nextFaultId(): string {
  return `fault-${String(++faultCounter).padStart(3, '0')}`;
}

function runDocker(cmd: string, cwd: string): void {
  try {
    execSync(cmd, { cwd, stdio: 'pipe' });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`  [injector] docker command warning: ${msg}`);
  }
}

export class FaultInjector {
  constructor(
    private readonly recorder: Recorder,
    private readonly faultTracker: ActiveFaultTracker,
    private readonly projectRoot: string
  ) {}

  // ── Node kill / restart ──────────────────────────────────────────────────

  killNode(serviceId: string): string {
    const faultId = nextFaultId();
    const startedAt = Date.now();
    const description = `docker compose stop ${serviceId}`;

    console.log(`  [injector] KILL ${serviceId} (${faultId})`);
    this.faultTracker.add(faultId);
    runDocker(`docker compose stop ${serviceId}`, this.projectRoot);

    this.recorder.write({
      kind: 'FAULT',
      entry: {
        faultId,
        type: 'NODE_KILL',
        targetNodes: [serviceId],
        startedAt,
        description,
      },
    });

    return faultId;
  }

  restartNode(serviceId: string, killFaultId: string): void {
    const startedAt = Date.now();
    const description = `docker compose start ${serviceId}`;

    console.log(`  [injector] RESTART ${serviceId} (healing ${killFaultId})`);
    runDocker(`docker compose start ${serviceId}`, this.projectRoot);
    this.faultTracker.remove(killFaultId);

    this.recorder.write({
      kind: 'FAULT',
      entry: {
        faultId: killFaultId,
        type: 'NODE_RESTART',
        targetNodes: [serviceId],
        startedAt,
        endedAt: Date.now(),
        description,
      },
    });
  }

  // ── Network isolation / restore ──────────────────────────────────────────

  isolateNode(serviceId: string): string {
    const faultId   = nextFaultId();
    const container = CONTAINER_NAME[serviceId] ?? `vulcan-${serviceId}`;
    const startedAt = Date.now();
    const description = `docker network disconnect ${DOCKER_NETWORK} ${container}`;

    console.log(`  [injector] ISOLATE ${serviceId} (${faultId})`);
    this.faultTracker.add(faultId);
    runDocker(`docker network disconnect ${DOCKER_NETWORK} ${container}`, this.projectRoot);

    this.recorder.write({
      kind: 'FAULT',
      entry: {
        faultId,
        type: 'NET_ISOLATE',
        targetNodes: [serviceId],
        startedAt,
        description,
      },
    });

    return faultId;
  }

  restoreNode(serviceId: string, isolateFaultId: string): void {
    const container = CONTAINER_NAME[serviceId] ?? `vulcan-${serviceId}`;
    const startedAt = Date.now();
    const description = `docker network connect ${DOCKER_NETWORK} ${container}`;

    console.log(`  [injector] RESTORE ${serviceId} (healing ${isolateFaultId})`);
    runDocker(`docker network connect ${DOCKER_NETWORK} ${container}`, this.projectRoot);
    this.faultTracker.remove(isolateFaultId);

    this.recorder.write({
      kind: 'FAULT',
      entry: {
        faultId: isolateFaultId,
        type: 'NET_RESTORE',
        targetNodes: [serviceId],
        startedAt,
        endedAt: Date.now(),
        description,
      },
    });
  }

  // ── Malformed value injection (Phase 7 item 2b) ──────────────────────────

  /**
   * Sends a PUT with a value exceeding 1 MB to verify node.ts rejects it
   * with HTTP 400. Logs the attempt as both a FAULT record and an OP record
   * so the checker can verify the outcome.
   */
  async injectMalformedValue(
    node: NodeConfig,
    key: string,
    seqNum: number
  ): Promise<void> {
    const OVERSIZED_BYTES = 1024 * 1024 + 1; // 1 MB + 1 byte
    const oversizedValue  = 'X'.repeat(OVERSIZED_BYTES);
    const faultId         = nextFaultId();
    const startedAt       = Date.now();

    console.log(`  [injector] MALFORMED VALUE → ${node.id} key=${key} size=${OVERSIZED_BYTES}B`);

    // Log the fault intent
    this.recorder.write({
      kind: 'FAULT',
      entry: {
        faultId,
        type: 'MALFORMED_VALUE',
        targetNodes: [node.id],
        startedAt,
        description: `Oversized PUT (${OVERSIZED_BYTES} bytes) to ${node.id} /kv/${key} — expects 400`,
      },
    });

    // Make the actual HTTP request
    let status = 0;
    let errorMsg: string | undefined;
    try {
      await axios.put(
        `http://${node.host}:${node.port}/kv/${encodeURIComponent(key)}`,
        { value: oversizedValue },
        { timeout: HTTP_TIMEOUT_MS }
      );
      status = 200; // should NOT happen if validation works
    } catch (err: unknown) {
      if (axios.isAxiosError(err) && err.response) {
        status = err.response.status; // expected: 400
      } else {
        status   = 0;
        errorMsg = err instanceof Error ? err.message : String(err);
      }
    }

    const completedAt = Date.now();

    // Log as an OP so the checker can inspect the status
    this.recorder.write({
      kind: 'OP',
      entry: {
        seqNum,
        type:          'SET',
        key,
        intendedValue: `[MALFORMED:${OVERSIZED_BYTES}B]`,
        startedAt,
        completedAt,
        status,
        handledBy:     undefined,
        activeFaultIds: [faultId],
        error:         errorMsg,
      },
    });

    const resultLabel =
      status === 400 ? '✅ correctly rejected (400)' :
      status === 200 ? '❌ BUG: accepted oversized value (200)' :
                       `⚠️  network error (status=${status})`;
    console.log(`  [injector] MALFORMED result: ${resultLabel}`);
  }
}
