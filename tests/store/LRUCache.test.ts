/**
 * Vulcan Phase 1 — LRUCache unit tests
 *
 * Test coverage:
 *   a) Basic SET / GET / DELETE
 *   b) TTL expiry (using Jest fake timers — no real sleeping)
 *   c) LRU eviction order under various access sequences
 *   d) Interaction between TTL expiry and LRU eviction
 */

import { LRUCache } from "@/store/LRUCache";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a cache and register automatic cleanup after each test. */
function makeCache<V = string>(
  maxCapacity: number,
  sweepIntervalMs = 0 // disable active sweep by default — tests drive time manually
): LRUCache<V> {
  return new LRUCache<V>({ maxCapacity, sweepIntervalMs });
}

// ---------------------------------------------------------------------------
// a) Basic SET / GET / DELETE
// ---------------------------------------------------------------------------

describe("Basic operations", () => {
  let cache: LRUCache<string>;

  beforeEach(() => {
    cache = makeCache(10);
  });

  afterEach(() => {
    cache.destroy();
  });

  test("GET on an empty cache returns null", () => {
    expect(cache.get("missing")).toBeNull();
  });

  test("SET then GET returns the stored value", () => {
    cache.set("name", "vulcan");
    expect(cache.get("name")).toBe("vulcan");
  });

  test("SET overwrites an existing key", () => {
    cache.set("x", "first");
    cache.set("x", "second");
    expect(cache.get("x")).toBe("second");
  });

  test("DELETE removes an existing key and returns true", () => {
    cache.set("k", "v");
    expect(cache.delete("k")).toBe(true);
    expect(cache.get("k")).toBeNull();
  });

  test("DELETE on a missing key returns false", () => {
    expect(cache.delete("ghost")).toBe(false);
  });

  test("size reflects the current number of stored keys", () => {
    expect(cache.size).toBe(0);
    cache.set("a", "1");
    cache.set("b", "2");
    expect(cache.size).toBe(2);
    cache.delete("a");
    expect(cache.size).toBe(1);
  });

  test("has returns true for a live key and false for missing key", () => {
    cache.set("alive", "yes");
    expect(cache.has("alive")).toBe(true);
    expect(cache.has("dead")).toBe(false);
  });

  test("clear removes all entries", () => {
    cache.set("a", "1");
    cache.set("b", "2");
    cache.clear();
    expect(cache.size).toBe(0);
    expect(cache.get("a")).toBeNull();
  });

  test("stores and retrieves various value types (generic V)", () => {
    const numCache = makeCache<number>(5);
    numCache.set("count", 42);
    expect(numCache.get("count")).toBe(42);
    numCache.destroy();

    const objCache = makeCache<{ x: number }>(5);
    objCache.set("point", { x: 99 });
    expect(objCache.get("point")).toEqual({ x: 99 });
    objCache.destroy();
  });
});

// ---------------------------------------------------------------------------
// b) TTL expiry — fake timers so tests run instantly
// ---------------------------------------------------------------------------

describe("TTL expiry (lazy)", () => {
  // Jest fake timers let us jump forward in time without real sleeping.
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  test("key without TTL never expires", () => {
    const cache = makeCache(10);
    cache.set("permanent", "stays");

    jest.advanceTimersByTime(1_000_000);

    expect(cache.get("permanent")).toBe("stays");
    cache.destroy();
  });

  test("key with TTL is retrievable before it expires", () => {
    const cache = makeCache(10);
    cache.set("temp", "here", 5); // 5-second TTL

    jest.advanceTimersByTime(4_999); // 4.999 s — still alive

    expect(cache.get("temp")).toBe("here");
    cache.destroy();
  });

  test("key with TTL returns null after expiry (lazy check on GET)", () => {
    const cache = makeCache(10);
    cache.set("temp", "gone", 5);

    jest.advanceTimersByTime(5_001); // 5.001 s — expired

    expect(cache.get("temp")).toBeNull();
    cache.destroy();
  });

  test("expired key is physically removed from the map after GET", () => {
    const cache = makeCache(10);
    cache.set("temp", "gone", 3);

    jest.advanceTimersByTime(3_001);

    cache.get("temp"); // triggers lazy removal
    expect(cache.size).toBe(0);
    cache.destroy();
  });

  test("has() returns false for an expired key without removing it", () => {
    const cache = makeCache(10);
    cache.set("temp", "val", 2);

    jest.advanceTimersByTime(2_001);

    // has() uses isExpired internally — it reads but doesn't promote/remove
    expect(cache.has("temp")).toBe(false);
    cache.destroy();
  });

  test("SET with new TTL on an existing key resets the expiry", () => {
    const cache = makeCache(10);
    cache.set("k", "v1", 2);

    jest.advanceTimersByTime(1_000); // 1 s elapsed

    // Re-set the same key with a fresh 5-second TTL
    cache.set("k", "v2", 5);

    jest.advanceTimersByTime(2_001); // would have expired under old TTL

    // Still alive because TTL was reset to 5 s from the second SET
    expect(cache.get("k")).toBe("v2");
    cache.destroy();
  });

  test("active sweep removes expired keys that were never read", () => {
    // This test enables the sweep with a 1-second interval.
    const cache = new LRUCache<string>({
      maxCapacity: 10,
      sweepIntervalMs: 1_000,
    });

    cache.set("cold", "key", 2); // 2-second TTL, will never be read

    // Advance 2 s to expire the key, then 1 more second to trigger the sweep.
    jest.advanceTimersByTime(3_000);

    // The sweep should have already purged it.
    expect(cache.size).toBe(0);
    cache.destroy();
  });
});

// ---------------------------------------------------------------------------
// c) LRU eviction order
// ---------------------------------------------------------------------------

describe("LRU eviction", () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  test("throws if maxCapacity is less than 1", () => {
    expect(() => makeCache(0)).toThrow(RangeError);
  });

  test("does not evict when under capacity", () => {
    const cache = makeCache(3);
    cache.set("a", "1");
    cache.set("b", "2");
    cache.set("c", "3");

    expect(cache.size).toBe(3);
    expect(cache.get("a")).toBe("1");
    expect(cache.get("b")).toBe("2");
    expect(cache.get("c")).toBe("3");
    cache.destroy();
  });

  test("evicts the LRU key when at capacity", () => {
    const cache = makeCache<string>(3);
    // Insert order: a → b → c  (a is LRU)
    cache.set("a", "1");
    cache.set("b", "2");
    cache.set("c", "3");

    // Insert d — should evict 'a' (LRU)
    cache.set("d", "4");

    expect(cache.get("a")).toBeNull(); // evicted
    expect(cache.get("b")).toBe("2");
    expect(cache.get("c")).toBe("3");
    expect(cache.get("d")).toBe("4");
    cache.destroy();
  });

  test("GET promotes a key to MRU, protecting it from eviction", () => {
    const cache = makeCache<string>(3);
    cache.set("a", "1");
    cache.set("b", "2");
    cache.set("c", "3");

    // Access 'a' — it becomes MRU; 'b' is now LRU
    cache.get("a");

    // Insert 'd' — should evict 'b' (LRU), not 'a'
    cache.set("d", "4");

    expect(cache.get("b")).toBeNull(); // evicted
    expect(cache.get("a")).toBe("1"); // still alive
    expect(cache.get("c")).toBe("3");
    expect(cache.get("d")).toBe("4");
    cache.destroy();
  });

  test("SET on an existing key promotes it to MRU", () => {
    const cache = makeCache<string>(3);
    cache.set("a", "1");
    cache.set("b", "2");
    cache.set("c", "3");

    // Re-set 'a' with a new value — a becomes MRU; 'b' becomes LRU
    cache.set("a", "updated");

    cache.set("d", "4"); // should evict 'b'

    expect(cache.get("b")).toBeNull();
    expect(cache.get("a")).toBe("updated");
    cache.destroy();
  });

  test("eviction sequence is correct across multiple inserts", () => {
    const cache = makeCache<number>(3);
    // Order: 1, 2, 3
    cache.set("k1", 1);
    cache.set("k2", 2);
    cache.set("k3", 3);

    // k1 is LRU; insert k4 → evict k1
    cache.set("k4", 4);
    expect(cache.get("k1")).toBeNull();

    // k2 is now LRU; insert k5 → evict k2
    cache.set("k5", 5);
    expect(cache.get("k2")).toBeNull();

    // k3 is now LRU; insert k6 → evict k3
    cache.set("k6", 6);
    expect(cache.get("k3")).toBeNull();

    expect(cache.size).toBe(3);
    cache.destroy();
  });

  test("capacity-1 cache always evicts on new key insert", () => {
    const cache = makeCache<string>(1);
    cache.set("a", "1");
    cache.set("b", "2"); // evicts 'a'

    expect(cache.get("a")).toBeNull();
    expect(cache.get("b")).toBe("2");
    cache.destroy();
  });
});

// ---------------------------------------------------------------------------
// d) TTL + LRU interaction
// ---------------------------------------------------------------------------

describe("TTL and LRU interaction", () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  test("an expired key is evicted before a live key even if expired key was MRU", () => {
    // cache capacity = 2; both slots filled
    const cache = makeCache<string>(2);
    cache.set("short", "expires", 1); // 1-second TTL
    cache.set("long", "lives"); // no TTL

    // Access 'short' to make it MRU — 'long' becomes LRU in DLL
    cache.get("short");

    // Now let 'short' expire
    jest.advanceTimersByTime(1_001);

    // Insert a new key — capacity is 2, so one must go.
    // 'short' is expired → lazy expiry on GET removes it; there's now room.
    // Alternatively, even if eviction fires before lazy check, only 'long'
    // remains live, so the new key should co-exist with 'long'.
    cache.set("new", "value");

    expect(cache.get("short")).toBeNull(); // expired
    expect(cache.get("long")).toBe("lives");
    expect(cache.get("new")).toBe("value");
    cache.destroy();
  });

  test("expired keys do not bloat the logical capacity count", () => {
    const cache = makeCache<string>(2);
    cache.set("a", "1", 1); // expires in 1 s
    cache.set("b", "2", 1); // expires in 1 s

    jest.advanceTimersByTime(1_001);

    // Both expired.  A GET on each will lazy-remove them.
    expect(cache.get("a")).toBeNull();
    expect(cache.get("b")).toBeNull();
    expect(cache.size).toBe(0);

    // Cache is logically empty — two new keys fit without eviction
    cache.set("c", "3");
    cache.set("d", "4");
    expect(cache.size).toBe(2);
    expect(cache.get("c")).toBe("3");
    cache.destroy();
  });

  test("LRU eviction targets LRU live node; expired nodes purged by sweep", () => {
    // Use a sweep so expired keys are cleaned up without reads.
    const cache = new LRUCache<string>({
      maxCapacity: 3,
      sweepIntervalMs: 500,
    });

    cache.set("a", "1", 1); // short TTL
    cache.set("b", "2"); // permanent
    cache.set("c", "3"); // permanent

    // Let 'a' expire and the sweep fire.
    jest.advanceTimersByTime(1_500); // 1.5 s — 'a' expired, sweep ran at 500 ms and 1000 ms

    // After sweep, 'a' should be gone and size should be 2
    expect(cache.size).toBe(2);
    expect(cache.get("a")).toBeNull();

    // Now we can add a new key without evicting any live key.
    cache.set("d", "4");
    expect(cache.size).toBe(3);
    expect(cache.get("b")).toBe("2");
    expect(cache.get("c")).toBe("3");
    expect(cache.get("d")).toBe("4");

    cache.destroy();
  });

  test("updating a key's TTL via SET prevents it from being lazily expired", () => {
    const cache = makeCache<string>(5);
    cache.set("k", "v1", 2);

    jest.advanceTimersByTime(1_000);

    // Refresh TTL to 5 more seconds
    cache.set("k", "v2", 5);

    jest.advanceTimersByTime(2_001); // original TTL would have fired here

    expect(cache.get("k")).toBe("v2"); // still alive due to refreshed TTL
    cache.destroy();
  });
});
