// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The rollback's two routes answer the same way with the feature on as off.
 *
 * internal-shells-routes-flag-off asks the closed state whether it still counts
 * and reaps, authenticates, and refuses a scope named in a body. This asks the
 * open state the same questions, so the pair says those answers do not depend
 * on the flag -- which is what a rollback relies on, since it flips the flag
 * while shells started under the previous configuration are still running.
 *
 * The half only this side can show is the one that matters most: with shells
 * actually running, the reap ends them and the count follows. A zero from a
 * sandbox that never started anything is the same text as a route that stopped
 * answering, so the closed state alone cannot pin the termination path.
 *
 * Its own file because the flag is read at module load and the runner gives
 * each file its own process.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mintScopeCredential } from "@claw/utils";

process.env.WORKSPACE_PATH = tmpdir();
process.env.BG_SHELL_ENABLED = "true";
process.env.BG_SHELL_REAP_DELAY_MS = "10";
process.env.AUTH_CLAW_TOKEN = "test-internal-token";
process.env.HANDS_STATE_DIR = mkdtempSync(join(tmpdir(), "claw-parity-"));
// Gates the listen at the bottom of index.ts, so importing it binds no port.
if (!process.argv.includes("--self-check")) process.argv.push("--self-check");

const { app } = await import("../src/index.js");
const { MIN_REAP_GRACE_MS, spawnBackground, shutdownAllShells } =
  await import("../src/tools/shell/bg-manager.js");

const { isolatingSandbox } = await import("./support/sandbox-isolation.js");
isolatingSandbox();

const TOKEN = "test-internal-token";
const OWNER = "sess-parity";
const RUN = "ktsk_parity";
/** Why this reap is happening and which operation it belongs to, both required. */
// A cause from the closed vocabulary: the route refuses anything outside it, so
// a rollback names the act it is performing rather than the procedure it is part of.
const ATTRIBUTED = { cause: "sandbox_replaced", reclaim_op: "op-parity", grace_ms: MIN_REAP_GRACE_MS };

const proving = (owner: string, run: string | null = null) => ({
  authorization: `Bearer ${mintScopeCredential({ owner, run }, TOKEN)}`,
});

function post(url: string, headers: Record<string, string>, payload: unknown = {}) {
  return app.inject({ method: "POST", url, headers, payload: payload as object });
}

test.after(async () => {
  await shutdownAllShells(MIN_REAP_GRACE_MS);
  await app.close();
  rmSync(process.env.HANDS_STATE_DIR!, { recursive: true, force: true });
});

test("an owner with nothing running is answered zero, not refused", async () => {
  const res = await post("/internal/shells/active", proving("sess-quiet"));

  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json(), { running: 0 });
});

test("a run that started nothing is reaped as a no-op, not as an error", async () => {
  const res = await post("/internal/shells/reap", proving("sess-quiet", "ktsk_quiet"), ATTRIBUTED);

  assert.equal(res.statusCode, 200);
  assert.equal(res.json().stopped, 0);
  assert.equal(res.json().surviving, 0);
});

test("the same routes count and end work that is actually running", async () => {
  spawnBackground(OWNER, RUN, "sleep 60", "bg-parity");
  assert.deepEqual((await post("/internal/shells/active", proving(OWNER, RUN))).json(),
    { running: 1 });

  const reap = await post("/internal/shells/reap", proving(OWNER, RUN), ATTRIBUTED);
  assert.equal(reap.statusCode, 200);
  assert.equal(reap.json().surviving, 0, "a shell that ignored both signals is not a reap");
  assert.equal(reap.json().stopped + reap.json().escalated, 1);

  assert.deepEqual((await post("/internal/shells/active", proving(OWNER, RUN))).json(),
    { running: 0 },
    "the count the rollback polls to zero has to follow the termination it just made");
});

test("neither route reads a scope out of the body with the feature on either", async () => {
  // The boundary does not move with the flag: a body field naming a scope would
  // let a rollback count and terminate somebody else's work.
  for (const url of ["/internal/shells/active", "/internal/shells/reap"]) {
    const res = await post(url, proving(OWNER, RUN), { ...ATTRIBUTED, owner: "sess-other" });
    assert.equal(res.statusCode, 400, `${url} read a scope out of the body`);
    assert.deepEqual(res.json(), { error: "scope_not_in_body", field: "owner" });

    assert.equal((await post(url, {})).statusCode, 401, `${url} served an unauthenticated caller`);
    assert.equal((await post(url, { authorization: `Bearer ${TOKEN}` })).statusCode, 401,
      `${url} accepted the bare sandbox token, which names no scope`);
  }

  // The absent-run bucket holds every shell started without a run identity,
  // which is exactly the set nothing may end by run.
  const reap = await post("/internal/shells/reap", proving(OWNER), ATTRIBUTED);
  assert.equal(reap.statusCode, 400);
  assert.equal(reap.json().error, "run_required");
});
