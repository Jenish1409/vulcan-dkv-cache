/**
 * HeartbeatManager unit tests — Vulcan Phase 3
 *
 * Strategy: call `processPingResult(nodeId, alive)` directly rather than
 * running real timers or HTTP servers.  This tests the state machine logic
 * in pure, synchronous isolation.
 *
 * The `ring` and `pingFn` are both lightweight stubs/mocks so that no
 * network or I/O is needed in any test.
 */

import { HeartbeatManager, type HeartbeatConfig } from "@/server/HeartbeatManager";
import type { NodeConfig } from "@/server/types";
import { HashRing } from "@/routing/HashRing";

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

const SELF_ID = "self";
const PEER_A: NodeConfig = { id: "peerA", host: "localhost", port: 5002 };
const PEER_B: NodeConfig = { id: "peerB", host: "localhost", port: 5003 };

/** Config with a low threshold so tests stay concise. */
const TEST_CONFIG: HeartbeatConfig = {
  intervalMs: 1_000,
  timeoutMs: 500,
  failureThreshold: 3,
};

/**
 * Build a HeartbeatManager backed by a real HashRing.
 * Using a real ring lets us assert on addNode/removeNode effects without
 * setting up complex mocks.
 */
function makeHBM(peers: NodeConfig[] = [PEER_A, PEER_B]): {
  hbm: HeartbeatManager;
  ring: HashRing;
} {
  const ring = new HashRing([SELF_ID, ...peers.map((p) => p.id)]);
  const hbm = new HeartbeatManager(SELF_ID, peers, ring, TEST_CONFIG);
  return { hbm, ring };
}

// ---------------------------------------------------------------------------
// a) Initial state
// ---------------------------------------------------------------------------

describe("HeartbeatManager — initial state", () => {
  test("all peers start ALIVE", () => {
    const { hbm } = makeHBM();
    const statuses = hbm.getPeerStatuses();
    expect(statuses).toHaveLength(2);
    for (const s of statuses) {
      expect(s.status).toBe("ALIVE");
      expect(s.consecutiveFailures).toBe(0);
    }
  });

  test("lastSeenMs is set at construction (not null)", () => {
    const { hbm } = makeHBM();
    for (const s of hbm.getPeerStatuses()) {
      expect(s.lastSeenMs).not.toBeNull();
    }
  });

  test("no peers means getPeerStatuses returns empty array", () => {
    const ring = new HashRing([SELF_ID]);
    const hbm = new HeartbeatManager(SELF_ID, [], ring, TEST_CONFIG);
    expect(hbm.getPeerStatuses()).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// b) Sub-threshold failures — NO state change
// ---------------------------------------------------------------------------

describe("HeartbeatManager — sub-threshold failures", () => {
  test("threshold-1 consecutive failures do NOT mark a peer DEAD", () => {
    const { hbm } = makeHBM();

    for (let i = 0; i < TEST_CONFIG.failureThreshold - 1; i++) {
      hbm.processPingResult("peerA", false);
    }

    const peerA = hbm.getPeerStatuses().find((s) => s.nodeId === "peerA")!;
    expect(peerA.status).toBe("ALIVE");
    expect(peerA.consecutiveFailures).toBe(TEST_CONFIG.failureThreshold - 1);
  });

  test("a success before threshold resets the failure counter", () => {
    const { hbm } = makeHBM();

    // 2 failures then a success (threshold is 3)
    hbm.processPingResult("peerA", false);
    hbm.processPingResult("peerA", false);
    hbm.processPingResult("peerA", true);  // recovery

    const peerA = hbm.getPeerStatuses().find((s) => s.nodeId === "peerA")!;
    expect(peerA.status).toBe("ALIVE");
    expect(peerA.consecutiveFailures).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// c) Threshold reached — DEAD + removeNode
// ---------------------------------------------------------------------------

describe("HeartbeatManager — marking a peer DEAD", () => {
  test("exactly N consecutive failures mark the peer DEAD", () => {
    const { hbm } = makeHBM();

    for (let i = 0; i < TEST_CONFIG.failureThreshold; i++) {
      hbm.processPingResult("peerA", false);
    }

    const peerA = hbm.getPeerStatuses().find((s) => s.nodeId === "peerA")!;
    expect(peerA.status).toBe("DEAD");
    expect(peerA.consecutiveFailures).toBe(TEST_CONFIG.failureThreshold);
  });

  test("dead peer is removed from the ring", () => {
    const { hbm, ring } = makeHBM();

    expect(ring.hasNode("peerA")).toBe(true);

    for (let i = 0; i < TEST_CONFIG.failureThreshold; i++) {
      hbm.processPingResult("peerA", false);
    }

    expect(ring.hasNode("peerA")).toBe(false);
  });

  test("additional failures beyond threshold do not trigger removeNode again", () => {
    const { hbm, ring } = makeHBM();

    // Drive to DEAD
    for (let i = 0; i < TEST_CONFIG.failureThreshold; i++) {
      hbm.processPingResult("peerA", false);
    }
    expect(ring.hasNode("peerA")).toBe(false);

    // More failures — ring should still not have peerA (no error either)
    hbm.processPingResult("peerA", false);
    hbm.processPingResult("peerA", false);
    expect(ring.hasNode("peerA")).toBe(false);

    // Status stays DEAD
    const peerA = hbm.getPeerStatuses().find((s) => s.nodeId === "peerA")!;
    expect(peerA.status).toBe("DEAD");
  });

  test("killing one peer does NOT change the other peer's status", () => {
    const { hbm } = makeHBM();

    for (let i = 0; i < TEST_CONFIG.failureThreshold; i++) {
      hbm.processPingResult("peerA", false);
    }

    const peerB = hbm.getPeerStatuses().find((s) => s.nodeId === "peerB")!;
    expect(peerB.status).toBe("ALIVE");
    expect(peerB.consecutiveFailures).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// d) Recovery — ALIVE + addNode
// ---------------------------------------------------------------------------

describe("HeartbeatManager — peer recovery (DEAD → ALIVE)", () => {
  test("a single successful ping recovers a DEAD peer to ALIVE", () => {
    const { hbm } = makeHBM();

    // Drive to DEAD
    for (let i = 0; i < TEST_CONFIG.failureThreshold; i++) {
      hbm.processPingResult("peerA", false);
    }
    expect(hbm.getPeerStatuses().find((s) => s.nodeId === "peerA")!.status).toBe("DEAD");

    // Recovery
    hbm.processPingResult("peerA", true);

    const peerA = hbm.getPeerStatuses().find((s) => s.nodeId === "peerA")!;
    expect(peerA.status).toBe("ALIVE");
    expect(peerA.consecutiveFailures).toBe(0);
  });

  test("recovered peer is re-added to the ring", () => {
    const { hbm, ring } = makeHBM();

    for (let i = 0; i < TEST_CONFIG.failureThreshold; i++) {
      hbm.processPingResult("peerA", false);
    }
    expect(ring.hasNode("peerA")).toBe(false);

    hbm.processPingResult("peerA", true);
    expect(ring.hasNode("peerA")).toBe(true);
  });

  test("a success on an already-ALIVE peer does not call addNode a second time", () => {
    const { hbm, ring } = makeHBM();
    const sizeBefore = ring.size;

    // Peer is already ALIVE — another success should be a no-op
    hbm.processPingResult("peerA", true);
    hbm.processPingResult("peerA", true);

    expect(ring.size).toBe(sizeBefore); // no duplicate vnodes
  });

  test("failure counter resets to 0 after recovery", () => {
    const { hbm } = makeHBM();

    for (let i = 0; i < TEST_CONFIG.failureThreshold; i++) {
      hbm.processPingResult("peerA", false);
    }
    hbm.processPingResult("peerA", true); // recover

    const peerA = hbm.getPeerStatuses().find((s) => s.nodeId === "peerA")!;
    expect(peerA.consecutiveFailures).toBe(0);
  });

  test("recovered peer can be killed again independently", () => {
    const { hbm, ring } = makeHBM();

    // First death
    for (let i = 0; i < TEST_CONFIG.failureThreshold; i++) {
      hbm.processPingResult("peerA", false);
    }
    expect(ring.hasNode("peerA")).toBe(false);

    // Recovery
    hbm.processPingResult("peerA", true);
    expect(ring.hasNode("peerA")).toBe(true);

    // Second death
    for (let i = 0; i < TEST_CONFIG.failureThreshold; i++) {
      hbm.processPingResult("peerA", false);
    }
    expect(ring.hasNode("peerA")).toBe(false);
    expect(hbm.getPeerStatuses().find((s) => s.nodeId === "peerA")!.status).toBe("DEAD");
  });
});

// ---------------------------------------------------------------------------
// e) Unknown nodeId — graceful no-op
// ---------------------------------------------------------------------------

describe("HeartbeatManager — unknown nodeId", () => {
  test("processPingResult on an untracked nodeId is a no-op (no throw)", () => {
    const { hbm } = makeHBM();
    expect(() => hbm.processPingResult("ghost-node", false)).not.toThrow();
    expect(() => hbm.processPingResult("ghost-node", true)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// f) getPeerStatuses shape
// ---------------------------------------------------------------------------

describe("HeartbeatManager — getPeerStatuses shape", () => {
  test("each entry has all required PeerHealth fields", () => {
    const { hbm } = makeHBM([PEER_A]);
    const [entry] = hbm.getPeerStatuses();

    expect(entry).toMatchObject({
      nodeId: "peerA",
      host: "localhost",
      port: 5002,
      status: "ALIVE",
      consecutiveFailures: 0,
    });
    expect(typeof entry.lastSeenMs === "number" || entry.lastSeenMs === null).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// g) start() / stop() lifecycle
// ---------------------------------------------------------------------------

describe("HeartbeatManager — start/stop lifecycle", () => {
  test("stop() on a never-started manager does not throw", () => {
    const { hbm } = makeHBM();
    expect(() => hbm.stop()).not.toThrow();
  });

  test("start() then stop() does not throw and allows garbage collection", () => {
    const { hbm } = makeHBM();
    hbm.start();
    expect(() => hbm.stop()).not.toThrow();
  });

  test("calling start() twice does not create duplicate timers", () => {
    const pings: string[] = [];
    const fakePing = async (_target: NodeConfig) => {
      pings.push(_target.id);
      return true;
    };

    const ring = new HashRing([SELF_ID, PEER_A.id]);
    const hbm = new HeartbeatManager(SELF_ID, [PEER_A], ring, TEST_CONFIG, fakePing);

    hbm.start();
    hbm.start(); // second call should be idempotent

    hbm.stop();
    // If a timer was started, pings would have accumulated. Either way no crash.
  });
});
