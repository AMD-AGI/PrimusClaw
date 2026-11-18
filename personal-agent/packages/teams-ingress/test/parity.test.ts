// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Parity with the Python Function the ingress replaces: every case of test/parity/cases.ts (the input surface of every
 * Python test, and the edges around it) goes through the ingress, and its answer is compared field by field with what
 * the Python Function answered for the same request, recorded in test/parity/python-answers.json: the HTTP status and
 * body bytes, every queued message (body, content type, correlation, session and message ids, queue, connection), the
 * Service Bus client built, every Bot Connector call, the outbound trigger's error, the log records (the security
 * events included) and the requests made to the OpenID/JWKS/identity server. A case in EXPECTED differs in the fields
 * listed there, for the reason given; any other difference fails. No log record may hold the bearer token.
 *
 * python-answers.json was recorded by running the same cases through the Python Function (the one in service when this
 * package was written) and is not regenerated here: the Python Function is not part of this repository.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { b64url, HERE, rsaKey } from "./helpers.js";
import { buildCases, EXPECTED } from "./parity/cases.js";
import { type Answer, differences, normalise } from "./parity/compare.js";
import { type Case, runCase } from "./parity/driver.js";
import { parityServer } from "./parity/server.js";

interface Recorded {
  readonly cases: Readonly<Record<string, Answer>>;
}

const RECORDED = JSON.parse(readFileSync(join(HERE, "parity", "python-answers.json"), "utf8")) as Recorded;

function tokensIn(c: Case): string[] {
  const header = Object.entries(c.headers ?? {}).find(([k]) => k.toLowerCase() === "authorization")?.[1] ?? "";
  const token = header.split(" ").slice(1).join(" ").trim();
  return token.length >= 16 ? [token, ...token.split(".").filter((part) => part.length >= 16)] : [];
}

test("every case answers as the Python Function did, but for the documented differences", async () => {
  const key = rsaKey();
  const other = rsaKey();
  const server = await parityServer(key, other);
  try {
    const cases = buildCases({ key, otherKey: other, b64url }).map((c) => ({
      ...c,
      env: Object.fromEntries(Object.entries(c.env).map(([k, v]) => [k, v.replaceAll("{base}", server.base)])),
    }));
    assert.deepEqual(cases.map((c) => c.name).sort(), Object.keys(RECORDED.cases).sort(), "the recorded cases");
    const unexpected: string[] = [];
    for (const c of cases) {
      server.take();
      const result = await runCase(c);
      const answer = normalise(result, server.take());
      const python = Object.hasOwn(RECORDED.cases, c.name) ? RECORDED.cases[c.name] : undefined;
      assert.ok(python !== undefined && result.driverError === undefined, `${c.name}: ${result.driverError ?? ""}`);
      const diff = differences(python, answer);
      const known = Object.hasOwn(EXPECTED, c.name) ? EXPECTED[c.name] : undefined;
      if (JSON.stringify(diff) !== JSON.stringify(known?.fields ?? [])) {
        unexpected.push(`${c.name}: differs in [${diff.join(", ")}], expected [${(known?.fields ?? []).join(", ")}]`);
      }
      const leaked = tokensIn(c).filter((t) => result.everything.includes(t));
      if (leaked.length > 0) unexpected.push(`${c.name}: the bearer token is in a log record`);
    }
    assert.deepEqual(unexpected, []);
  } finally {
    await server.close();
  }
});
