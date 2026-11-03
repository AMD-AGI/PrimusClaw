// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The built-in GitHub write rules, through the real engine of a deployment that
 * configured no bash rule of its own and no approval channel: a shell write to
 * GitHub is held (and, with nobody to ask, not run), a read or a plain branch
 * push runs. `bash-approval-defaults-off.test.ts` is the same deployment with
 * the defaults turned off.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

delete process.env.BASH_APPROVAL_RULES;
delete process.env.BASH_APPROVAL_DEFAULTS_ENABLED;

import { startWorld, fakeHands, baseRequest } from "./support/platform-defaults-world.js";
import { DEFAULT_BASH_APPROVAL_RULES } from "../src/agent/bash-approval-defaults.js";

const world = await startWorld();
const { AgentEngine } = await import("../src/agent/engine.js");
test.after(async () => { await world.close(); });

async function runBash(command: string, session: string) {
  world.script([{ tool: "bash", input: { command } }, { text: "done" }]);
  world.llmBodies.length = 0;
  const hands = fakeHands();
  await new AgentEngine().execute(
    baseRequest({ session_id: session }), (async () => {}) as never, undefined, null as never,
    { attachHands: async () => hands as never } as never,
  );
  return { ran: hands.calls.some((c) => c.name === "bash"), modelSaw: world.llmBodies[1] ?? "" };
}

const HELD = ["gh pr merge 12 --squash", "gh api -X DELETE repos/o/r/git/refs/heads/x", "git push --force origin main", "gh issue comment 3 --body hi"];
const RUNS = ["gh pr view 12", "git push origin feat/x", "ls -la"];

for (const command of HELD) {
  test(`held by default: ${command}`, async () => {
    const r = await runBash(command, `defaults-held-${HELD.indexOf(command)}`);
    assert.equal(r.ran, false, "the command never reached the sandbox");
    assert.match(r.modelSaw, /No approval channel is available, so this action required approval and was not executed/);
  });
}

for (const command of RUNS) {
  test(`runs by default: ${command}`, async () => {
    const r = await runBash(command, `defaults-runs-${RUNS.indexOf(command)}`);
    assert.equal(r.ran, true);
  });
}

test("the built-in rules are the outbound-actions pack's GitHub rules, verbatim", () => {
  const pack = JSON.parse(readFileSync(new URL("../../../examples/bash-approval/outbound-actions.json", import.meta.url), "utf8")) as Array<Record<string, string>>;
  const byLabel = new Map(pack.map((r) => [r.label, r]));
  for (const rule of DEFAULT_BASH_APPROVAL_RULES) assert.deepEqual(rule, byLabel.get(rule.label), rule.label);
  const github = pack.filter((r) => r.program === "gh" || r.label.startsWith("git push --force")).map((r) => r.label);
  assert.deepEqual(DEFAULT_BASH_APPROVAL_RULES.map((r) => r.label), github, "every GitHub write rule of the pack, and nothing else");
});
