// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The crash path both designs exist to close.
 *
 * Background children are spawned detached so they survive the request that
 * started them; they survive the Hands process too. The in-process registry
 * does not. Asked that registry after a restart, a sandbox with a training run
 * still writing answers zero active shells, the keepalive sweep files it idle,
 * and the control plane reclaims the pod out from under the work -- which is
 * the exact failure `run_in_background` was moved onto this path to avoid.
 *
 * A real process is spawned here, and a restart is simulated the way one
 * actually presents: the durable records stay, a new epoch marker is minted,
 * and the registry starts empty.
 */
import test, { after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { mintScopeCredential } from "@claw/utils";
import { join } from "node:path";

process.env.WORKSPACE_PATH = tmpdir();
process.env.BG_SHELL_ENABLED = "true";
process.env.HANDS_STATE_DIR = mkdtempSync(join(tmpdir(), "claw-liveness-"));
process.env.AUTH_CLAW_TOKEN = "test-internal-token";
if (!process.argv.includes("--self-check")) process.argv.push("--self-check");
const records = await import("../src/runtime/shell-records.js");
const { ownerLiveness } = await import("../src/runtime/shell-liveness.js");
const { runningShellCount } = await import("../src/tools/shell/bg-manager.js");
const { app } = await import("../src/index.js");

const { isolatingSandbox } = await import("./support/sandbox-isolation.js");
isolatingSandbox();

const OWNER = "sess-restart";
const RUN = "ktsk_1";
const survivors: ChildProcess[] = [];

after(async () => {
  for (const child of survivors) child.kill("SIGKILL");
  await app.close();
  rmSync(process.env.HANDS_STATE_DIR!, { recursive: true, force: true });
});

beforeEach(() => {
  rmSync(process.env.HANDS_STATE_DIR!, { recursive: true, force: true });
  records.mintEpoch({ pid: process.pid, startToken: records.processStartToken(process.pid) });
});

/** A detached child, and the record the Hands that spawned it would have left. */
function spawnRecorded(shellId: string): ChildProcess {
  const child = spawn("/bin/sh", ["-c", "sleep 60"], { detached: true, stdio: "ignore" });
  child.unref();
  survivors.push(child);

  records.claimRecord({
    owner_scope: OWNER,
    run_identity: RUN,
    shell_id: shellId,
    command_digest: "d",
    kind: "background",
    claimed_at: new Date().toISOString(),
    hands_epoch: records.currentEpoch()!.epoch,
  });
  records.attachRecord(OWNER, RUN, shellId, {
    pid: child.pid!,
    startToken: records.processStartToken(child.pid!),
  });
  return child;
}

/** What a restart is, as the sandbox sees it: new epoch, empty registry. */
function restartHands(): void {
  records.mintEpoch({ pid: process.pid, startToken: records.processStartToken(process.pid) });
}

const emptyRegistry = () => false;

test("a shell that outlived the process that spawned it is still counted", async () => {
  const child = spawnRecorded("trainer");
  assert.equal(ownerLiveness(OWNER, () => true).active, 1, "sanity: counted before the restart");

  restartHands();

  const after = ownerLiveness(OWNER, emptyRegistry);
  assert.equal(after.determinate, true);
  assert.equal(after.active, 1,
    "the registry that knew this process died with it; answering zero here is "
      + "the sandbox being reclaimed out from under a live training run");
  assert.equal(after.classes.lost, 1,
    "honestly reported: nobody can collect its exit status any more, which is a "
      + "reason to say so rather than a reason to stop protecting it");

  child.kill("SIGKILL");
});

test("a shell that ended before the restart does not hold the sandbox open", async () => {
  // The other direction, and why the count cannot simply be "records exist": a
  // terminated process has no work left to protect, and counting its lingering
  // record would hold sandboxes open indefinitely.
  const child = spawnRecorded("finished");
  child.kill("SIGKILL");
  await new Promise((r) => child.once("exit", r));
  restartHands();

  const after = ownerLiveness(OWNER, emptyRegistry);
  assert.equal(after.active, 0);
  assert.equal(after.classes.ended_unreaped, 1);
});

test("a zombie is not work, so it does not hold the sandbox open", async () => {
  // The case presence cannot answer: an exited child whose parent has not
  // waited on it keeps its /proc entry and its start token, so every check
  // short of reading the process state reports it alive. Counted as work, one
  // of these holds a sandbox open for as long as its parent lives.
  // A shell parent is no good here: it reaps its own background children, and
  // Node's child_process does too. This parent provably never waits.
  const parent = spawn(
    "python3",
    ["-c", "import subprocess,time; print(subprocess.Popen(['/bin/true']).pid, flush=True); time.sleep(60)"],
    { detached: true, stdio: ["ignore", "pipe", "ignore"] },
  );
  survivors.push(parent);
  const zombiePid = await new Promise<number>((resolve, reject) => {
    parent.stdout!.once("data", (b: Buffer) => resolve(Number(b.toString().trim())));
    parent.once("error", (e) => reject(new Error(`cannot build a zombie: ${e.message}`)));
  });
  // The parent has to reach `sleep` before the child is reaped-by-nobody.
  await new Promise((r) => setTimeout(r, 200));

  records.claimRecord({
    owner_scope: OWNER, run_identity: RUN, shell_id: "zombie",
    command_digest: "d", kind: "background",
    claimed_at: new Date().toISOString(), hands_epoch: records.currentEpoch()!.epoch,
  });
  records.attachRecord(OWNER, RUN, "zombie", {
    pid: zombiePid, startToken: records.processStartToken(zombiePid),
  });

  assert.equal(existsSync(`/proc/${zombiePid}`), true,
    "sanity: the entry is still there, which is why presence is not the test");

  const live = ownerLiveness(OWNER, emptyRegistry);
  assert.equal(live.determinate, true);
  assert.equal(live.active, 0, "a zombie was counted as live work");
  assert.equal(live.classes.ended_unreaped, 1);

  parent.kill("SIGKILL");
});

test("a claim with no process yet still blocks reclamation after a restart", () => {
  // The crash between the claim and the spawn: nothing can say whether a
  // process exists, so the sandbox is kept rather than guessed at.
  records.claimRecord({
    owner_scope: OWNER, run_identity: RUN, shell_id: "half-started",
    command_digest: "d", kind: "background",
    claimed_at: new Date().toISOString(), hands_epoch: records.currentEpoch()!.epoch,
  });
  restartHands();

  const after = ownerLiveness(OWNER, emptyRegistry);
  assert.equal(after.active, 1);
  assert.equal(after.classes.spawn_indeterminate, 1);
});

test("the count Brain actually reads keeps a restarted sandbox's work", async () => {
  // The predicate is only half of it: what decides whether the pod survives is
  // the number the route answers with. A registry emptied by the restart must
  // not be what that number comes from.
  const child = spawnRecorded("trainer-route");
  restartHands();

  assert.equal(runningShellCount(OWNER), 1,
    "the in-memory map is empty after a restart and would have answered zero");

  const res = await app.inject({
    method: "POST",
    url: "/internal/shells/active",
    headers: { authorization: `Bearer ${mintScopeCredential({ owner: OWNER, run: null }, "test-internal-token")}` },
    payload: {},
  });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json(), { running: 1 });

  child.kill("SIGKILL");
});

test("an unreadable subtree answers unknown, never zero", async () => {
  // Falling back to the in-memory count is the same unsafe zero by another
  // route: after a restart that count is empty for reasons that say nothing
  // about the sandbox. The route reports that it cannot tell, and the sweep's
  // own unanswered-probe path keeps the sandbox.
  const child = spawnRecorded("trainer2");
  restartHands();
  rmSync(process.env.HANDS_STATE_DIR!, { recursive: true, force: true });

  assert.equal(ownerLiveness(OWNER, emptyRegistry).determinate, false);
  assert.equal(runningShellCount(OWNER), null, "not zero, and not a guess");

  const res = await app.inject({
    method: "POST",
    url: "/internal/shells/active",
    headers: { authorization: `Bearer ${mintScopeCredential({ owner: OWNER, run: null }, "test-internal-token")}` },
    payload: {},
  });
  assert.equal(res.statusCode, 503,
    "a status the caller turns into its own unanswered-probe case, which keeps "
      + "the sandbox rather than filing it idle");

  child.kill("SIGKILL");
});

test("one unreadable record makes the whole answer indeterminate, not smaller", async () => {
  // Skipped, that record's shell simply vanishes from a count that still reads
  // determinate -- so the sandbox is filed idle on the strength of a file
  // nobody could open, which is the same reclaim by another route.
  const child = spawnRecorded("readable");
  spawnRecorded("corrupt");
  const corruptPath = join(
    process.env.HANDS_STATE_DIR!, "scopes",
    ...["sess-restart", "ktsk_1", "corrupt"].map((p) => p.replace(/[^A-Za-z0-9_-]/g, (c) =>
      `~${c.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0")}`)),
  );
  writeFileSync(corruptPath, "{ not a record");
  restartHands();

  assert.equal(ownerLiveness(OWNER, emptyRegistry).determinate, false);
  assert.equal(runningShellCount(OWNER), null,
    "not a determinate count of the records that happened to parse");

  child.kill("SIGKILL");
});

test("another owner's surviving work does not hold this owner's sandbox", () => {
  spawnRecorded("trainer3");
  assert.equal(ownerLiveness("sess-someone-else", emptyRegistry).active, 0);
});
