// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/** The local audit trail: one JSON object per line, appended, never read back by the connector. */
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { redactDeep } from "./redact.js";
import { DiskQueue, type WriteReport } from "./statefile.js";
import { logLine } from "./util.js";

export interface Audit {
  record(kind: string, detail?: Record<string, unknown>): void;
  /** Resolves once every record made so far is written (or could not be). */
  flush?(): Promise<void>;
}

/** Lines waiting for a disk that does not answer, past which new ones are counted instead of kept. */
const MAX_WAITING = 10_000;

/**
 * Appended off the event loop, in order ({@link DiskQueue}): the trail sits in the state directory, and a disk that
 * stops answering must not stop the connector. Lines made while it is stuck wait in memory, up to {@link MAX_WAITING};
 * past that they are counted, and the count is written as a record of its own once the disk answers again.
 */
export function fileAudit(file: string, now: () => number = Date.now, report?: WriteReport): Audit {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const disk = new DiskQueue(report);
  let lost = 0;
  const append = (line: string, kind: string) => void disk.run(`appending to ${file}`, async () => {
    try {
      await fsp.appendFile(file, line + "\n", { mode: 0o600 });
    } catch {
      // An audit that cannot be written must not take the session down, but it must not be silent either.
      logLine(`audit write failed: ${kind}`);
    }
  });
  return {
    record(kind, detail = {}) {
      if (disk.backlog >= MAX_WAITING) { lost += 1; return; }
      if (lost) {
        append(JSON.stringify({ ts: new Date(now()).toISOString(), lost, kind: "audit_lines_lost" }), "audit_lines_lost");
        lost = 0;
      }
      // `kind` is written last so a detail field of the same name can never overwrite what the record is.
      append(JSON.stringify({ ts: new Date(now()).toISOString(), ...redactDeep(detail), kind }), kind);
    },
    flush: () => disk.idle(),
  };
}

/** For tests: keeps the records in memory. */
export function memoryAudit(): Audit & { records: Array<Record<string, unknown>> } {
  const records: Array<Record<string, unknown>> = [];
  return { records, record(kind, detail = {}) { records.push({ ...detail, kind }); } };
}
