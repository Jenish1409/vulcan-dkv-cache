/**
 * chaos/src/runner.ts
 *
 * Main orchestrator for the Vulcan chaos-testing harness.
 *
 * Fault scenario sequence (default 3-minute run):
 *
 *   00–15s   Baseline          Normal operations, builds write history
 *   15–45s   Kill node2        Tests primary failover + read fallback
 *   45–75s   node2 rejoins     Tests rejoin re-sync correctness
 *   75–95s   Isolate node1     Tests full network isolation + heartbeat failure
 *   95–115s  Restore node1     Tests reconvergence after isolation
 *  115–120s  Malformed value   Confirms 400 is returned (not crash)
 *  120–180s  Final baseline    Confirms consistency after all faults healed
 *
 * Usage:
 *   npx ts-node chaos/src/runner.ts [--duration 180] [--rate 20] [--keys 50]
 *
 * Or via: .\scripts\run-chaos.ps1 from the project root.
 */

import * as path from 'path';
import * as fs   from 'fs';
import { Recorder }      from './recorder';
import { LoadGenerator, ActiveFaultTracker } from './loader';
import { FaultInjector } from './injector';
import { runChecker, printReport } from './checker';
import type { ChaosConfig } from './types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, Math.max(0, ms)));
}

function parseArgs(): { durationSec: number; ratePerSec: number; keyCount: number } {
  const args = process.argv.slice(2);
  const get  = (flag: string, def: number) => {
    const i = args.indexOf(flag);
    return i !== -1 && args[i + 1] ? parseInt(args[i + 1]!, 10) : def;
  };
  return {
    durationSec: get('--duration', 180),
    ratePerSec:  get('--rate', 20),
    keyCount:    get('--keys', 50),
  };
}

// ---------------------------------------------------------------------------
// Cluster health check
// ---------------------------------------------------------------------------

async function checkCluster(nodes: ChaosConfig['nodes']): Promise<void> {
  const axios = (await import('axios')).default;
  let ok = 0;
  for (const node of nodes) {
    try {
      const resp = await axios.get(`http://${node.host}:${node.port}/health`, { timeout: 3000 });
      if (resp.status === 200) ok++;
    } catch {
      console.warn(`  ⚠️  ${node.id} (localhost:${node.port}) not reachable`);
    }
  }
  if (ok < nodes.length) {
    console.error(`\n❌ Only ${ok}/${nodes.length} nodes reachable. Ensure docker compose up -d has been run.`);
    process.exit(1);
  }
  console.log(`  ✅ All ${ok} nodes are reachable.\n`);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const { durationSec, ratePerSec, keyCount } = parseArgs();
  const durationMs = durationSec * 1000;

  const projectRoot = path.join(__dirname, '..', '..');
  const logsDir     = path.join(__dirname, '..', 'logs');
  const logFile     = path.join(logsDir, `chaos-${Date.now()}.jsonl`);

  const config: ChaosConfig = {
    nodes: [
      { id: 'node1', host: 'localhost', port: 5001 },
      { id: 'node2', host: 'localhost', port: 5002 },
      { id: 'node3', host: 'localhost', port: 5003 },
    ],
    ratePerSec,
    keyCount,
    logFile,
    durationMs,
    projectRoot,
  };

  const hr = '='.repeat(62);
  console.log(`\n${hr}`);
  console.log('  VULCAN CHAOS TESTING HARNESS — Phase 7');
  console.log(hr);
  console.log(`  Duration    : ${durationSec}s`);
  console.log(`  Target rate : ${ratePerSec} req/s`);
  console.log(`  Key pool    : chaos-key-0 .. chaos-key-${keyCount - 1}`);
  console.log(`  Log file    : ${logFile}`);
  console.log(`${hr}\n`);

  console.log('-- Checking cluster health --');
  await checkCluster(config.nodes);

  // ── Set up components ────────────────────────────────────────────────────

  fs.mkdirSync(logsDir, { recursive: true });
  const recorder     = new Recorder(logFile);
  const faultTracker = new ActiveFaultTracker();
  const loader       = new LoadGenerator(config, recorder, faultTracker);
  const injector     = new FaultInjector(recorder, faultTracker, projectRoot);

  // ── Start load generator (runs in background) ────────────────────────────

  console.log('-- Starting load generator --');
  let malformedSeqNum = 0;
  const loadPromise = loader.start();

  const experimentStart = Date.now();

  // ── Fault scenario sequence ──────────────────────────────────────────────

  try {

    // Window 0–15s: Baseline
    console.log('\n[T+0s]   Baseline — normal operations, building write history...');
    await sleep(15_000);

    // Window 15–45s: Kill node2
    console.log(`\n[T+${Math.round((Date.now() - experimentStart) / 1000)}s]  FAULT 1: Kill node2 (30s down)`);
    const killFaultId = injector.killNode('node2');
    await sleep(30_000);

    // Window 45–75s: Restart node2, wait for re-sync
    console.log(`\n[T+${Math.round((Date.now() - experimentStart) / 1000)}s]  HEAL 1: Restart node2, waiting for rejoin re-sync (30s)...`);
    injector.restartNode('node2', killFaultId);
    await sleep(30_000);

    // Window 75–95s: Isolate node1
    console.log(`\n[T+${Math.round((Date.now() - experimentStart) / 1000)}s]  FAULT 2: Isolate node1 from Docker network (20s)`);
    const isolateFaultId = injector.isolateNode('node1');
    await sleep(20_000);

    // Window 95–115s: Restore node1
    console.log(`\n[T+${Math.round((Date.now() - experimentStart) / 1000)}s]  HEAL 2: Restore node1 to network, reconverging (20s)...`);
    injector.restoreNode('node1', isolateFaultId);
    await sleep(20_000);

    // Window 115–120s: Malformed value injection
    console.log(`\n[T+${Math.round((Date.now() - experimentStart) / 1000)}s]  FAULT 3: Malformed value injection (expects 400)`);
    malformedSeqNum = loader.totalIssued + 1;
    await injector.injectMalformedValue(config.nodes[0]!, 'chaos-key-99', malformedSeqNum);
    await sleep(5_000);

    // Window 120–180s: Final baseline
    console.log(`\n[T+${Math.round((Date.now() - experimentStart) / 1000)}s]  Final baseline — all faults healed, confirming consistency...`);
    const remaining = durationMs - (Date.now() - experimentStart);
    if (remaining > 0) await sleep(remaining);

  } finally {
    // ── Stop load generator ────────────────────────────────────────────────
    console.log(`\n[T+${Math.round((Date.now() - experimentStart) / 1000)}s]  Stopping load generator...`);
    loader.stop();
    await loadPromise;
    recorder.close();
  }

  const totalOps = loader.totalIssued;
  console.log(`\n-- Load generator stopped. ${totalOps} operations issued. --`);
  console.log(`-- Log written to: ${logFile} --\n`);

  // ── Run linearizability checker ──────────────────────────────────────────

  console.log('-- Running linearizability checker --\n');
  const report = runChecker(logFile);
  printReport(report);

  process.exit(report.selfCheckPassed && report.passed ? 0 : 1);
}

main().catch((err: unknown) => {
  console.error('\n[runner] Fatal error:', err instanceof Error ? err.message : err);
  process.exit(1);
});
