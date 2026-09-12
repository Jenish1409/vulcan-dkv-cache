#!/usr/bin/env node
'use strict';
/**
 * benchmarks/bench-vulcan.js
 *
 * Runs all autocannon scenarios against the 3-node Vulcan Docker cluster.
 * Prereq: cluster running at localhost:5001/5002/5003, keys pre-populated
 * by populate.js.
 *
 * Scenarios:
 *   a) Pure GET throughput   -- c=50, 10s
 *   b) Pure PUT throughput   -- c=50, 10s
 *   c) Mixed 80% GET/20% PUT -- c=50, 10s
 *   d) GET latency focus     -- c=10, 30s  (lower concurrency = honest tail-latency)
 *   e) Forwarding-hop delta  -- c=10, 10s each:
 *      e1: keys owned by node1, hitting node1 (no hop)
 *      e2: keys owned by node2, hitting node1 (must forward to node2)
 */

const autocannon = require('autocannon');
const http = require('http');
const fs = require('fs');
const path = require('path');

const BASE = 'http://localhost:5001';
const KEY_POOL = 1000;
const RAW_DIR = path.join(__dirname, 'raw');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function save(name, data) {
  fs.writeFileSync(path.join(RAW_DIR, `${name}.json`), JSON.stringify(data, null, 2));
}

function extractSummary(result) {
  return {
    reqPerSec:  Math.round(result.requests.average),
    totalReqs:  result.requests.total,
    errors:     result.errors,
    timeouts:   result.timeouts,
    latency: {
      avg:  result.latency.average,
      p50:  result.latency.p50,
      p75:  result.latency.p75,
      // autocannon v8 renamed p95 -> p97_5; we store it as p95 for readability
      p95:  result.latency.p97_5 ?? result.latency.p95,
      p99:  result.latency.p99,
      p999: result.latency.p999,
    },
  };
}

async function getJSON(url) {
  return new Promise((resolve, reject) => {
    http.get(url, res => {
      let d = '';
      res.on('data', c => (d += c));
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { reject(e); } });
    }).on('error', reject);
  });
}

async function run(label, opts) {
  console.log(`\n  [bench] ${label} ...`);
  const result = await autocannon(opts);
  const s = extractSummary(result);
  console.log(`         ${s.reqPerSec} req/s | avg=${s.latency.avg}ms p50=${s.latency.p50}ms p95=${s.latency.p95}ms p99=${s.latency.p99}ms | err=${s.errors}`);
  return { label, summary: s };
}

// ---------------------------------------------------------------------------
// Key discovery for forwarding-hop comparison
// ---------------------------------------------------------------------------

async function discoverKeys() {
  console.log('\n  Discovering key ownership via /ring/owner (scanning bench-key-0..499)...');
  const node1Keys = [];
  const node2Keys = [];

  for (let i = 0; i < 500; i++) {
    if (node1Keys.length >= 30 && node2Keys.length >= 30) break;
    const key = `bench-key-${i}`;
    try {
      const r = await getJSON(`${BASE}/ring/owner/${key}`);
      if      (r.owner === 'node1' && node1Keys.length < 30) node1Keys.push(key);
      else if (r.owner === 'node2' && node2Keys.length < 30) node2Keys.push(key);
    } catch { /* skip */ }
  }

  console.log(`  Found: ${node1Keys.length} node1-owned keys, ${node2Keys.length} node2-owned keys`);
  return { node1Keys, node2Keys };
}

// ---------------------------------------------------------------------------
// Request builders
// ---------------------------------------------------------------------------

function makeGETs(keys) {
  return keys.map(k => ({ method: 'GET', path: `/kv/${k}` }));
}

function makePUTs(keys) {
  return keys.map(k => ({
    method: 'PUT',
    path: `/kv/${k}`,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ value: 'bench-value' }),
  }));
}

function makeMixed(keys) {
  // 80% GET, 20% PUT  (interleaved so the mix is realistic)
  const gets = keys.slice(0, Math.floor(keys.length * 0.8)).map(k => ({ method: 'GET', path: `/kv/${k}` }));
  const puts = keys.slice(Math.floor(keys.length * 0.8)).map(k => ({
    method: 'PUT', path: `/kv/${k}`,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ value: 'bench-value' }),
  }));
  // Interleave 4 GETs per PUT so the ratio is maintained across requests
  const mixed = [];
  let gi = 0, pi = 0;
  while (gi < gets.length || pi < puts.length) {
    for (let x = 0; x < 4 && gi < gets.length; x++, gi++) mixed.push(gets[gi]);
    if (pi < puts.length) mixed.push(puts[pi++]);
  }
  return mixed;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const allResults = [];

  const { node1Keys, node2Keys } = await discoverKeys();

  // Use a balanced mix of node1 + node2 keys for general benchmarks
  const generalKeys = [
    ...node1Keys.slice(0, 15),
    ...node2Keys.slice(0, 15),
  ];

  // a) Pure GET throughput
  const r_a = await run('a) GET throughput (c=50, t=10s)', {
    url: BASE, connections: 50, duration: 10,
    requests: makeGETs(generalKeys),
  });
  save('vulcan-a-get-throughput', r_a);
  allResults.push(r_a);

  // b) Pure PUT throughput
  const r_b = await run('b) PUT throughput (c=50, t=10s)', {
    url: BASE, connections: 50, duration: 10,
    requests: makePUTs(generalKeys),
  });
  save('vulcan-b-put-throughput', r_b);
  allResults.push(r_b);

  // c) Mixed 80% GET / 20% PUT
  const r_c = await run('c) Mixed 80/20 (c=50, t=10s)', {
    url: BASE, connections: 50, duration: 10,
    requests: makeMixed(generalKeys),
  });
  save('vulcan-c-mixed-80-20', r_c);
  allResults.push(r_c);

  // d) Latency focus: lower concurrency, longer run
  const r_d = await run('d) GET latency focus (c=10, t=30s)', {
    url: BASE, connections: 10, duration: 30,
    requests: makeGETs(generalKeys),
  });
  save('vulcan-d-get-latency', r_d);
  allResults.push(r_d);

  // e1) Own-node GET -- node1 keys, hitting node1 (no forwarding hop)
  const r_e1 = await run('e1) GET local/no-hop (c=10, t=10s) -- node1 owns all keys', {
    url: BASE, connections: 10, duration: 10,
    requests: makeGETs(node1Keys.slice(0, 20)),
  });
  save('vulcan-e1-get-local', r_e1);
  allResults.push(r_e1);

  // e2) Forwarded GET -- node2 keys, hitting node1 (node1 must proxy to node2)
  const r_e2 = await run('e2) GET forwarded (c=10, t=10s) -- node2 owns all keys, node1 proxies', {
    url: BASE, connections: 10, duration: 10,
    requests: makeGETs(node2Keys.slice(0, 20)),
  });
  save('vulcan-e2-get-forwarded', r_e2);
  allResults.push(r_e2);

  // ---------------------------------------------------------------------------
  // Summary
  // ---------------------------------------------------------------------------
  console.log('\n\n====================================================');
  console.log('  VULCAN BENCHMARK SUMMARY');
  console.log('====================================================');
  for (const r of allResults) {
    console.log(`\n  ${r.label}`);
    console.log(`    req/sec : ${r.summary.reqPerSec}`);
    console.log(`    latency : avg=${r.summary.latency.avg}ms | p50=${r.summary.latency.p50}ms | p95=${r.summary.latency.p95}ms | p99=${r.summary.latency.p99}ms`);
    console.log(`    errors  : ${r.summary.errors}  timeouts: ${r.summary.timeouts}`);
  }

  save('vulcan-summary', {
    timestamp: new Date().toISOString(),
    results: allResults.map(r => ({ label: r.label, summary: r.summary })),
  });

  console.log('\n\nRaw results -> benchmarks/raw/vulcan-*.json\n');
}

main().catch(err => { console.error(err); process.exit(1); });
