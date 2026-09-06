// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * NF9 -- a tightened foreground ceiling has to emit something an operator can
 * read.
 *
 * The rollout's stop condition for "commands that used to complete now hit the
 * ceiling" was a killed-run count, which is not a foreground-timeout signal at
 * all: Hands answers a clamped command with a tool result, Brain's ordinary
 * call path discards the error flag, and the run goes on to complete normally.
 * So the affected runs are indistinguishable from unaffected ones in every
 * terminal fact the platform exposes, and the count moves for unrelated
 * reasons.
 *
 * The signal is now emitted where the timeout happens and carried as a field,
 * not as prose a reword can silence.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { countForegroundTimeout } from "../src/clients/hands.js";
import { registry } from "../src/infra/metrics.js";

const METRIC = "claw_bash_foreground_timeout_total";

async function counted(clamped: "true" | "false"): Promise<number> {
  const metric = (await registry.getMetricsAsJSON())
    .find((m) => m.name === METRIC) as { values?: Array<{ labels: Record<string, string>; value: number }> };
  return metric?.values?.find((v) => v.labels.clamped === clamped)?.value ?? 0;
}

test("a clamped foreground timeout is counted as one, and says it was clamped", async () => {
  const before = await counted("true");
  countForegroundTimeout({
    isError: true,
    content: [{ type: "text", text: "timeout after 120s (killed the whole process group…)" }],
    structuredContent: { outcome: "foreground_timeout", granted_sec: 120, clamped: true },
  });

  assert.equal(await counted("true"), before + 1,
    "this is the regression a rollout watches for: a command that asked past the "
      + "ceiling and met it");
});

test("a command that simply ran out of its own timeout is counted apart", async () => {
  const beforeClamped = await counted("true");
  const before = await counted("false");
  countForegroundTimeout({
    isError: true,
    structuredContent: { outcome: "foreground_timeout", granted_sec: 5, clamped: false },
  });

  assert.equal(await counted("false"), before + 1);
  assert.equal(await counted("true"), beforeClamped,
    "nothing was reduced here, so it is not evidence about the ceiling");
});

test("an ordinary result moves nothing", async () => {
  const before = [await counted("true"), await counted("false")];
  countForegroundTimeout({ content: [{ type: "text", text: "hello" }] });
  countForegroundTimeout({ isError: true, structuredContent: { outcome: "exit_nonzero" } });
  countForegroundTimeout(undefined);

  assert.deepEqual([await counted("true"), await counted("false")], before);
});

test("the signal is a field, so a reworded timeout message cannot silence it", async () => {
  const before = await counted("true");
  countForegroundTimeout({
    isError: true,
    content: [{ type: "text", text: "a completely different sentence" }],
    structuredContent: { outcome: "foreground_timeout", granted_sec: 120, clamped: true },
  });
  assert.equal(await counted("true"), before + 1);
});
