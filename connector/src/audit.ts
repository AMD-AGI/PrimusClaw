// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/** The local audit trail: one JSON object per line, appended, never read back by the connector. */
import fs from "node:fs";
import path from "node:path";
import { redactDeep } from "./redact.js";

export interface Audit {
  record(kind: string, detail?: Record<string, unknown>): void;
}

export function fileAudit(file: string, now: () => number = Date.now): Audit {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  return {
    record(kind, detail = {}) {
      // `kind` is written last so a detail field of the same name can never overwrite what the record is.
      const line = JSON.stringify({ ts: new Date(now()).toISOString(), ...redactDeep(detail), kind });
      try {
        fs.appendFileSync(file, line + "\n", { mode: 0o600 });
      } catch {
        // An audit that cannot be written must not take the session down, but it must not be silent either.
        process.stderr.write(`audit write failed: ${kind}\n`);
      }
    },
  };
}

/** For tests: keeps the records in memory. */
export function memoryAudit(): Audit & { records: Array<Record<string, unknown>> } {
  const records: Array<Record<string, unknown>> = [];
  return { records, record(kind, detail = {}) { records.push({ ...detail, kind }); } };
}
