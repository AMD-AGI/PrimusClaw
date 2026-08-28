// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

// workspace-sync.test.ts
//
// Pure-function unit tests for brain/src/workspace/sync.ts. Covers
// assertSafeIds regex contract, the sandbox-side bash command shape,
// and the failure-reason classification used by the
// claw_brain_workspace_sync_failures_total{reason} label
// (checkpoint-architecture-redesign §6.3, §12.1.2).
//
// These tests deliberately avoid any NATS / Hands plumbing — the
// integration paths through syncWorkspace() / restoreWorkspace() are
// covered by e2e in a follow-up PR (out of scope for C9).

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  assertSafeIds,
  assertSafePersistRoot,
  classifySyncFailure,
  __test__,
} from "../src/workspace/sync.js";
import { sharedDiskExcludes, s3Excludes } from "../src/workspace/excludes.js";

const { sessionBase, buildSyncCommand, buildRestoreCommand, buildRestoreProbeCommand } = __test__;

// ── assertSafeIds: strict regex contract guards path interpolation ──

test("assertSafeIds accepts canonical hex user id + uuid session id", () => {
  assert.doesNotThrow(() =>
    assertSafeIds(
      "0123456789abcdef0123456789abcdef",
      "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d",
    ),
  );
});

test("assertSafeIds accepts 32-char hex session id (DAG mode)", () => {
  assert.doesNotThrow(() =>
    assertSafeIds(
      "0123456789abcdef0123456789abcdef",
      "9f8e7d6c5b4a39281706f5e4d3c2b1a0",
    ),
  );
});

test("assertSafeIds rejects mixed-case hex user id", () => {
  assert.throws(
    () => assertSafeIds("0123456789ABCDEF0123456789ABCDEF", "abcd1234abcd1234abcd1234abcd1234"),
    /unsafe_user_id/,
  );
});

test("assertSafeIds rejects sub-32-char user id", () => {
  assert.throws(
    () => assertSafeIds("01234567", "abcd1234abcd1234abcd1234abcd1234"),
    /unsafe_user_id/,
  );
});

test("assertSafeIds rejects user id with shell metachars", () => {
  assert.throws(
    () => assertSafeIds("../../../etc/passwd", "abcd1234abcd1234abcd1234abcd1234"),
    /unsafe_user_id/,
  );
});

test("assertSafeIds rejects session id with shell metachars", () => {
  assert.throws(
    () => assertSafeIds("0123456789abcdef0123456789abcdef", "abc;rm -rf /"),
    /unsafe_session_id/,
  );
});

test("assertSafeIds rejects empty session id", () => {
  assert.throws(
    () => assertSafeIds("0123456789abcdef0123456789abcdef", ""),
    /unsafe_session_id/,
  );
});

// ── assertSafePersistRoot: the same standard for the root the ids hang under ──
//
// The ids above were guarded from the start and the root they are appended to
// was not, though both are substituted into the same double-quoted bash. These
// pin the difference between "a deployment set something odd" and "a deployment
// set something that ends the string and runs the rest as script".

test("a persist root that would end the string it is substituted into is refused", () => {
  for (const root of ['/data"; rm -rf /; echo "', "/data$(id)", "/data`id`", "/data'x'"]) {
    assert.throws(
      () => assertSafePersistRoot(root),
      /unsafe_persist_base/,
      `expected refusal for ${JSON.stringify(root)}`,
    );
  }
});

test("a persist root has to be absolute, because every path is built onto it", () => {
  assert.throws(() => assertSafePersistRoot("data/claw"), /unsafe_persist_base/);
  assert.throws(() => assertSafePersistRoot(""), /unsafe_persist_base/);
});

test("the roots deployments actually set are accepted", () => {
  for (const root of ["/mnt/shared", "/data/claw-workspaces", "/mnt/nfs_1/claw.v2", "/"]) {
    assert.doesNotThrow(() => assertSafePersistRoot(root), root);
  }
});

test("a sync command is never built around a root that was not checked", () => {
  assert.throws(
    () => buildSyncCommand("/mnt/shared/users/u/.claw/workspaces/s", 1, "/workspace", '/x"; id; :"'),
    /unsafe_persist_base/,
  );
});

// ── sessionBase always lives under users/<uid>/.claw/workspaces/<sid> ──

test("sessionBase composes the canonical configured path", () => {
  const path = sessionBase(
    "0123456789abcdef0123456789abcdef",
    "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d",
    "/shared",
  );
  assert.equal(
    path,
    "/shared/users/0123456789abcdef0123456789abcdef/.claw/workspaces/0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d",
  );
});

test("sessionBase rejects an empty persistence root", () => {
  assert.throws(
    () => sessionBase(
      "0123456789abcdef0123456789abcdef",
      "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d",
      "",
    ),
    /workspace_persistence_disabled/,
  );
});

// ── buildSyncCommand: recovery prologue + two-step rename + meta.json ──
//
// The shape assertions below supply a persist root rather than leaning on the
// default. An unset root is the persistence-disabled case, which never reaches
// this function -- `sessionBase` refuses first -- so a command built around one
// is a script production never emits, and the guard above will not build it.

const PERSIST_ROOT = "/mnt/shared";

const syncCommand = (base: string, turn: number): string =>
  buildSyncCommand(base, turn, "/workspace", PERSIST_ROOT);

test("buildSyncCommand has the recovery prologue for INV-14", () => {
  const cmd = syncCommand("/base", 7);
  assert.match(cmd, /set -euo pipefail/);
  assert.match(cmd, /rm -rf "\$BASE\/\.swapout\."\*/);
  assert.match(cmd, /if \[ ! -d "\$BASE\/current" \] && \[ -d "\$BASE\/pending" \]; then/);
});

test("buildSyncCommand performs the two-step atomic rename", () => {
  const cmd = syncCommand("/base", 7);
  assert.match(cmd, /mv "\$BASE\/current" "\$BASE\/\.swapout\.\$\$"/);
  assert.match(cmd, /mv "\$BASE\/pending" "\$BASE\/current"/);
});

test("buildSyncCommand writes meta.json atomically via .tmp + mv", () => {
  const cmd = syncCommand("/base", 7);
  assert.match(cmd, /cat > "\$BASE\/meta\.json\.tmp" <<EOF/);
  assert.match(cmd, /mv "\$BASE\/meta\.json\.tmp" "\$BASE\/meta\.json"/);
});

test("buildSyncCommand excludes everything the shared list names", () => {
  const cmd = syncCommand("/base", 7);
  // Both the rsync fast path and the tar fallback are built from the one list
  // in workspace/excludes.ts, so this asserts against that list rather than
  // repeating it -- repeating it is how the sync and the S3 upload came to
  // disagree about most of their contents in the first place.
  for (const pat of sharedDiskExcludes()) {
    assert.ok(cmd.includes(`--exclude '${pat}'`), `rsync ignore list missing ${pat}`);
    assert.ok(cmd.includes(`--exclude='${pat}'`), `tar ignore list missing ${pat}`);
  }
  assert.ok(
    sharedDiskExcludes().includes(".skills"),
    "the shared-disk snapshot is restored onto an image that provides .skills",
  );
});

test("the two destinations differ only over .skills", () => {
  const shared = new Set(sharedDiskExcludes());
  const s3 = new Set(s3Excludes());
  const onlyShared = [...shared].filter((p) => !s3.has(p));
  const onlyS3 = [...s3].filter((p) => !shared.has(p));

  assert.deepEqual(onlyShared, [".skills"], "the one deliberate divergence");
  assert.deepEqual(onlyS3, [], "and it goes one way only");
});

test("the sync is incremental against the previous snapshot", () => {
  const cmd = syncCommand("/base", 7);
  // The swap moves pending/ onto current/, so pending/ is empty when the next
  // sync starts. With nothing to compare against, rsync copied the entire
  // workspace every turn: the incremental sync was a full copy with extra
  // steps, and on a large workspace that was what pushed syncs towards their
  // timeout. --link-dest points it at the previous snapshot so unchanged files
  // become hard links instead of copies.
  assert.match(cmd, /--link-dest=\$BASE\/current/);
});

test("the incremental path is refused without nanosecond mtime comparison", () => {
  const cmd = syncCommand("/base", 7);
  // The trap this guards. rsync's quick check compares size and mtime at
  // one-second granularity, so a file rewritten within the same second as the
  // previous snapshot, at the same length, reads as unchanged -- and
  // --link-dest then hard-links the stale copy forward, silently and for good.
  // That was impossible while the destination was always empty, because an
  // empty destination copies everything. Verified against real rsync: without
  // --modify-window=-1 the snapshot keeps the old contents.
  assert.match(cmd, /--modify-window=-1/);
  assert.match(
    cmd,
    /if \[ -n "\$PRECISE_MTIME" \] && \[ -d "\$BASE\/current" \]; then\n\s+LINK_DEST=/,
    "link-dest requires both a previous snapshot and precise comparison",
  );
  // Decided by the version rather than by whether the option parses: rsync
  // accepts any integer window and only honours a negative one from 3.1.3, so
  // the flag probe this replaces was true on every rsync ever shipped. X4d in
  // workspace-sync-exec.test.ts runs both branches; this only pins the
  // comparison, which is the part a later edit could quietly drop.
  assert.match(cmd, /RSYNC_NUM=\$\(rsync --version/);
  assert.match(cmd, /"\$RSYNC_NUM" -ge 30103/);
});

test("buildSyncCommand interpolates the turn number into TURN env", () => {
  assert.match(syncCommand("/base", 42), /TURN="42"/);
});

test("buildSyncCommand ends with the OK marker the brain caller checks", () => {
  assert.match(
    syncCommand("/base", 7),
    /\necho OK\n__CLAW_WORKSPACE_SYNC_EOF__\n$/,
  );
});

// ── buildRestoreProbeCommand: explicit MISSING sentinel ──

test("buildRestoreProbeCommand prints MISSING when current/ or meta.json absent", () => {
  const cmd = buildRestoreProbeCommand("/base");
  assert.match(cmd, /if \[ -d "\$BASE\/current" \] && \[ -f "\$BASE\/meta\.json" \]; then/);
  assert.match(cmd, /cat "\$BASE\/meta\.json"/);
  assert.match(cmd, /echo MISSING/);
});

// ── buildRestoreCommand: NO --delete so sandbox-image files survive ──

test("buildRestoreCommand does NOT pass --delete to rsync", () => {
  const cmd = buildRestoreCommand("/base");
  assert.ok(
    !/--delete/.test(cmd),
    "restore must preserve sandbox-image files (.skills/ etc); --delete would wipe them",
  );
  assert.match(cmd, /rsync -a "\$BASE\/current\/" \/workspace\//);
  assert.match(cmd, /\necho OK\n__CLAW_WORKSPACE_SYNC_EOF__\n$/);
});

// ── classifySyncFailure: precedence + enum closedness ──

test("classifySyncFailure: timeout wins over generic rsync failure", () => {
  const err = new Error("hands_call_timeout: tool=bash timeoutMs=300000");
  assert.equal(classifySyncFailure(err), "timeout");
});

test("classifySyncFailure: meta parse error", () => {
  const err = new Error("workspace_sync_meta_parse_failed: not json");
  assert.equal(classifySyncFailure(err), "meta_write_error");
});

test("classifySyncFailure: hands network error wins over generic rsync_error", () => {
  // Shape mimics undici's wrapped fetch failure recognised by
  // isHandsNetworkError in clients/hands.ts.
  const err: any = new Error("fetch failed");
  err.cause = { code: "ECONNREFUSED", message: "connect ECONNREFUSED" };
  assert.equal(classifySyncFailure(err), "hands_unreachable");
});

test("classifySyncFailure: default falls through to rsync_error", () => {
  const err = new Error("rsync: connection unexpectedly closed");
  assert.equal(classifySyncFailure(err), "rsync_error");
});

test("classifySyncFailure: workspace_restore_timeout also maps to timeout", () => {
  const err = new Error("workspace_restore_timeout");
  assert.equal(classifySyncFailure(err), "timeout");
});

test("classifySyncFailure: the script's own refusals are not rsync bugs", () => {
  // Both are actionable and neither is about rsync. Counted as rsync_error they
  // send whoever is on call to read rsync output for a deployment that named a
  // mount nobody provides, or for a sandbox that was destroyed mid-turn.
  assert.equal(
    classifySyncFailure(new Error(
      "workspace_sync_failed: workspace_persist_base_missing: /shared is not a directory in the sandbox",
    )),
    "config_error",
  );
  assert.equal(
    classifySyncFailure(new Error(
      "workspace_sync_failed: workspace_sync_empty: /workspace produced no files; keeping the previous snapshot",
    )),
    "empty_workspace",
  );
});
