// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * What `repeat.until.equals` is allowed to be.
 *
 * The loop is decided by `repeatSatisfied` in Brain, which compares the tool's
 * structured field to this value with `===`. That makes the set of usable
 * values exactly the primitives: an object or an array compares by identity and
 * is therefore unequal to every value a JSON result could ever carry, and NaN is
 * not equal to itself either.
 *
 * A condition that can never hold is not refused at runtime -- it is run. The
 * step repeats until max_attempts, max_seconds, or the 72h ceiling stops it,
 * which for the jobs this feature exists for means a day of a GPU reservation
 * spent on a comparison that was never going to succeed. The declared type says
 * `string | number | boolean`; a JSON request body is not bound by a TypeScript
 * type, so admission is where it has to be enforced.
 *
 * Coverage:
 *   R1 an object `equals` is refused
 *   R2 an array `equals` is refused
 *   R3 NaN and Infinity are refused
 *   R4 each of the three usable kinds is still admitted
 *   R5 a missing `equals` is still refused, as before
 */
import test, { after } from "node:test";
import assert from "node:assert/strict";

import { db } from "../src/infra/db.js";
import { validateDag } from "../src/tasks/dags/admission.js";
import type { TaskDagDef } from "../src/tasks/dags/types.js";

// `wait` is a Hands builtin, so tool-meta resolution needs no tools row. The
// stub is here only so a lookup that did happen fails loudly rather than
// reaching a database.
const originalQuery = db.query;
db.query = (async () => { throw new Error("admission must not need the database here"); }) as typeof db.query;
after(() => { db.query = originalQuery; });

/** A one-node script DAG whose only step repeats until `equals`. */
function dagRepeatingUntil(equals: unknown): TaskDagDef {
  return {
    dag_id: "dag-repeat",
    name: "repeat",
    nodes: [{
      id: "n1",
      executor: "brain",
      mode: "script",
      sandbox: "shared",
      script: [{
        name: "wait",
        arguments: { shell_id: "trainer" },
        repeat: {
          until: { path: "finished", equals },
          max_attempts: 10,
          max_seconds: 600,
        },
      }],
    }],
  } as unknown as TaskDagDef;
}

test("R1 an object equals is refused rather than looped against", async () => {
  await assert.rejects(
    () => validateDag(dagRepeatingUntil({ finished: true })),
    /until\.equals must be a string, number, or boolean/,
  );
});

test("R2 an array equals is refused", async () => {
  await assert.rejects(
    () => validateDag(dagRepeatingUntil([true])),
    /until\.equals must be a string, number, or boolean/,
  );
});

test("R3 NaN and Infinity are refused, since neither can be reached", async () => {
  // NaN passes `typeof === "number"` and is not equal to itself, so it is the
  // one number that behaves exactly like the object case.
  await assert.rejects(
    () => validateDag(dagRepeatingUntil(Number.NaN)),
    /until\.equals must be a finite number/,
  );
  await assert.rejects(
    () => validateDag(dagRepeatingUntil(Number.POSITIVE_INFINITY)),
    /until\.equals must be a finite number/,
  );
});

test("R4 the three kinds a comparison can actually match are admitted", async () => {
  for (const value of [true, "done", 0, 7, -1.5, ""]) {
    await assert.doesNotReject(
      () => validateDag(dagRepeatingUntil(value)),
      `${JSON.stringify(value)} is a value a structured result can carry`,
    );
  }
});

test("R5 an absent equals is still refused", async () => {
  await assert.rejects(
    () => validateDag(dagRepeatingUntil(undefined)),
    /until\.equals must be a string, number, or boolean/,
  );
  await assert.rejects(
    () => validateDag(dagRepeatingUntil(null)),
    /until\.equals must be a string, number, or boolean/,
  );
});
