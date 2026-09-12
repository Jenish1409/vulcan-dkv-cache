#!/usr/bin/env node
'use strict';
/**
 * benchmarks/populate.js
 *
 * Pre-populates 1,000 keys into the Vulcan cluster via autocannon PUT burst.
 * Must run BEFORE bench-vulcan.js so GET benchmarks hit warm keys.
 */

const autocannon = require('autocannon');

const BASE = 'http://localhost:5001';
const KEY_POOL = 1000;

const requests = Array.from({ length: KEY_POOL }, (_, i) => ({
  method: 'PUT',
  path: `/kv/bench-key-${i}`,
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ value: `bench-value-${i}` }),
}));

async function populate() {
  console.log(`Populating ${KEY_POOL} keys into Vulcan (${BASE})...`);
  const result = await autocannon({
    url: BASE,
    connections: 50,
    duration: 6,
    requests,
  });
  console.log(`  Done: ${result.requests.total} PUTs sent, ${result.errors} errors`);
  console.log(`  (Each of the ${KEY_POOL} keys was written at least once)`);
}

populate().catch(err => { console.error(err); process.exit(1); });
