/**
 * LRUCache — Vulcan Phase 1: Single-Node In-Memory Key-Value Store
 *
 * Design goals:
 *   • O(1) average-case GET, SET, DELETE
 *   • Optional per-key TTL with lazy + active expiry
 *   • LRU eviction via doubly linked list + HashMap
 *
 * This module is intentionally self-contained and networking-free.
 * Later phases will wrap it behind a network protocol and replicate
 * it across nodes, but the core data structure stays here.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Internal node used in the doubly linked list. */
interface DLLNode<V> {
  key: string;
  value: V;
  /**
   * Absolute expiry timestamp in milliseconds (Date.now() scale).
   * undefined means the key has no TTL and lives forever.
   */
  expiresAt: number | undefined;
  prev: DLLNode<V> | null;
  next: DLLNode<V> | null;
}

/** Public options for constructing the cache. */
export interface CacheOptions {
  /**
   * Maximum number of keys the cache may hold at any time.
   * When this limit is reached, the least recently used key is evicted
   * before the new key is inserted.
   */
  maxCapacity: number;

  /**
   * How often (in milliseconds) the background sweep runs to proactively
   * remove expired keys.  Defaults to 1 000 ms (1 second).
   * Set to 0 to disable the active sweep entirely.
   */
  sweepIntervalMs?: number;
}

/** Return value of GET — null signals "absent or expired". */
export type GetResult<V> = V | null;

// ---------------------------------------------------------------------------
// LRUCache
// ---------------------------------------------------------------------------

/**
 * A fixed-capacity in-memory key-value store with:
 *
 * **LRU eviction** — backed by a doubly linked list (DLL) + HashMap so that
 * promote-to-MRU (on every GET/SET) and evict-LRU are both O(1).  A naive
 * array-based approach would be O(n) per operation and is explicitly avoided.
 *
 * **TTL expiry** — uses two complementary strategies:
 *
 *   1. *Lazy expiry* — every GET checks whether the key has passed its
 *      deadline and, if so, deletes it and returns null.  This is O(1) and
 *      keeps the hot path fast, but it leaks memory for keys that are
 *      written and then never read again ("cold" keys).
 *
 *   2. *Active sweep* — a `setInterval` periodically walks the internal map
 *      and purges all expired entries regardless of read activity.  This
 *      bounds worst-case memory growth.  The sweep is O(n), so it runs
 *      infrequently; the lazy path handles the common case cheaply.
 *
 * Together the two strategies give the best of both worlds: near-zero
 * overhead on the hot read path AND a cap on stale-key memory waste.
 * (This is the same dual-strategy used by Redis.)
 */
export class LRUCache<V = unknown> {
  // ------------------------------------------------------------------
  // Configuration
  // ------------------------------------------------------------------
  private readonly maxCapacity: number;

  // ------------------------------------------------------------------
  // Data structures
  // ------------------------------------------------------------------

  /**
   * HashMap: key → DLLNode
   * Provides O(1) lookup, insert, and delete.
   */
  private readonly map: Map<string, DLLNode<V>>;

  /**
   * Doubly linked list maintained in MRU→LRU order:
   *   head.next = most recently used
   *   tail.prev = least recently used
   *
   * Sentinel head/tail nodes eliminate null-checks on edge cases.
   */
  private readonly head: DLLNode<V>; // sentinel — never holds real data
  private readonly tail: DLLNode<V>; // sentinel — never holds real data

  // ------------------------------------------------------------------
  // Active-sweep timer handle
  // ------------------------------------------------------------------
  private sweepTimer: ReturnType<typeof setInterval> | null = null;

  // ------------------------------------------------------------------
  // Constructor
  // ------------------------------------------------------------------

  constructor(options: CacheOptions) {
    if (options.maxCapacity < 1) {
      throw new RangeError("maxCapacity must be at least 1");
    }

    this.maxCapacity = options.maxCapacity;
    this.map = new Map();

    // Initialise sentinel nodes — their key/value fields are never read.
    this.head = this.makeSentinel();
    this.tail = this.makeSentinel();
    this.head.next = this.tail;
    this.tail.prev = this.head;

    // Active sweep — only started if a positive interval is configured.
    const intervalMs = options.sweepIntervalMs ?? 1_000;
    if (intervalMs > 0) {
      this.sweepTimer = setInterval(() => this.activeSweep(), intervalMs);
      // Mark the timer as non-blocking so the Node.js process can exit
      // even while the cache is alive (important for tests & scripts).
      if (
        this.sweepTimer &&
        typeof (this.sweepTimer as NodeJS.Timeout).unref === "function"
      ) {
        (this.sweepTimer as NodeJS.Timeout).unref();
      }
    }
  }

  // ------------------------------------------------------------------
  // Public API
  // ------------------------------------------------------------------

  /**
   * Store a key-value pair.
   *
   * If the key already exists it is updated in-place and promoted to MRU.
   * If the cache is at capacity a new key causes the LRU entry to be evicted
   * before insertion.
   *
   * @param key        Cache key (string).
   * @param value      Value to store.
   * @param ttlSeconds Optional time-to-live in seconds.  Omit for no expiry.
   */
  set(key: string, value: V, ttlSeconds?: number): void {
    const existing = this.map.get(key);

    if (existing !== undefined) {
      // Key already present — update value and TTL, then promote to MRU.
      existing.value = value;
      existing.expiresAt =
        ttlSeconds !== undefined
          ? Date.now() + ttlSeconds * 1_000
          : undefined;
      this.promoteToMRU(existing);
      return;
    }

    // Brand-new key — make room first if we are at capacity.
    // Priority: purge an expired node before evicting a live LRU node.
    // This prevents a zombie (expired-but-not-yet-swept) key from unfairly
    // displacing a live entry just because it happens to be in the LRU slot.
    if (this.map.size >= this.maxCapacity) {
      if (!this.purgeOneExpired()) {
        // No expired node found — fall back to true LRU eviction.
        this.evictLRU();
      }
    }

    const node: DLLNode<V> = {
      key,
      value,
      expiresAt:
        ttlSeconds !== undefined
          ? Date.now() + ttlSeconds * 1_000
          : undefined,
      prev: null,
      next: null,
    };

    this.map.set(key, node);
    this.insertAfterHead(node); // newest node becomes MRU
  }

  /**
   * Retrieve a value by key.
   *
   * Implements **lazy expiry**: if the key is found but its TTL has elapsed,
   * the entry is deleted here and null is returned — no separate cleanup
   * pass needed for recently-accessed keys.
   *
   * Returns null for missing OR expired keys (never throws).
   */
  get(key: string): GetResult<V> {
    const node = this.map.get(key);

    if (node === undefined) {
      return null;
    }

    // Lazy expiry check — O(1), runs inline on every read.
    if (this.isExpired(node)) {
      this.removeNode(node);
      this.map.delete(key);
      return null;
    }

    // Promote to MRU so the DLL reflects recency correctly.
    this.promoteToMRU(node);
    return node.value;
  }

  /**
   * Delete a key from the cache.
   *
   * @returns true if the key existed and was removed, false otherwise.
   */
  delete(key: string): boolean {
    const node = this.map.get(key);
    if (node === undefined) {
      return false;
    }

    this.removeNode(node);
    this.map.delete(key);
    return true;
  }

  /**
   * Current number of keys in the cache (including keys that may be
   * expired but not yet swept — lazy expiry has not run on them yet).
   */
  get size(): number {
    return this.map.size;
  }

  /**
   * Check whether a key exists and is still alive (not expired).
   * Does NOT promote to MRU (peek semantics).
   */
  has(key: string): boolean {
    const node = this.map.get(key);
    if (node === undefined) return false;
    return !this.isExpired(node);
  }

  /**
   * Return all live (non-expired) key-value pairs currently in the cache.
   *
   * Added in Phase 4 to support the `GET /internal/dump` endpoint used for
   * replication re-sync when a node rejoins the cluster.
   *
   * Does NOT modify LRU order — purely a read operation.
   *
   * @returns Snapshot array; the cache can change after this call returns.
   */
  entries(): Array<{ key: string; value: V }> {
    const now = Date.now();
    const result: Array<{ key: string; value: V }> = [];
    for (const [key, node] of this.map) {
      if (node.expiresAt === undefined || node.expiresAt > now) {
        result.push({ key, value: node.value });
      }
    }
    return result;
  }

  /**
   * Remove all entries from the cache.
   */
  clear(): void {
    this.map.clear();
    // Reset the DLL back to empty (just the two sentinels).
    this.head.next = this.tail;
    this.tail.prev = this.head;
  }

  /**
   * Stop the background sweep timer and release the cache.
   * Call this in tests / when the cache instance is no longer needed to
   * avoid keeping the event loop alive.
   */
  destroy(): void {
    if (this.sweepTimer !== null) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = null;
    }
    this.clear();
  }

  // ------------------------------------------------------------------
  // Private — TTL helpers
  // ------------------------------------------------------------------

  /** Returns true if the node's TTL has elapsed. */
  private isExpired(node: DLLNode<V>): boolean {
    return node.expiresAt !== undefined && Date.now() >= node.expiresAt;
  }

  /**
   * Active expiry sweep — called by the background setInterval.
   *
   * Walks the entire map and removes every expired entry.  This is O(n)
   * in the number of cached keys, which is why we run it infrequently
   * rather than on every operation.  Its job is to reclaim memory for
   * "cold" keys (written once, never read) that lazy expiry would miss.
   */
  private activeSweep(): void {
    const now = Date.now();
    for (const [key, node] of this.map) {
      if (node.expiresAt !== undefined && now >= node.expiresAt) {
        this.removeNode(node);
        this.map.delete(key);
      }
    }
  }

  // ------------------------------------------------------------------
  // Private — LRU doubly linked list helpers
  // ------------------------------------------------------------------

  /** Create a sentinel node (never holds real data). */
  private makeSentinel(): DLLNode<V> {
    return {
      key: "",
      value: undefined as unknown as V,
      expiresAt: undefined,
      prev: null,
      next: null,
    };
  }

  /**
   * Insert `node` immediately after the head sentinel, making it the
   * most-recently-used entry.  The node must NOT already be in the list.
   */
  private insertAfterHead(node: DLLNode<V>): void {
    node.next = this.head.next;
    node.prev = this.head;
    // Non-null assertion is safe: head.next is always at least `tail`.
    this.head.next!.prev = node;
    this.head.next = node;
  }

  /**
   * Splice `node` out of the DLL without touching the map.
   * The node's prev/next pointers are left dangling — callers are
   * responsible for re-inserting or discarding the node.
   */
  private removeNode(node: DLLNode<V>): void {
    node.prev!.next = node.next;
    node.next!.prev = node.prev;
  }

  /**
   * Move `node` to the MRU position (right after head).
   * Used by GET and SET to maintain recency ordering in O(1).
   */
  private promoteToMRU(node: DLLNode<V>): void {
    this.removeNode(node);
    this.insertAfterHead(node);
  }

  /**
   * Remove and discard the least-recently-used node (the one just before
   * the tail sentinel).  Called when a new key would exceed maxCapacity
   * and no expired node was available to purge first.
   */
  private evictLRU(): void {
    const lru = this.tail.prev!;
    // Guard: should never be the head sentinel in a non-empty cache.
    if (lru === this.head) return;

    this.removeNode(lru);
    this.map.delete(lru.key);
  }

  /**
   * Scan the map for the first expired entry and remove it.
   *
   * Called by `set()` before falling back to LRU eviction so that an
   * expired (but not yet swept) key does not cause an unnecessary
   * eviction of a still-live entry.
   *
   * @returns true if an expired node was found and removed, false otherwise.
   */
  private purgeOneExpired(): boolean {
    const now = Date.now();
    for (const [key, node] of this.map) {
      if (node.expiresAt !== undefined && now >= node.expiresAt) {
        this.removeNode(node);
        this.map.delete(key);
        return true;
      }
    }
    return false;
  }
}
