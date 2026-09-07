// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Evaluate `config.js` under this process's environment and report the verdict.
 *
 * The eight `ADMIT_*` constants and both cross-setting loops are module-scope
 * statements, so one configuration needs one process. The caller spawns this
 * file once per case with the environment already set. Not a `.test.ts`, so
 * `tsx --test test/*.test.ts` does not collect it.
 */
import { admissionSettingProblems, assertAdmissionSettings } from "../src/config.js";

const logged: Array<{ obj: unknown; msg: string }> = [];
let threw: string | null = null;
try {
  assertAdmissionSettings({ error: (obj, msg) => void logged.push({ obj, msg }) });
} catch (err) {
  threw = (err as Error).message;
}

// The sentinel lets the caller skip anything the loader or a transitive import
// wrote to stdout ahead of this line.
process.stdout.write(
  `\n@@ADMISSION@@${JSON.stringify({ problems: [...admissionSettingProblems()], threw, logged })}`,
);
