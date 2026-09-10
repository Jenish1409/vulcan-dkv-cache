/**
 * HashRing unit tests — Vulcan Phase 2 + 4
 *
 * Covers:
 *   a) Basic add / get / remove operations
 *   b) Determinism — same inputs always produce the same ring
 *   c) Distribution — adding a node remaps roughly 1/5 of keys (15–30%)
 *   d) Minimal disruption — remapped keys go ONLY to the new node,
 *      never reshuffled between existing nodes
 *   e) Remove node — affected keys redistribute, no key maps to removed node
 *   f) getReplicaNodes — Phase 4 replica placement (primary + replicas,
 *      distinct physical nodes, RF > cluster size capping, edge cases)
 */

import { HashRing } from "@/routing/HashRing";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Generate an array of N sequential test keys. */
function generateKeys(n: number): string[] {
  return Array.from({ length: n }, (_, i) => `test-key-${i}`);
}

/** Snapshot which node owns each key in a given key list. */
function snapshot(ring: HashRing, keys: string[]): Map<string, string> {
  return new Map(keys.map((k) => [k, ring.getNodeForKey(k)]));
}

// ---------------------------------------------------------------------------
// a) Basic operations
// ---------------------------------------------------------------------------

describe("HashRing — basic operations", () => {
  test("throws on getNodeForKey when ring is empty", () => {
    const ring = new HashRing();
    expect(() => ring.getNodeForKey("anything")).toThrow();
  });

  test("single node owns all keys", () => {
    const ring = new HashRing(["alpha"]);
    expect(ring.getNodeForKey("foo")).toBe("alpha");
    expect(ring.getNodeForKey("bar")).toBe("alpha");
    expect(ring.getNodeForKey("baz")).toBe("alpha");
  });

  test("addNode reports the node as present", () => {
    const ring = new HashRing();
    expect(ring.hasNode("n1")).toBe(false);
    ring.addNode("n1");
    expect(ring.hasNode("n1")).toBe(true);
  });

  test("addNode is idempotent — adding same node twice is safe", () => {
    const ring = new HashRing(["n1"]);
    const sizeBefore = ring.size;
    ring.addNode("n1"); // duplicate
    expect(ring.size).toBe(sizeBefore);
    expect(ring.getNodes()).toHaveLength(1);
  });

  test("removeNode removes the node and it is no longer returned by getNodes", () => {
    const ring = new HashRing(["n1", "n2"]);
    ring.removeNode("n1");
    expect(ring.hasNode("n1")).toBe(false);
    expect(ring.getNodes()).toEqual(["n2"]);
  });

  test("removeNode is idempotent — removing absent node is safe", () => {
    const ring = new HashRing(["n1"]);
    expect(() => ring.removeNode("ghost")).not.toThrow();
    expect(ring.getNodes()).toEqual(["n1"]);
  });

  test("after removing all nodes, getNodeForKey throws", () => {
    const ring = new HashRing(["only"]);
    ring.removeNode("only");
    expect(() => ring.getNodeForKey("key")).toThrow();
  });

  test("getNodes returns all added nodes", () => {
    const ring = new HashRing(["a", "b", "c"]);
    expect(ring.getNodes().sort()).toEqual(["a", "b", "c"]);
  });

  test("size equals VIRTUAL_NODES * number of physical nodes", () => {
    // 150 virtual nodes per physical node (internal constant)
    const VIRTUAL_NODES = 150;
    const ring = new HashRing(["n1", "n2", "n3"]);
    expect(ring.size).toBe(VIRTUAL_NODES * 3);
  });
});

// ---------------------------------------------------------------------------
// b) Determinism
// ---------------------------------------------------------------------------

describe("HashRing — determinism", () => {
  test("same inputs always produce the same key→node mapping", () => {
    const nodes = ["nodeA", "nodeB", "nodeC", "nodeD"];
    const keys = generateKeys(1_000);

    const ring1 = new HashRing(nodes);
    const ring2 = new HashRing(nodes);

    for (const k of keys) {
      expect(ring1.getNodeForKey(k)).toBe(ring2.getNodeForKey(k));
    }
  });

  test("insertion order of nodes does not affect the key→node mapping", () => {
    const keys = generateKeys(1_000);

    const ringABC = new HashRing(["alpha", "beta", "gamma"]);
    const ringCBA = new HashRing(["gamma", "beta", "alpha"]);

    for (const k of keys) {
      expect(ringABC.getNodeForKey(k)).toBe(ringCBA.getNodeForKey(k));
    }
  });
});

// ---------------------------------------------------------------------------
// c) Distribution — remap fraction test
// ---------------------------------------------------------------------------

describe("HashRing — distribution (consistent hashing core property)", () => {
  const SAMPLE = 10_000;
  const keys = generateKeys(SAMPLE);

  test(
    `adding a 5th node to a 4-node ring remaps ~20% of ${SAMPLE.toLocaleString()} keys (tolerance: 12–30%)`,
    () => {
      const ring = new HashRing(["node1", "node2", "node3", "node4"]);

      // Snapshot key ownership BEFORE adding the new node.
      const before = snapshot(ring, keys);

      ring.addNode("node5");

      // Count how many keys now map to a different node.
      let remapped = 0;
      for (const k of keys) {
        if (ring.getNodeForKey(k) !== before.get(k)) remapped++;
      }

      const fraction = remapped / SAMPLE;
      const pct = (fraction * 100).toFixed(1);

      // Log the actual number so it shows in the test output.
      console.log(
        `  → Remapped ${remapped.toLocaleString()}/${SAMPLE.toLocaleString()} keys (${pct}%) ` +
          `when adding node5 to a 4-node ring`
      );

      // Consistent hashing guarantees only the new node's "slice" moves.
      // With 5 equal-weight nodes the ideal is 20%.  With 150 virtual
      // nodes per node we expect the empirical fraction to be within
      // ±8 percentage points of the ideal.
      expect(fraction).toBeGreaterThan(0.12); // at least 12%
      expect(fraction).toBeLessThan(0.30);    // at most 30%
    }
  );

  test("key distribution across 4 nodes is reasonably even (no node owns more than 40%)", () => {
    const ring = new HashRing(["node1", "node2", "node3", "node4"]);
    const counts: Record<string, number> = {
      node1: 0, node2: 0, node3: 0, node4: 0,
    };

    for (const k of keys) {
      counts[ring.getNodeForKey(k)]++;
    }

    for (const [node, count] of Object.entries(counts)) {
      const fraction = count / SAMPLE;
      console.log(`  → ${node}: ${count.toLocaleString()} keys (${(fraction * 100).toFixed(1)}%)`);
      // Each node should own between 10% and 40% of keys.
      expect(fraction).toBeGreaterThan(0.10);
      expect(fraction).toBeLessThan(0.40);
    }
  });
});

// ---------------------------------------------------------------------------
// d) Minimal disruption — the KEY property of consistent hashing
// ---------------------------------------------------------------------------

describe("HashRing — minimal disruption (consistent hashing guarantee)", () => {
  const SAMPLE = 10_000;
  const keys = generateKeys(SAMPLE);

  test(
    "when a node is added, remapped keys go ONLY to the new node — never reshuffled between existing nodes",
    () => {
      const ring = new HashRing(["node1", "node2", "node3", "node4"]);
      const before = snapshot(ring, keys);

      ring.addNode("node5");

      for (const k of keys) {
        const oldOwner = before.get(k)!;
        const newOwner = ring.getNodeForKey(k);

        if (newOwner !== oldOwner) {
          // Any key that moved MUST now belong to the new node.
          // If it moved to a different EXISTING node, consistent hashing
          // is broken — that would be a catastrophic regression.
          expect(newOwner).toBe("node5");
        }
      }
    }
  );
});

// ---------------------------------------------------------------------------
// e) Remove node — redistribution
// ---------------------------------------------------------------------------

describe("HashRing — removeNode redistribution", () => {
  const SAMPLE = 10_000;
  const keys = generateKeys(SAMPLE);

  test("after removal, no key maps to the removed node", () => {
    const ring = new HashRing(["n1", "n2", "n3", "n4"]);
    ring.removeNode("n2");

    for (const k of keys) {
      expect(ring.getNodeForKey(k)).not.toBe("n2");
    }
  });

  test("keys not previously owned by removed node keep their owner", () => {
    const ring = new HashRing(["n1", "n2", "n3", "n4"]);
    const before = snapshot(ring, keys);

    ring.removeNode("n2");

    for (const k of keys) {
      const oldOwner = before.get(k)!;
      const newOwner = ring.getNodeForKey(k);

      if (oldOwner !== "n2") {
        // A key that did NOT belong to n2 should NOT have moved.
        expect(newOwner).toBe(oldOwner);
      }
    }
  });

  test("keys previously on removed node are redistributed to remaining nodes only", () => {
    const ring = new HashRing(["n1", "n2", "n3", "n4"]);
    const before = snapshot(ring, keys);

    ring.removeNode("n2");
    const remaining = new Set(["n1", "n3", "n4"]);

    for (const k of keys) {
      if (before.get(k) === "n2") {
        // Keys from the removed node must land on a remaining node.
        expect(remaining.has(ring.getNodeForKey(k))).toBe(true);
      }
    }
  });
});

// ===========================================================================
// f) getReplicaNodes — Phase 4 replica placement
// ===========================================================================

describe("HashRing.getReplicaNodes", () => {
  const NODES_3 = ["node1", "node2", "node3"];
  const KEY = "test-key";

  // ---- Basic correctness --------------------------------------------------

  test("RF=1 returns exactly the primary (same as getNodeForKey)", () => {
    const ring = new HashRing(NODES_3);
    const primary = ring.getNodeForKey(KEY);
    const replicas = ring.getReplicaNodes(KEY, 1);
    expect(replicas).toHaveLength(1);
    expect(replicas[0]).toBe(primary);
  });

  test("RF=2 returns primary + 1 distinct replica", () => {
    const ring = new HashRing(NODES_3);
    const replicas = ring.getReplicaNodes(KEY, 2);
    expect(replicas).toHaveLength(2);
    expect(new Set(replicas).size).toBe(2); // all distinct
  });

  test("RF=3 on a 3-node cluster returns all 3 distinct nodes", () => {
    const ring = new HashRing(NODES_3);
    const replicas = ring.getReplicaNodes(KEY, 3);
    expect(replicas).toHaveLength(3);
    expect(new Set(replicas).size).toBe(3);
    // All configured nodes must appear
    for (const n of NODES_3) {
      expect(replicas).toContain(n);
    }
  });

  test("primary is always index 0 and matches getNodeForKey", () => {
    const ring = new HashRing(NODES_3);
    const primary = ring.getNodeForKey(KEY);
    const replicas = ring.getReplicaNodes(KEY, 2);
    expect(replicas[0]).toBe(primary);
  });

  test("result contains no duplicate physical nodes", () => {
    const ring = new HashRing(NODES_3);
    for (const rf of [1, 2, 3]) {
      const replicas = ring.getReplicaNodes(KEY, rf);
      expect(new Set(replicas).size).toBe(replicas.length);
    }
  });

  // ---- Edge case: RF > cluster size ----------------------------------------

  test("RF > cluster size is gracefully capped (no crash, no duplicates)", () => {
    const ring = new HashRing(NODES_3); // 3 nodes
    const replicas = ring.getReplicaNodes(KEY, 10); // RF=10 > 3
    expect(replicas.length).toBe(3); // capped at 3
    expect(new Set(replicas).size).toBe(3); // still distinct
  });

  test("single-node cluster with RF=5 returns just that one node", () => {
    const ring = new HashRing(["solo"]);
    const replicas = ring.getReplicaNodes(KEY, 5);
    expect(replicas).toHaveLength(1);
    expect(replicas[0]).toBe("solo");
  });

  // ---- Empty ring ----------------------------------------------------------

  test("throws if the ring is empty", () => {
    const ring = new HashRing();
    expect(() => ring.getReplicaNodes(KEY, 2)).toThrow("HashRing is empty");
  });

  // ---- Determinism ---------------------------------------------------------

  test("same key always returns the same ordered replica list", () => {
    const ring = new HashRing(NODES_3);
    const first  = ring.getReplicaNodes(KEY, 3);
    const second = ring.getReplicaNodes(KEY, 3);
    expect(first).toEqual(second);
  });

  test("different keys can have different primaries", () => {
    const ring = new HashRing(NODES_3);
    const keys = Array.from({ length: 200 }, (_, i) => `key-${i}`);
    const primaries = new Set(keys.map((k) => ring.getReplicaNodes(k, 1)[0]));
    // With 3 nodes and 200 keys, all 3 should appear as primary for some key.
    expect(primaries.size).toBeGreaterThan(1);
  });

  // ---- Interaction with addNode / removeNode --------------------------------

  test("replica list updates correctly after removeNode", () => {
    const ring = new HashRing(NODES_3);
    const before = ring.getReplicaNodes(KEY, 3);
    expect(before).toHaveLength(3);

    ring.removeNode(before[0]); // remove the primary
    const after = ring.getReplicaNodes(KEY, 3);

    // Only 2 nodes left, so at most 2 replicas.
    expect(after.length).toBeLessThanOrEqual(2);
    // The removed node must NOT appear.
    expect(after).not.toContain(before[0]);
  });

  test("RF=2 list on 2-node cluster contains both nodes", () => {
    const ring = new HashRing(["a", "b"]);
    const replicas = ring.getReplicaNodes(KEY, 2);
    expect(replicas).toHaveLength(2);
    expect(replicas).toContain("a");
    expect(replicas).toContain("b");
  });

  test("all nodes appear as primary for at least one key (distribution)", () => {
    const ring = new HashRing(NODES_3);
    const keys = Array.from({ length: 500 }, (_, i) => `distrib-key-${i}`);
    const seenAsPrimary = new Set(keys.map((k) => ring.getReplicaNodes(k, 1)[0]));
    expect(seenAsPrimary.size).toBe(3);
  });
});
