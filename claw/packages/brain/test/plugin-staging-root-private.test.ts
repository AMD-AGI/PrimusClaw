// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Plugin assets are staged on Brain before they reach the sandbox, and
 * engine.ts puts that staging area in the shared OS temp dir --
 * `<tmp>/claw-plugin-work/<session_id>` -- because BRAIN_SESSION_ROOT can
 * point at a read-only path in the container image. Every component of that
 * path except the session id is a constant, and on a host where any second
 * local account can write to /tmp, a constant path in /tmp is something that
 * account can create first.
 *
 * What it buys them is not theoretical. `resolvePluginToolsFromMessage` then
 * runs `downloadS3File` / `syncS3PrefixToLocal` under that root, and both end
 * in a plain `fs.writeFileSync`, which follows symlinks: a `claw-plugin-work`
 * symlink aimed at /etc turns an S3 plugin download into an arbitrary file
 * write with Brain's privileges. A directory the attacker owns instead of a
 * symlink is the quieter half of the same problem -- they can read the skill
 * and hook scripts, or replace them in the window between download and the
 * upload into the agent's sandbox, which is code execution in the session.
 *
 * `fs.mkdirSync(root, { recursive: true })` accepts all of that silently,
 * which is what these assertions exist to stop from coming back.
 *
 * Coverage:
 *   P1 the staging root is private (0700) and so is every component we create
 *   P2 the leaf is unguessable and never reused between runs
 *   P3 a symlink planted at a predictable component is refused, not followed
 *   P4 a directory planted by "another user" (world-writable) is refused
 *   P5 a workRoot outside the temp dir does not reject the operator's own tree
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { createPrivateStagingRoot } from "../src/tasks/plugin-from-message.js";

/** A private base standing in for os.tmpdir() so tests never touch real /tmp entries. */
function freshTmpBase(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "claw-staging-test-"));
}

test("P1 staging root and the components we create are private to this user", () => {
  const base = freshTmpBase();
  const workRoot = path.join(base, "claw-plugin-work", "session-abc");
  const stage = createPrivateStagingRoot(workRoot);

  assert.ok(stage.startsWith(`${workRoot}${path.sep}`), "stage must live under workRoot");
  for (const dir of [path.join(base, "claw-plugin-work"), workRoot, stage]) {
    const st = fs.lstatSync(dir);
    assert.ok(st.isDirectory(), `${dir} must be a real directory`);
    assert.equal(st.mode & 0o077, 0, `${dir} must not be readable by group/other`);
  }
  fs.rmSync(base, { recursive: true, force: true });
});

test("P2 each run gets its own unguessable staging leaf", () => {
  const base = freshTmpBase();
  const workRoot = path.join(base, "claw-plugin-work", "session-abc");
  const first = createPrivateStagingRoot(workRoot);
  const second = createPrivateStagingRoot(workRoot);

  assert.notEqual(first, second, "a second run must not reuse the first run's directory");
  assert.notEqual(path.basename(first), "session-abc");
  fs.rmSync(base, { recursive: true, force: true });
});

test("P3 a symlink planted on the predictable path is refused, not followed", () => {
  const base = freshTmpBase();
  const elsewhere = path.join(base, "attacker-target");
  fs.mkdirSync(elsewhere, { recursive: true, mode: 0o700 });
  // The attacker gets there first: `<tmp>/claw-plugin-work` is a symlink.
  fs.symlinkSync(elsewhere, path.join(base, "claw-plugin-work"));

  const workRoot = path.join(base, "claw-plugin-work", "session-abc");
  assert.throws(
    () => createPrivateStagingRoot(workRoot),
    /not a real directory/,
    "a symlinked component must abort staging",
  );
  assert.deepEqual(fs.readdirSync(elsewhere), [], "nothing may be written through the symlink");
  fs.rmSync(base, { recursive: true, force: true });
});

test("P4 a pre-created world-writable directory is refused", () => {
  const base = freshTmpBase();
  const planted = path.join(base, "claw-plugin-work");
  fs.mkdirSync(planted, { recursive: true });
  // Ownership cannot be faked without root, so stand in for "not ours" with
  // the other half of the same check: open to every other local account.
  fs.chmodSync(planted, 0o777);

  const workRoot = path.join(planted, "session-abc");
  assert.throws(
    () => createPrivateStagingRoot(workRoot),
    /accessible by other users/,
    "a component other users can write to must abort staging",
  );
  assert.equal(fs.existsSync(workRoot), false, "no session dir may be created under it");
  fs.rmSync(base, { recursive: true, force: true });
});

test("P5 a workRoot outside the temp dir trusts the operator's existing tree", () => {
  // Outside os.tmpdir() the existing directories belong to whoever configured
  // the path (think /srv or a mounted volume, root-owned and world-readable on
  // purpose); only what we create below them is ours to lock down.
  const base = freshTmpBase();
  const operatorDir = path.join(base, "operator-root");
  fs.mkdirSync(operatorDir, { recursive: true });
  fs.chmodSync(operatorDir, 0o755);

  const realTmp = os.tmpdir;
  // Point os.tmpdir() somewhere else so `operatorDir` counts as "outside".
  (os as { tmpdir: () => string }).tmpdir = () => path.join(base, "not-the-tmp-dir");
  try {
    const stage = createPrivateStagingRoot(path.join(operatorDir, "plugin-work"));
    assert.ok(stage.startsWith(`${operatorDir}${path.sep}`));
    assert.equal(fs.lstatSync(path.join(operatorDir, "plugin-work")).mode & 0o077, 0);
    assert.equal(fs.lstatSync(operatorDir).mode & 0o777, 0o755, "operator dir left alone");
  } finally {
    (os as { tmpdir: () => string }).tmpdir = realTmp;
    fs.rmSync(base, { recursive: true, force: true });
  }
});
