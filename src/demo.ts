/**
 * Quick manual demo of the LRUCache — run with:
 *   npx ts-node src/demo.ts
 */

import { LRUCache } from "./store";

console.log("=== Vulcan Phase 1 — LRUCache Demo ===\n");

// ── 1. Basic SET / GET / DELETE ──────────────────────────────────────────────
const cache = new LRUCache<string>({ maxCapacity: 3, sweepIntervalMs: 2_000 });

cache.set("name", "Vulcan");
cache.set("version", "1.0");
cache.set("author", "Jenish");

console.log("After setting 3 keys:");
console.log("  name    →", cache.get("name"));      // Vulcan
console.log("  version →", cache.get("version"));   // 1.0
console.log("  author  →", cache.get("author"));    // Jenish
console.log("  size    →", cache.size);             // 3

// ── 2. LRU eviction ──────────────────────────────────────────────────────────
console.log("\n--- LRU eviction (capacity = 3) ---");
// At this point the access order is: author (MRU) → version → name (LRU)
// because the GETs above promoted them in that order.
cache.set("newkey", "hello"); // should evict 'name' (LRU)

console.log("After inserting 'newkey':");
console.log("  name    →", cache.get("name"));     // null — evicted
console.log("  version →", cache.get("version"));  // 1.0
console.log("  author  →", cache.get("author"));   // Jenish
console.log("  newkey  →", cache.get("newkey"));   // hello

// ── 3. TTL expiry ────────────────────────────────────────────────────────────
console.log("\n--- TTL expiry ---");
cache.set("short", "I expire in 2 seconds", 2);
console.log("  short (now)    →", cache.get("short")); // I expire in 2 seconds

setTimeout(() => {
  console.log("\n  [2.1 seconds later]");
  console.log("  short (after TTL) →", cache.get("short")); // null — expired
  console.log("  size after expiry →", cache.size);

  cache.destroy(); // stop the background sweep
  console.log("\n=== Demo complete ===");
}, 2_100);
