#!/usr/bin/env node
'use strict';
/**
 * benchmarks/bench-redis.js
 *
 * Benchmarks Redis using the official `redis` npm client with 50 concurrent
 * async workers -- the same Node.js event loop and measurement methodology
 * as autocannon uses for Vulcan.
 *
 * This gives an apples-to-apples comparison: both results are "as seen from
 * a Node.js client". The gap you see is therefore protocol + implementation
 * overhead (HTTP/JSON vs RESP binary, Node vs C), NOT a measurement artifact.
 *
 * redis-benchmark numbers (run separately, saved to raw/redis-benchmark.txt)
 * show Redis's theoretical ceiling via its native C client.
 */

const { createClient } = require('redis');
const fs = require('fs');
const path = require('path');

const REDIS_URL = 'redis://localhost:6379';
const KEY_POOL  = 1000;
const RAW_DIR   = path.join(__dirname, 'raw');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function pct(sorted, p) {
  const idx = Math.max(0, Math.ceil((p / 100) * sorted.length) - 1);
  return +(sorted[idx] ?? 0).toFixed(3);
}

async function createClients(n) {
  return Promise.all(
    Array.from({ length: n }, async () => {
      const c = createClient({ url: REDIS_URL });
      await c.connect();
      return c;
    })
  );
}

async function runBenchmark(name, opFn, workers, totalOps) {
  console.log(`\n  [bench] Redis ${name} ...`);
  const opsPerWorker = Math.ceil(totalOps / workers);
  const clients      = await createClients(workers);
  const latencies    = [];

  const t0 = Date.now();
  await Promise.all(
    clients.map(async (client, wi) => {
      for (let i = 0; i < opsPerWorker; i++) {
        const key = `bench-key-${(wi * opsPerWorker + i) % KEY_POOL}`;
        const ts  = performance.now();
        await opFn(client, key, wi * opsPerWorker + i);
        latencies.push(performance.now() - ts);
      }
    })
  );

  const elapsed  = (Date.now() - t0) / 1000;
  const realTotal = workers * opsPerWorker;
  latencies.sort((a, b) => a - b);

  const result = {
    label:    `Redis-${name}`,
    opsPerSec: Math.round(realTotal / elapsed),
    totalOps:  realTotal,
    elapsedSec: +elapsed.toFixed(2),
    latency: {
      avg:  +(latencies.reduce((a, b) => a + b, 0) / latencies.length).toFixed(3),
      p50:  pct(latencies, 50),
      p75:  pct(latencies, 75),
      p95:  pct(latencies, 95),
      p99:  pct(latencies, 99),
      p999: pct(latencies, 99.9),
    },
  };

  console.log(`         ${result.opsPerSec} ops/s | avg=${result.latency.avg}ms p50=${result.latency.p50}ms p95=${result.latency.p95}ms p99=${result.latency.p99}ms`);

  fs.writeFileSync(
    path.join(RAW_DIR, `redis-node-${name.toLowerCase().replace(/[\s/()=,]+/g, '-')}.json`),
    JSON.stringify(result, null, 2)
  );

  await Promise.all(clients.map(c => c.quit()));
  return result;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  // Seed Redis with benchmark keys
  console.log(`\n  Seeding Redis with ${KEY_POOL} keys...`);
  const seed = createClient({ url: REDIS_URL });
  await seed.connect();
  const pipeline = seed.multi();
  for (let i = 0; i < KEY_POOL; i++) pipeline.set(`bench-key-${i}`, `value-${i}`);
  await pipeline.exec();
  await seed.quit();
  console.log('  Seeding done.\n');

  const allResults = [];

  // a) GET throughput (50 workers, 100k ops -- matches autocannon c=50, t=10s scale)
  allResults.push(await runBenchmark(
    'GET (c=50, n=100k)',
    (c, k) => c.get(k),
    50, 100_000
  ));

  // b) SET throughput
  allResults.push(await runBenchmark(
    'SET (c=50, n=100k)',
    (c, k, i) => c.set(k, `v${i}`),
    50, 100_000
  ));

  // c) Mixed 80% GET / 20% SET
  let mixTick = 0;
  allResults.push(await runBenchmark(
    'mixed-80/20 (c=50, n=100k)',
    (c, k, i) => (++mixTick % 5 === 0 ? c.set(k, `v${i}`) : c.get(k)),
    50, 100_000
  ));

  // d) Latency focus (10 workers, 10k ops -- matches autocannon c=10, t=30s scale)
  allResults.push(await runBenchmark(
    'GET-latency (c=10, n=10k)',
    (c, k) => c.get(k),
    10, 10_000
  ));

  // ---------------------------------------------------------------------------
  // Summary
  // ---------------------------------------------------------------------------
  console.log('\n\n====================================================');
  console.log('  REDIS (Node client) BENCHMARK SUMMARY');
  console.log('====================================================');
  for (const r of allResults) {
    console.log(`\n  ${r.label}`);
    console.log(`    ops/sec : ${r.opsPerSec}`);
    console.log(`    latency : avg=${r.latency.avg}ms | p50=${r.latency.p50}ms | p95=${r.latency.p95}ms | p99=${r.latency.p99}ms`);
  }

  fs.writeFileSync(
    path.join(RAW_DIR, 'redis-node-summary.json'),
    JSON.stringify({ timestamp: new Date().toISOString(), results: allResults }, null, 2)
  );

  console.log('\n\nRaw results -> benchmarks/raw/redis-node-*.json\n');
}

main().catch(err => { console.error(err); process.exit(1); });
