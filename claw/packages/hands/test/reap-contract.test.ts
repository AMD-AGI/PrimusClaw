// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * What a reap reports, and what it refuses to do without.
 *
 * The counts are disjoint tallies of one outcome per addressed shell, read
 * after the escalation rather than at the moment of signalling: the size of the
 * addressed set would report a shell that ignored both signals as stopped, and
 * a run as finished over work that had not ended.
 *
 * Every reap also says why. A reclaim nobody can attribute is indistinguishable
 * afterwards from work that ended on its own, so a request missing its cause or
 * its operation is refused rather than defaulted -- and a grace outside the
 * stated domain is refused rather than clamped, a silently shortened one
 * destroying work about to flush and a lengthened one stalling a terminal path.
 */
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mintScopeCredential } from "@claw/utils";

process.env.WORKSPACE_PATH = tmpdir();
process.env.BG_SHELL_ENABLED = "true";
process.env.BG_SHELL_REAP_DELAY_MS = "10";
process.env.AUTH_CLAW_TOKEN = "test-internal-token";
process.env.HANDS_STATE_DIR = mkdtempSync(join(tmpdir(), "claw-reap-"));
if (!process.argv.includes("--self-check")) process.argv.push("--self-check");

const { app } = await import("../src/index.js");
const bg = await import("../src/tools/shell/bg-manager.js");
const { isolatingSandbox, releaseSandboxIsolation } =
  await import("./support/sandbox-isolation.js");
isolatingSandbox();

const TOKEN = "test-internal-token";
const OWNER = "sess-reap";
const RUN = "ktsk_1";

const proving = (owner: string, run: string | null) => ({
  authorization: `Bearer ${mintScopeCredential({ owner, run }, TOKEN)}`,
});

const reap = (body: Record<string, unknown>, owner = OWNER, run: string | null = RUN) =>
  app.inject({
    method: "POST", url: "/internal/shells/reap", headers: proving(owner, run), payload: body,
  });

const WELL_FORMED = { cause: "dag_node_terminal", reclaim_op: "task-1:dag_node_terminal" };

after(async () => {
  releaseSandboxIsolation();
  await bg.shutdownAllShells(200);
  await app.close();
  rmSync(process.env.HANDS_STATE_DIR!, { recursive: true, force: true });
});

test("a reap missing its cause or its operation is refused, naming the field", async () => {
  for (const [field, error] of [["cause", "cause_required"], ["reclaim_op", "reclaim_op_required"]]) {
    const body: Record<string, unknown> = { ...WELL_FORMED };
    delete body[field];
    const res = await reap(body);
    assert.equal(res.statusCode, 400, `a reap with no ${field} was served`);
    assert.equal(res.json().error, error);
    assert.equal(res.json().field, field);
  }
  // An empty value is no value: it names nothing and attributes nothing.
  assert.equal((await reap({ ...WELL_FORMED, cause: "" })).statusCode, 400);
});

test("a cause outside the closed vocabulary is refused, and the vocabulary is named", async () => {
  // The client declares a closed set; a server taking any non-empty string
  // leaves the two free to drift, and an attribution nothing recognises is
  // indistinguishable at read time from one nobody wrote.
  for (const cause of ["rollback", "because", "DAG_NODE_TERMINAL", 7]) {
    const res = await reap({ ...WELL_FORMED, cause });
    assert.equal(res.statusCode, 400, `cause=${JSON.stringify(cause)} was accepted`);
    assert.equal(res.json().error, "cause_required");
    assert.ok(Array.isArray(res.json().accepted), "the refusal names what would be accepted");
  }
  for (const cause of ["dag_node_terminal", "run_cancelled", "sandbox_replaced"]) {
    assert.equal((await reap({ ...WELL_FORMED, cause })).statusCode, 200, cause);
  }
});

test("a grace outside the domain is refused, never clamped", async () => {
  for (const grace of [0, -1, 249, 60_001, 1.5, "2000", null]) {
    const res = await reap({ ...WELL_FORMED, grace_ms: grace });
    assert.equal(res.statusCode, 400, `grace_ms=${JSON.stringify(grace)} was accepted`);
    assert.equal(res.json().error, "grace_out_of_range");
    assert.equal(res.json().field, "grace_ms");
  }
  // Both ends of the stated range are inside it.
  for (const grace of [250, 60_000]) {
    assert.equal((await reap({ ...WELL_FORMED, grace_ms: grace })).statusCode, 200);
  }
});

test("the counts are disjoint tallies of one outcome per addressed shell", async () => {
  bg.spawnBackground(OWNER, RUN, "sleep 60", "a");
  bg.spawnBackground(OWNER, RUN, "sleep 60", "b");

  const res = await reap({ ...WELL_FORMED, grace_ms: 250 });
  assert.equal(res.statusCode, 200);
  const body = res.json();

  assert.equal(
    body.stopped + body.escalated + body.surviving,
    body.shells.length,
    "the three counts must partition the addressed set exactly",
  );
  assert.equal(body.shells.length, 2, "both siblings were addressed");
  for (const shell of body.shells) {
    assert.ok(["stopped", "escalated", "surviving"].includes(shell.outcome));
    assert.equal(shell.run_identity, RUN);
    assert.ok(shell.signalled_at, "each entry carries when it was signalled");
  }
  assert.equal(
    body.shells.filter((s: { outcome: string }) => s.outcome === "stopped").length,
    body.stopped,
    "each count matches the entries carrying that outcome",
  );
});

test("a run that started nothing reports an empty set rather than refusing", async () => {
  const res = await reap(WELL_FORMED, OWNER, "ktsk_never_ran");
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json(), { stopped: 0, escalated: 0, surviving: 0, shells: [] });
});

test("a shell that ignores both signals is surviving, not stopped", async () => {
  const report = await bg.shutdownRunShells(OWNER, "ktsk_absent", 250);
  assert.deepEqual(report, { stopped: 0, escalated: 0, surviving: 0, shells: [] });

  // A process that genuinely ignores SIGTERM, so the group is still alive when
  // the grace runs out. SIGKILL cannot be ignored, so it ends there -- which is
  // `escalated`, and reporting it as `stopped` is the failure this pins.
  bg.spawnBackground(
    OWNER, "ktsk_stubborn",
    // `trap ''` sets the disposition to ignore, and an ignored signal survives
    // the exec into `sleep`, so the group is still alive when the grace ends.
    "trap '' TERM; sleep 1000",
    "stubborn",
  );
  await new Promise((r) => setTimeout(r, 400));
  const stubborn = await bg.shutdownRunShells(OWNER, "ktsk_stubborn", 250);
  assert.equal(stubborn.shells.length, 1);
  // It ignored SIGTERM, so it took the escalation. SIGKILL cannot be trapped,
  // so it ends there -- which is `escalated` and never `stopped`.
  assert.equal(stubborn.shells[0].outcome, "escalated");
  assert.equal(stubborn.escalated, 1);
  assert.equal(stubborn.stopped, 0);
});

test("a repeated reap addresses whatever is still there rather than reporting a stale zero", async () => {
  bg.spawnBackground(OWNER, "ktsk_repeat", "sleep 60", "first");
  const first = await bg.shutdownRunShells(OWNER, "ktsk_repeat", 250);
  assert.equal(first.shells.length, 1);

  // Nothing left, so the repeat is honest about that -- and a shell registered
  // since is addressed again rather than suppressed on the grounds that an
  // earlier call answered.
  assert.equal((await bg.shutdownRunShells(OWNER, "ktsk_repeat", 250)).shells.length, 0);
  bg.spawnBackground(OWNER, "ktsk_repeat", "sleep 60", "second");
  assert.equal((await bg.shutdownRunShells(OWNER, "ktsk_repeat", 250)).shells.length, 1);
});
