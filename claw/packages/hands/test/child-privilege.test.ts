// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * What the model's own commands can reach, and what they cannot.
 *
 * A child used to inherit Hands' operating-system identity and its whole
 * environment. That handed the model the internal bearer token -- which
 * authorises counting another owner's shells and terminating another run's
 * work -- and, because one sandbox serves several runs under one identity, the
 * other runs' processes as well.
 *
 * The properties here are negative and are asserted over whole surfaces rather
 * than named fields: no deny list of variable names, no inspection of a chosen
 * few. A boundary that has to enumerate what it forbids is a promise to
 * remember every future secret.
 */
import test, { after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const WORK = mkdtempSync(join(tmpdir(), "claw-priv-"));
process.env.WORKSPACE_PATH = WORK;
process.env.BG_SHELL_ENABLED = "true";
process.env.BG_SHELL_REAP_DELAY_MS = "10";
process.env.AUTH_CLAW_TOKEN = "a-token-no-child-may-read";
process.env.HANDS_STATE_DIR = mkdtempSync(join(tmpdir(), "claw-priv-state-"));

const privilege = await import("../src/runtime/child-privilege.js");
const bg = await import("../src/tools/shell/bg-manager.js");
const { runForegroundShell } = await import("../src/tools/shell/process-runner.js");
const { isolatingSandbox, unisolatedSandbox, releaseSandboxIsolation } =
  await import("./support/sandbox-isolation.js");

beforeEach(() => isolatingSandbox());

after(async () => {
  releaseSandboxIsolation();
  await bg.shutdownAllShells(200);
  rmSync(WORK, { recursive: true, force: true });
  rmSync(process.env.HANDS_STATE_DIR!, { recursive: true, force: true });
});

const settle = (ms = 150) => new Promise((r) => setTimeout(r, ms));

test("a declared identity with no process view refuses the spawn, both forms", async () => {
  // Half the boundary is not a weaker boundary: one identity shared between the
  // runs in a sandbox leaves each able to enumerate and signal the other's
  // processes, which is what the partition exists to stop.
  privilege.bindSandboxIsolation({
    identityRange: () => ({ min: 65500, max: 65533 }),
    partitionsProcessView: () => false,
  });
  assert.throws(
    () => bg.spawnBackground("sess", "run", "sleep 60", "half"),
    privilege.ChildPrivilegeUnavailable,
  );
  await assert.rejects(
    () => runForegroundShell("echo hi", { timeoutMs: 1_000, bufferBytes: 4096, owner: "sess", run: "run" }),
    privilege.ChildPrivilegeUnavailable,
  );
});

test("a sandbox declaring no baseline says so on every spawn, and still restricts the environment", async () => {
  // The identity half needs something of the sandbox; the environment half does
  // not, so it binds regardless. An operator reads the signal to know the
  // isolation baseline has not reached this deployment.
  unisolatedSandbox();
  const logged: string[] = [];
  const realLog = console.log;
  console.log = (line: string) => { logged.push(line); };
  try {
    bg.spawnBackground("sess-unenforced", "run-u", "env", "unenforced");
    bg.spawnBackground("sess-unenforced", "run-u", "env", "unenforced-2");
    await settle(250);
  } finally {
    console.log = realLog;
  }
  const signals = logged.filter((l) => l.includes("shell.child_identity_unenforced"));
  assert.equal(signals.length, 2, "every spawn served without the boundary says so, not just the first");
  assert.doesNotMatch(
    bg.pollOutput("sess-unenforced", "run-u", "unenforced").text,
    /a-token-no-child-may-read/,
  );
});

test("the child environment carries no Brain-facing credential, over the whole environment", async () => {
  // Scanned for the value, not for a name: a token that arrived under some
  // other key would pass a deny list and fail here.
  const env = privilege.childEnvironment();
  const serialised = JSON.stringify(env);
  assert.doesNotMatch(serialised, /a-token-no-child-may-read/);
  assert.equal(env.AUTH_CLAW_TOKEN, undefined);
  assert.equal(env.HANDS_STATE_DIR, undefined, "the record subtree's location is not the child's business");
  assert.equal(env.MCP_PORT, undefined);
  // Built up rather than filtered down, so PATH survives and nothing else
  // arrives by default.
  assert.equal(env.PATH, process.env.PATH);
});

test("a spawned command cannot read the token out of its own environment", async () => {
  bg.spawnBackground("sess-env", "run-env", "env; cat /proc/self/environ | tr '\\0' '\\n'", "envdump");
  await settle(300);
  const dump = bg.pollOutput("sess-env", "run-env", "envdump").text;
  assert.doesNotMatch(dump, /a-token-no-child-may-read/, "the internal token reached a model-issued process");
});

test("each run identity gets its own identity, and none of them is Hands'", () => {
  // Its own range rather than the shared fixture's: this asserts the allocation
  // and never spawns, so it holds wherever the suite runs.
  privilege.bindSandboxIsolation({
    identityRange: () => ({ min: 65500, max: 65533 }),
    partitionsProcessView: () => true,
  });
  const a = privilege.resolveChildPrivilege("owner-1", "run-a");
  const b = privilege.resolveChildPrivilege("owner-1", "run-b");
  const c = privilege.resolveChildPrivilege("owner-2", "run-a");

  assert.notEqual(a.uid, b.uid, "two runs under one owner share no identity");
  assert.notEqual(a.uid, c.uid, "two owners share no identity");
  assert.notEqual(b.uid, c.uid);

  // Held for the sandbox's life, so a run's second command joins its first.
  assert.equal(privilege.resolveChildPrivilege("owner-1", "run-a").uid, a.uid);

  for (const p of [a, b, c]) assert.notEqual(p.uid, 0, "a child must not run as Hands");
});

test("a sandbox out of identities refuses rather than reusing one", () => {
  privilege.bindSandboxIsolation({
    identityRange: () => ({ min: 65530, max: 65531 }),
    partitionsProcessView: () => true,
  });
  privilege.resolveChildPrivilege("o", "run-1");
  privilege.resolveChildPrivilege("o", "run-2");
  assert.throws(
    () => privilege.resolveChildPrivilege("o", "run-3"),
    privilege.ChildPrivilegeUnavailable,
  );
});

test("the start log names no command text", async () => {
  // Everything Hands writes about a shell names it, and the log used to carry a
  // leading span of the command as well. Truncating is no mitigation: a
  // credential in the first argument is in the first five hundred bytes.
  const logged: string[] = [];
  const realLog = console.log;
  console.log = (line: string) => { logged.push(line); };
  try {
    bg.spawnBackground("sess-log", "run-log", "echo planted-token-9x8y7z", "logged");
    await settle(200);
  } finally {
    console.log = realLog;
  }
  assert.ok(logged.length > 0, "the fixture produced no log to scan");
  assert.doesNotMatch(logged.join("\n"), /planted-token-9x8y7z/);
});

test("an identity assignment survives a restart of this process", async () => {
  // Process-local allocation restarts the counter, so a live child's identity
  // is handed to a different pair while its record still says otherwise. The
  // table lives beside the records for exactly that reason.
  privilege.bindSandboxIsolation({
    identityRange: () => ({ min: 65500, max: 65533 }),
    partitionsProcessView: () => true,
  });
  const first = privilege.resolveChildPrivilege("owner-a", "run-a").uid;
  const second = privilege.resolveChildPrivilege("owner-b", "run-b").uid;

  // Re-binding is this module's restart: every in-memory table is dropped.
  privilege.bindSandboxIsolation({
    identityRange: () => ({ min: 65500, max: 65533 }),
    partitionsProcessView: () => true,
  });
  assert.equal(privilege.resolveChildPrivilege("owner-a", "run-a").uid, first,
    "the pair's identity was reassigned across a restart");
  assert.equal(privilege.resolveChildPrivilege("owner-b", "run-b").uid, second);
  assert.notEqual(
    privilege.resolveChildPrivilege("owner-c", "run-c").uid, first,
    "a new pair took a live pair's identity",
  );
});

test("a declared range this process cannot assume from refuses, rather than falling back", () => {
  // Distinct from declaring nothing: a deployment that asked for the boundary
  // and cannot have it must not be served under Hands' own identity, which is
  // the silent unenforcement the declaration rules out.
  privilege.bindSandboxIsolation({
    identityRange: () => { throw new privilege.ChildPrivilegeUnavailable("not privileged enough"); },
    partitionsProcessView: () => true,
  });
  assert.throws(
    () => bg.spawnBackground("sess", "run", "sleep 60", "unprivileged"),
    privilege.ChildPrivilegeUnavailable,
  );
});

test("background shells refuse to start where nothing states the isolation posture", async () => {
  // The record subtree and the sandbox credential are what a background shell's
  // addressing and deduplication rest on, and a child running as Hands itself
  // reads both -- the credential out of the parent's environment, the records
  // out of a subtree its own identity owns. Silence about the boundary is
  // refused so that serving without one is a decision somebody took.
  const previous = process.env.HANDS_CHILD_ISOLATION;
  delete process.env.HANDS_CHILD_ISOLATION;
  unisolatedSandbox();
  try {
    assert.throws(
      () => privilege.assertChildBoundaryForBackgroundShells(true),
      privilege.ChildPrivilegeUnavailable,
    );
    assert.doesNotThrow(
      () => privilege.assertChildBoundaryForBackgroundShells(false),
      "a deployment that is not serving background shells is not asked",
    );

    process.env.HANDS_CHILD_ISOLATION = privilege.ISOLATION_UNENFORCED;
    assert.doesNotThrow(
      () => privilege.assertChildBoundaryForBackgroundShells(true),
      "the acknowledgement is not the boundary, but it is a stated posture",
    );

    delete process.env.HANDS_CHILD_ISOLATION;
    privilege.bindSandboxIsolation({
      identityRange: () => ({ min: 65500, max: 65533 }),
      partitionsProcessView: () => true,
    });
    assert.doesNotThrow(
      () => privilege.assertChildBoundaryForBackgroundShells(true),
      "and a declared identity range is the boundary itself",
    );
  } finally {
    if (previous === undefined) delete process.env.HANDS_CHILD_ISOLATION;
    else process.env.HANDS_CHILD_ISOLATION = previous;
  }
});
