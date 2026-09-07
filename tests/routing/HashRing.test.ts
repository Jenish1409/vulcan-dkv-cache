/**
 * HashRing unit tests — Vulcan Phase 2
 *
 * Covers:
 *   a) Basic add / get / remove operations
 *   b) Determinism — same inputs always produce the same ring
 *   c) Distribution — adding a node remaps roughly 1/5 of keys (15–30%)
 *   d) Minimal disruption — remapped keys go ONLY to the new node,
 *      never reshuffled between existing nodes
 *   e) Remove node — affected keys redistribute, no key maps to removed node
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
