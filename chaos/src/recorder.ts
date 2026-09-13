/**
 * chaos/src/recorder.ts
 *
 * Append-only, synchronous JSONL log writer.
 *
 * Writes are synchronous (fs.writeSync) so that if the runner process
 * crashes mid-run, all operations up to the crash are persisted. Nothing
 * is buffered in memory between writes.
 *
 * Format: one JSON object per line (JSONL / newline-delimited JSON).
 * Each line is a LogEntry ({ kind: 'OP' | 'FAULT', entry: ... }).
 */

import * as fs from 'fs';
import * as path from 'path';
import type { LogEntry } from './types';

export class Recorder {
  private readonly fd: number;
  private writeCount = 0;

  constructor(logFile: string) {
    const dir = path.dirname(logFile);
    fs.mkdirSync(dir, { recursive: true });
    this.fd = fs.openSync(logFile, 'w');
  }

  /** Write one log entry synchronously. Thread-safe for a single Node.js process. */
  write(entry: LogEntry): void {
    const line = JSON.stringify(entry) + '\n';
    fs.writeSync(this.fd, line);
    this.writeCount++;
  }

  get entriesWritten(): number {
    return this.writeCount;
  }

  close(): void {
    fs.closeSync(this.fd);
  }
}
