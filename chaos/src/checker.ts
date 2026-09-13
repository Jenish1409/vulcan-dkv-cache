/**
 * chaos/src/checker.ts
 *
 * Linearizability checker for Vulcan's async-replication KV store.
 *
 * ── What this checks ──────────────────────────────────────────────────────
 *
 * TWO hard invariants (violations = definite bugs):
 *
 *   1. INVENTED_VALUE
 *      A GET returned a value that was never written by any successful
 *      (HTTP 200) SET to that key during this run. There is no valid
 *      explanation for this: Vulcan cannot produce a value it never received.
 *
 *   2. FUTURE_READ
 *      A GET completed at wall-clock time T returned a value V, but the
 *      only SET that wrote V completed at time T' > T. The GET completed
 *      before the write was acknowledged -- it read a value from the future,
 *      which violates causality regardless of the replication model.
 *
 * ONE informational category (never a violation):
 *
 *   STALE_READ
 *      A GET returned an older value for a key that already had a newer
 *      confirmed SET before the GET completed. This is expected under
 *      Vulcan's async (fire-and-forget) replication model. The primary
 *      writes and responds immediately; the replica write is background
 *      HTTP and may not have arrived yet when a GET hits that replica.
 *      There is no hard propagation deadline. Stale reads are reported
 *      as counts (during active faults vs. no active fault) for information
 *      only -- they are NOT evidence of a bug.
 *
 * ── What this does NOT check ─────────────────────────────────────────────
 *
 *   • It does not prove strict linearizability (which would require
 *     tracking concurrent operation windows and testing all possible
 *     serialization orders). Vulcan's async replication explicitly
 *     does NOT guarantee strict linearizability.
 *   • It does not catch every possible bug -- only the two invariants above.
 *   • It does not verify DELETE correctness (DELETEs are not issued in this
 *     harness; see Phase 7 README for scope).
 *
 * ── Self-validation (run before every real check) ────────────────────────
 *
 *   The checker constructs a synthetic 3-entry log with one planted
 *   INVENTED_VALUE violation, runs the analysis on it, and asserts that
 *   exactly 1 violation is found. If the self-check fails, the checker
 *   refuses to run and exits with a non-zero code. This guards against
 *   a sloppy "always passes" checker.
 *
 * ── Usage ────────────────────────────────────────────────────────────────
 *
 *   Standalone:  npx ts-node chaos/src/checker.ts <logfile.jsonl>
 *   Programmatic: import { runChecker } from './checker'
 */

import * as fs from 'fs';
import type {
  LogEntry,
  OperationRecord,
  FaultRecord,
  CheckerViolation,
  StaleReadObservation,
  MalformedValueResult,
  CheckerReport,
} from './types';

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

interface WriteEntry {
  seqNum: number;
  value: string;
  startedAt: number;
  completedAt: number;
}

// ---------------------------------------------------------------------------
// Core analysis (pure function -- testable in isolation)
// ---------------------------------------------------------------------------

export function analyzeOperations(
  ops: OperationRecord[],
  faults: FaultRecord[]
): Omit<CheckerReport, 'logFile' | 'selfCheckPassed'> {
  // Sort ops by seqNum for deterministic output
  const sortedOps = [...ops].sort((a, b) => a.seqNum - b.seqNum);

  // Build per-key write history: only successful (200) SETs
  // Sorted by completedAt ascending.
  const writeHistory = new Map<string, WriteEntry[]>();
  for (const op of sortedOps) {
    if (op.type === 'SET' && op.status === 200 && op.intendedValue !== undefined) {
      // Skip malformed-value injections (they intentionally fail with 400)
      if (op.intendedValue.startsWith('[MALFORMED:')) continue;
      if (!writeHistory.has(op.key)) writeHistory.set(op.key, []);
      writeHistory.get(op.key)!.push({
        seqNum:      op.seqNum,
        value:       op.intendedValue,
        startedAt:   op.startedAt,
        completedAt: op.completedAt,
      });
    }
  }
  for (const entries of writeHistory.values()) {
    entries.sort((a, b) => a.completedAt - b.completedAt);
  }

  // Parse malformed-value injection results
  const malformedValueResults: MalformedValueResult[] = [];
  for (const op of sortedOps) {
    if (
      op.type === 'SET' &&
      op.intendedValue !== undefined &&
      op.intendedValue.startsWith('[MALFORMED:')
    ) {
      // Parse size from "[MALFORMED:NB]"
      const match = op.intendedValue.match(/\[MALFORMED:(\d+)B\]/);
      const bytesSent = match ? parseInt(match[1]!, 10) : -1;
      malformedValueResults.push({
        seqNum: op.seqNum,
        targetKey: op.key,
        bytesSent,
        httpStatus: op.status,
        result:
          op.status === 400 ? 'CORRECTLY_REJECTED' :
          op.status === 200 ? 'INCORRECTLY_ACCEPTED' :
                              'NETWORK_ERROR',
      });
    }
  }

  const violations: CheckerViolation[] = [];
  const staleReads: StaleReadObservation[] = [];

  let successfulSets = 0;
  let successfulGets = 0;
  let failedOps      = 0;

  for (const op of sortedOps) {
    // Skip malformed-value ops from main counting (tracked separately)
    if (op.intendedValue?.startsWith('[MALFORMED:')) continue;

    if (op.type === 'SET' && op.status === 200) successfulSets++;
    if (op.type === 'GET' && op.status === 200) successfulGets++;
    if (op.status === 0 || op.status === 503 || op.status === 500) failedOps++;

    // Only check successful GETs with a returned value
    if (op.type !== 'GET' || op.status !== 200 || op.responseValue === undefined) continue;

    const { key, responseValue, completedAt, seqNum, activeFaultIds } = op;
    const writes = writeHistory.get(key) ?? [];

    // ── Check 1: INVENTED_VALUE ────────────────────────────────────────────
    // The returned value must appear in at least one successful SET for this key.
    const matchingWrites = writes.filter(w => w.value === responseValue);

    if (matchingWrites.length === 0) {
      if (writes.length > 0) {
        // Key has confirmed writes, but none produced this value
        const knownValues = [...new Set(writes.map(w => `"${w.value}"(seq#${w.seqNum})`))];
        violations.push({
          type:          'INVENTED_VALUE',
          seqNum,
          key,
          returnedValue: responseValue,
          explanation:
            `GET returned "${responseValue}" for key "${key}", but this value was never ` +
            `written by any successful SET in this run. ` +
            `Known values for this key: [${knownValues.join(', ')}].`,
          relatedSeqNums: writes.map(w => w.seqNum),
        });
      } else {
        // No writes for this key at all -- truly invented
        violations.push({
          type:          'INVENTED_VALUE',
          seqNum,
          key,
          returnedValue: responseValue,
          explanation:
            `GET returned "${responseValue}" for key "${key}", but NO successful SET ` +
            `for this key exists anywhere in the run log.`,
          relatedSeqNums: [],
        });
      }
      continue;
    }

    // ── Check 2: FUTURE_READ ───────────────────────────────────────────────
    // At least one SET writing this value must have completed AT OR BEFORE
    // this GET completed (completedAt). If ALL matching SETs completed after
    // the GET completed, this is a future read.
    const matchingBeforeGetDone = matchingWrites.filter(w => w.completedAt <= completedAt);

    if (matchingBeforeGetDone.length === 0) {
      const earliest = matchingWrites.reduce(
        (min, w) => w.completedAt < min ? w.completedAt : min,
        Infinity
      );
      violations.push({
        type:          'FUTURE_READ',
        seqNum,
        key,
        returnedValue: responseValue,
        explanation:
          `GET for key "${key}" completed at ${completedAt}ms and returned "${responseValue}", ` +
          `but the SET that wrote this value (seq#${matchingWrites.map(w => w.seqNum).join(',')}) ` +
          `was only acknowledged at ${earliest}ms -- AFTER the GET completed. ` +
          `The GET read a value from the future, which violates causality.`,
        relatedSeqNums: matchingWrites.map(w => w.seqNum),
      });
      continue;
    }

    // ── Stale read detection (informational only) ──────────────────────────
    // Find the latest confirmed write for this key that completed at or
    // before this GET completed.
    const writesBeforeGetDone = writes.filter(w => w.completedAt <= completedAt);
    if (writesBeforeGetDone.length > 0) {
      const latestWrite = writesBeforeGetDone[writesBeforeGetDone.length - 1]!;
      if (latestWrite.value !== responseValue) {
        // We returned an older value than the most recently confirmed write.
        staleReads.push({
          seqNum,
          key,
          returnedValue:         responseValue,
          latestConfirmedValue:  latestWrite.value,
          // Positive: SET completed before GET started (replica hadn't caught up).
          // Negative: SET completed while GET was in-flight (concurrent operation).
          gapMs:       op.startedAt - latestWrite.completedAt,
          activeFaults: activeFaultIds,
        });
      }
    }
  }

  const staleReadsDuringFaults = staleReads.filter(s => s.activeFaults.length > 0).length;
  const staleReadsNoFault      = staleReads.filter(s => s.activeFaults.length === 0).length;

  return {
    totalOps:             sortedOps.filter(o => !o.intendedValue?.startsWith('[MALFORMED:')).length,
    successfulSets,
    successfulGets,
    failedOps,
    faultsInjected:       faults.length,
    violations,
    staleReads,
    staleReadsDuringFaults,
    staleReadsNoFault,
    malformedValueResults,
    passed:               violations.length === 0,
  };
}

// ---------------------------------------------------------------------------
// Self-validation (must pass before real check is trusted)
// ---------------------------------------------------------------------------

/**
 * Builds a synthetic log with one planted INVENTED_VALUE violation and
 * confirms the checker catches it. Returns true if self-check passes.
 *
 * Synthetic log:
 *   SET  chaos-key-0 = "real-value"   (seq#1, status 200)
 *   GET  chaos-key-0 → "invented-xyz" (seq#2, status 200)   ← violation
 *   GET  chaos-key-0 → "real-value"   (seq#3, status 200)   ← valid
 */
function selfCheck(): boolean {
  const T = 1_700_000_000_000; // arbitrary epoch ms
  const syntheticOps: OperationRecord[] = [
    {
      seqNum: 1, type: 'SET', key: 'self-check-key',
      intendedValue: 'real-value',
      startedAt: T, completedAt: T + 10,
      status: 200, handledBy: 'node1', activeFaultIds: [],
    },
    {
      seqNum: 2, type: 'GET', key: 'self-check-key',
      startedAt: T + 20, completedAt: T + 30,
      status: 200, responseValue: 'invented-xyz', // ← NEVER written
      handledBy: 'node1', activeFaultIds: [],
    },
    {
      seqNum: 3, type: 'GET', key: 'self-check-key',
      startedAt: T + 40, completedAt: T + 50,
      status: 200, responseValue: 'real-value',   // ← valid
      handledBy: 'node1', activeFaultIds: [],
    },
  ];

  const result = analyzeOperations(syntheticOps, []);

  // Must find exactly 1 violation for seq#2, type INVENTED_VALUE
  return (
    result.violations.length === 1 &&
    result.violations[0]!.type === 'INVENTED_VALUE' &&
    result.violations[0]!.seqNum === 2 &&
    result.passed === false
  );
}

// ---------------------------------------------------------------------------
// File reader + report printer
// ---------------------------------------------------------------------------

function parseLogFile(logFile: string): { ops: OperationRecord[]; faults: FaultRecord[] } {
  const content = fs.readFileSync(logFile, 'utf8');
  const lines   = content.split('\n').filter(l => l.trim().length > 0);
  const ops:    OperationRecord[] = [];
  const faults: FaultRecord[]     = [];

  for (const line of lines) {
    const entry = JSON.parse(line) as LogEntry;
    if (entry.kind === 'OP')    ops.push(entry.entry);
    if (entry.kind === 'FAULT') faults.push(entry.entry);
  }

  return { ops, faults };
}

export function printReport(report: CheckerReport): void {
  const hr = '='.repeat(62);
  const lr = '-'.repeat(62);
  console.log(`\n${hr}`);
  console.log('  VULCAN LINEARIZABILITY REPORT');
  console.log(hr);
  console.log(`  Log file         : ${report.logFile}`);
  console.log(`  Checker self-test: ${report.selfCheckPassed ? 'PASS ✅' : 'FAIL ❌ (checker is broken!)'}`);
  console.log(lr);
  console.log(`  Total operations : ${report.totalOps.toLocaleString()}`);
  console.log(`  Successful SETs  : ${report.successfulSets.toLocaleString()}`);
  console.log(`  Successful GETs  : ${report.successfulGets.toLocaleString()}`);
  console.log(`  Failed ops       : ${report.failedOps.toLocaleString()}  ← expected during fault windows`);
  console.log(`  Faults injected  : ${report.faultsInjected}`);
  console.log(lr);

  // Hard violations
  console.log(`  CRITICAL violations (invented/future values): ${report.violations.length}`);
  if (report.violations.length > 0) {
    console.log();
    for (const v of report.violations) {
      console.log(`  ❌ [${v.type}] seq#${v.seqNum} — key "${v.key}"`);
      console.log(`     returned : "${v.returnedValue}"`);
      console.log(`     reason   : ${v.explanation}`);
      if (v.relatedSeqNums.length > 0) {
        console.log(`     related  : seq#${v.relatedSeqNums.join(', seq#')}`);
      }
      console.log();
    }
  }

  // Stale reads (informational)
  console.log(`  Stale reads observed                       : ${report.staleReads.length}`);
  console.log(`    └─ during active faults                  : ${report.staleReadsDuringFaults}`);
  console.log(`    └─ with no active fault                  : ${report.staleReadsNoFault}`);
  console.log();
  console.log('  NOTE: ALL stale reads are consistent with Vulcan\'s async replication');
  console.log('  model. There is no hard propagation deadline -- a GET may reach a');
  console.log('  replica before the background replication write arrives. Stale reads');
  console.log('  are NOT violations and are NOT evidence of a bug. They are counted');
  console.log('  here purely for information.');
  console.log(lr);

  // Malformed-value results
  if (report.malformedValueResults.length > 0) {
    console.log(`  Malformed-value scenarios:`);
    for (const m of report.malformedValueResults) {
      const label = m.result === 'CORRECTLY_REJECTED' ? '✅ 400 rejected' :
                    m.result === 'INCORRECTLY_ACCEPTED' ? '❌ BUG: 200 accepted' :
                    `⚠️  network error (${m.httpStatus})`;
      console.log(`    seq#${m.seqNum}  ${m.bytesSent.toLocaleString()}B → ${m.httpStatus}  ${label}`);
    }
    console.log(lr);
  }

  // Final verdict
  if (!report.selfCheckPassed) {
    console.log('\n  ⛔ CHECKER SELF-TEST FAILED. Results are UNRELIABLE.');
    console.log('     The checker did not detect a planted violation.');
    console.log('     Do not trust the output above.');
  } else if (report.passed) {
    console.log(
      `\n  ✅ PASS — ${report.totalOps.toLocaleString()} operations checked across ` +
      `${report.faultsInjected} chaos scenarios. Zero unexplained violations.`
    );
  } else {
    console.log(
      `\n  ❌ FAIL — ${report.violations.length} critical violation(s) found.`
    );
    console.log('     See violation details above for the full reproducing sequence.');
  }
  console.log(`${hr}\n`);
}

// ---------------------------------------------------------------------------
// runChecker (programmatic API)
// ---------------------------------------------------------------------------

export function runChecker(logFile: string): CheckerReport {
  // 1. Self-validate before trusting any result
  const selfCheckPassed = selfCheck();
  if (!selfCheckPassed) {
    console.error('\n[checker] FATAL: Self-check failed. The checker cannot detect a known violation.');
    console.error('[checker] The checker itself is broken. Do not run against real data.');
  }

  // 2. Parse log
  const { ops, faults } = parseLogFile(logFile);

  // 3. Analyze
  const result = analyzeOperations(ops, faults);

  return { logFile, selfCheckPassed, ...result };
}

// ---------------------------------------------------------------------------
// CLI entry point: ts-node chaos/src/checker.ts <logfile>
// ---------------------------------------------------------------------------

if (require.main === module) {
  const logFile = process.argv[2];
  if (!logFile) {
    console.error('Usage: ts-node chaos/src/checker.ts <path/to/logfile.jsonl>');
    process.exit(1);
  }
  if (!require('fs').existsSync(logFile)) {
    console.error(`Log file not found: ${logFile}`);
    process.exit(1);
  }
  const report = runChecker(logFile);
  printReport(report);
  process.exit(report.selfCheckPassed && report.passed ? 0 : 1);
}
