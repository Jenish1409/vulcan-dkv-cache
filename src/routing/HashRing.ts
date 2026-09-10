/**
 * HashRing — Vulcan Phase 2 + 4: Consistent Hashing with replica placement.
 *
 * Why consistent hashing instead of naive `hash(key) % N`?
 * ──────────────────────────────────────────────────────────
 * With naive modulo hashing, adding or removing ONE node causes almost
 * ALL keys to remap to different nodes (because every key's N changes).
 * This is catastrophic for cache performance — cache hit rate drops to
 * near zero on any topology change.
 *
 * Consistent hashing places both nodes and keys on a fixed circular
 * ring (hash space 0…2³²-1).  Each key is owned by the first node
 * clockwise from it on the ring.  When a node is added, ONLY the keys
 * in its "slice" of the ring move — typically 1/(N+1) of total keys.
 * All other keys stay on the same node.
 *
 * Why virtual nodes?
 * ──────────────────
 * With only one point per physical node, random placement on the ring
 * can create very uneven slices (e.g. one node owns 60% of the ring).
 * Virtual nodes solve this: each physical node gets VIRTUAL_NODES
 * evenly-distributed proxy points on the ring.  The more virtual nodes,
 * the smoother the distribution.  150 vnodes per node is a common
 * production choice (Cassandra uses 256).
 */

import { createHash } from "crypto";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/** Number of virtual nodes (ring points) per physical node. */
const VIRTUAL_NODES = 150;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface VirtualNode {
  /** uint32 position on the ring (0 … 2³²-1). */
  hash: number;
  /** ID of the physical node this virtual node belongs to. */
  nodeId: string;
}

// ---------------------------------------------------------------------------
// HashRing
// ---------------------------------------------------------------------------

/**
 * A consistent-hashing ring backed by a sorted array of virtual nodes.
 *
 * **Complexity**
 * - `addNode` / `removeNode`: O(V log V) where V = total virtual nodes
 * - `getNodeForKey`:          O(log V) — binary search on sorted ring
 *
 * All hashing uses SHA-256 (via Node's built-in `crypto` module) truncated
 * to a uint32.  No custom hash function is rolled.
 */
export class HashRing {
  /** Sorted array of virtual node ring positions. */
  private ring: VirtualNode[] = [];

  /** Set of physical node IDs currently in the ring. */
  private readonly nodeSet: Set<string> = new Set();

  // ------------------------------------------------------------------
  // Constructor
  // ------------------------------------------------------------------

  /**
   * @param nodeIds  Optional list of node IDs to seed the ring with.
   */
  constructor(nodeIds: string[] = []) {
    for (const id of nodeIds) {
      this.addNode(id);
    }
  }

  // ------------------------------------------------------------------
  // Public API
  // ------------------------------------------------------------------

  /**
   * Add a physical node to the ring.
   *
   * Places VIRTUAL_NODES proxy points on the ring, each hashed as
   * `"nodeId#i"` for i in [0, VIRTUAL_NODES).  The array is re-sorted
   * after insertion so binary search stays valid.
   *
   * Idempotent — adding a node that is already in the ring is a no-op.
   */
  addNode(nodeId: string): void {
    if (this.nodeSet.has(nodeId)) return;
    this.nodeSet.add(nodeId);

    for (let i = 0; i < VIRTUAL_NODES; i++) {
      this.ring.push({
        hash: this.hashToUint32(`${nodeId}#${i}`),
        nodeId,
      });
    }

    // Keep the ring sorted by hash so binary search works correctly.
    this.ring.sort((a, b) => a.hash - b.hash);
  }

  /**
   * Remove a physical node from the ring.
   *
   * Purges all VIRTUAL_NODES virtual nodes for that physical node.
   * Keys that were owned by the removed node now fall through to the
   * next clockwise node — consistent hashing guarantees minimal disruption.
   *
   * Idempotent — removing a node that is not in the ring is a no-op.
   */
  removeNode(nodeId: string): void {
    if (!this.nodeSet.has(nodeId)) return;
    this.nodeSet.delete(nodeId);
    this.ring = this.ring.filter((vn) => vn.nodeId !== nodeId);
  }

  /**
   * Return the ID of the node that owns `key`.
   *
   * Hashes the key to a uint32, then binary-searches for the first virtual
   * node with a hash >= that value (successor clockwise on the ring).
   * If the key hash is larger than all virtual nodes, wraps around to
   * index 0 — completing the circle.
   *
   * @throws {Error} if the ring is empty (no nodes have been added).
   */
  getNodeForKey(key: string): string {
    if (this.ring.length === 0) {
      throw new Error("HashRing is empty — add at least one node first.");
    }

    const keyHash = this.hashToUint32(key);

    // Binary search for the first virtual node with hash >= keyHash.
    let lo = 0;
    let hi = this.ring.length;

    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (this.ring[mid].hash < keyHash) {
        lo = mid + 1;
      } else {
        hi = mid;
      }
    }

    // Wrap around if keyHash is past the last virtual node (ring behaviour).
    const idx = lo % this.ring.length;
    return this.ring[idx].nodeId;
  }

  /**
   * Return an ordered list of up to `n` DISTINCT physical nodes responsible
   * for `key` — primary first, then replicas walking clockwise.
   *
   * Used by Phase 4 replication to determine where to fan-out writes and
   * where to fall back on reads when the primary is dead.
   *
   * Edge cases:
   *   - If the cluster has fewer physical nodes than `n`, returns all nodes
   *     (never crashes — gracefully capped at cluster size).
   *   - RF=1 returns just the primary (same as getNodeForKey).
   *
   * @param key  The cache key to look up.
   * @param n    How many distinct physical nodes to return (replication factor).
   * @throws {Error} if the ring is empty.
   */
  getReplicaNodes(key: string, n: number): string[] {
    if (this.ring.length === 0) {
      throw new Error("HashRing is empty — add at least one node first.");
    }

    // Cap at the number of available physical nodes so we never loop forever
    // when REPLICATION_FACTOR > cluster size.
    const count = Math.min(n, this.nodeSet.size);

    const keyHash = this.hashToUint32(key);

    // Binary search for the starting index (same logic as getNodeForKey).
    let lo = 0;
    let hi = this.ring.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (this.ring[mid].hash < keyHash) {
        lo = mid + 1;
      } else {
        hi = mid;
      }
    }

    const startIdx = lo % this.ring.length;
    const result: string[] = [];
    const seen = new Set<string>();

    // Walk clockwise, skipping duplicate physical nodes (which arise because
    // each physical node has VIRTUAL_NODES proxy points on the ring).
    for (let i = 0; i < this.ring.length && result.length < count; i++) {
      const vn = this.ring[(startIdx + i) % this.ring.length];
      if (!seen.has(vn.nodeId)) {
        seen.add(vn.nodeId);
        result.push(vn.nodeId);
      }
    }

    return result;
  }

  /**
   * Return an array of all physical node IDs currently in the ring.
   * Order is not guaranteed.
   */
  getNodes(): string[] {
    return [...this.nodeSet];
  }

  /**
   * Check whether a physical node is currently in the ring.
   */
  hasNode(nodeId: string): boolean {
    return this.nodeSet.has(nodeId);
  }

  /**
   * Total number of virtual nodes currently on the ring.
   * Useful for debugging distribution.
   */
  get size(): number {
    return this.ring.length;
  }

  // ------------------------------------------------------------------
  // Private — hashing
  // ------------------------------------------------------------------

  /**
   * Hash an arbitrary string to a uint32 (0 … 2³²-1).
   *
   * Uses SHA-256 via Node's built-in `crypto` module — no third-party
   * hash library needed.  We take the first 8 hex characters (32 bits)
   * of the digest and parse them as an unsigned 32-bit integer.
   *
   * SHA-256 produces excellent distribution, which is critical for
   * even virtual-node placement on the ring.
   */
  private hashToUint32(input: string): number {
    const hex = createHash("sha256").update(input).digest("hex").slice(0, 8);
    // parseInt with radix 16 on an 8-char hex string gives a value in
    // [0, 2^32 - 1], which fits safely in a JS number (all integers
    // up to 2^53 are exact in IEEE-754).
    return parseInt(hex, 16);
  }
}
