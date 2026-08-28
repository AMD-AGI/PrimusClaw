// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

// Running the sync script, rather than reading it.
//
// workspace-sync.test.ts asserts the shape of the text these builders emit,
// which is how a script can pass every test and still not do what it says: the
// two-step rename, the crash-recovery prologue, the --link-dest fast path and
// the tar fallback are all claims about what happens to a filesystem, and text
// cannot settle them. So this file executes the same scripts against scratch
// directories and looks at the result.
//
// Nothing here needs a sandbox, a cluster or a shared disk -- the script is
// bash over paths, and the only thing production supplies that a temp dir does
// not is the path itself. That makes the three integration items which cover
// this on a live environment (V3 delete, V4 same-second rewrite, V29 files
// surviving a run) reproducible on a laptop, and it is why the seam exists.
//
// Coverage:
//   X1  a first sync makes a snapshot, minus the excluded trees
//   X2  the second sync hard-links what did not change
//   X3  a file rewritten inside the same second at the same length still lands
//   X4  a file deleted from the workspace leaves the snapshot
//   X4b leftovers in pending/ from a killed sync do not reach the snapshot
//   X4c an empty workspace does not replace a snapshot that is not empty
//   X4d the incremental flags are chosen by rsync's version, not by a flag probe
//   X5  the tar fallback drops it too, so the two paths agree
//   X6  a crash between the two renames still leaves a usable snapshot
//   X7  restore overwrites the snapshot's files and keeps the image's own
//   X8  meta.json describes current/, and is written whole or not at all

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, statSync, existsSync, symlinkSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { __test__ } from "../src/workspace/sync.js";

const { buildSyncCommand, buildRestoreCommand, buildRestoreProbeCommand } = __test__;

// Everything the script calls except rsync. Symlinking exactly this set into a
// directory and running with PATH pointing at it is how the fallback branch is
// reached without uninstalling anything: `command -v rsync` has nowhere to find
// it, while the rest of the script still works.
const SCRIPT_TOOLS = [
  "bash", "sh", "mv", "rm", "mkdir", "cat", "date", "du", "find", "wc", "awk",
  "basename", "tar", "gzip", "ls", "cp", "ln", "touch", "sed", "grep",
];

// The script reads nothing from the environment except what it needs to find
// its tools, so the child gets a PATH and nothing else. Inheriting the test
// process's environment would make what this executes depend on whatever the
// runner happened to export, which is both a scanner finding and a real source
// of results that differ between a laptop and CI.
const TOOL_PATH = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";

// And where the scratch directories go, for the same reason. The snapshot base
// is interpolated into the script the same way the persist root is, and
// production keeps that safe by checking both; this file builds the commands
// directly, so a root taken from TMPDIR is an unchecked path reaching `sh -c`
// -- a test that executes something other than the script under test on a
// machine whose TMPDIR contains a quote. The file already depends on being on a
// POSIX system: it runs /bin/sh and symlinks tools out of /usr/bin and /bin.
const SCRATCH_BASE = "/tmp";

function makeToolsDirWithoutRsync(root: string): string {
  const dir = join(root, "bin-no-rsync");
  mkdirSync(dir, { recursive: true });
  for (const tool of SCRIPT_TOOLS) {
    for (const prefix of ["/usr/bin", "/bin", "/usr/sbin"]) {
      const src = join(prefix, tool);
      if (existsSync(src)) {
        try { symlinkSync(src, join(dir, tool)); } catch { /* already linked */ }
        break;
      }
    }
  }
  return dir;
}

interface Ctx {
  root: string;
  base: string;
  workspace: string;
  noRsyncPath: string;
}

/**
 * An rsync that reports the version it is asked to and forwards everything else
 * to the real one, so the version branch can be exercised on a machine with a
 * single rsync installed. It records the arguments it was called with, because
 * which flags the script chose is the thing under test.
 */
function fakeRsyncPath(ctx: Ctx, version: string): { dir: string; argsFile: string } {
  const dir = join(ctx.root, `bin-rsync-${version}`);
  mkdirSync(dir, { recursive: true });
  const argsFile = join(dir, "args.txt");
  const real = execFileSync("/bin/sh", ["-c", "command -v rsync"], {
    encoding: "utf8",
    env: { PATH: TOOL_PATH },
  }).trim();
  writeFileSync(join(dir, "rsync"), [
    "#!/bin/sh",
    `if [ "$1" = "--version" ]; then`,
    `  echo "rsync  version ${version}  protocol version 30"`,
    // Real rsync follows the version with several lines of capabilities. Enough
    // of them here to overflow the pipe buffer, which makes the SIGPIPE trap
    // deterministic: a reader that stops after the first line leaves rsync
    // writing into a closed pipe, and under pipefail that ends the whole sync.
    `  i=0; while [ $i -lt 2000 ]; do echo "    capability $i"; i=$((i+1)); done`,
    `  exit 0`,
    `fi`,
    `echo "$@" >> ${argsFile}`,
    `exec ${real} "$@"`,
    "",
  ].join("\n"), { mode: 0o755 });
  return { dir, argsFile };
}

function setup(): Ctx {
  const root = mkdtempSync(join(SCRATCH_BASE, "claw-sync-"));
  const base = join(root, "snapshot");
  const workspace = join(root, "workspace");
  mkdirSync(base, { recursive: true });
  mkdirSync(workspace, { recursive: true });
  return { root, base, workspace, noRsyncPath: makeToolsDirWithoutRsync(root) };
}

function cleanup(ctx: Ctx): void {
  rmSync(ctx.root, { recursive: true, force: true });
}

// The sandbox dispatches the command through `sh -c`, which is what makes the
// heredoc-into-bash wrapper necessary in the first place, so run it the same
// way here rather than handing the script straight to bash.
function run(cmd: string, opts: { path?: string } = {}): string {
  return execFileSync("/bin/sh", ["-c", cmd], {
    encoding: "utf8",
    env: { PATH: opts.path ?? TOOL_PATH },
  });
}

function sync(
  ctx: Ctx,
  turn: number,
  opts: { noRsync?: boolean; persistRoot?: string; path?: string } = {},
): string {
  const cmd = buildSyncCommand(ctx.base, turn, ctx.workspace, opts.persistRoot ?? ctx.root);
  const path = opts.path ?? (opts.noRsync ? ctx.noRsyncPath : undefined);
  return run(cmd, path ? { path } : {});
}

function write(dir: string, rel: string, content: string): string {
  const path = join(dir, rel);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, content);
  return path;
}

function snapshotFile(ctx: Ctx, rel: string): string {
  return readFileSync(join(ctx.base, "current", rel), "utf8");
}

test("X1 a first sync copies the workspace and leaves the excluded trees behind", () => {
  const ctx = setup();
  try {
    write(ctx.workspace, "src/main.py", "print(1)\n");
    write(ctx.workspace, "notes.md", "hello\n");
    write(ctx.workspace, "node_modules/left/index.js", "junk\n");
    write(ctx.workspace, ".git/HEAD", "ref: refs/heads/main\n");
    write(ctx.workspace, ".skills/provided-by-image.md", "image\n");
    write(ctx.workspace, "build/kernel.o", "binary\n");
    // Brain's own log, which bootstrap writes into the directory being
    // snapshotted. A plain file at the root, so it also covers the one exclude
    // shape the entries above do not: not a directory, not a glob.
    write(ctx.workspace, "hands.log", "hands said something\n");

    const out = sync(ctx, 1);
    assert.match(out, /OK\s*$/);

    assert.equal(snapshotFile(ctx, "src/main.py"), "print(1)\n");
    assert.equal(snapshotFile(ctx, "notes.md"), "hello\n");
    for (const gone of ["node_modules", ".git", ".skills", "build/kernel.o", "hands.log"]) {
      assert.ok(
        !existsSync(join(ctx.base, "current", gone)),
        `${gone} is on the exclude list and should not be in the snapshot`,
      );
    }
    // The swap is a rename, so pending/ is gone rather than emptied -- which
    // is what the next sync's prologue reads to tell a finished sync from one
    // that died mid-swap.
    assert.ok(!existsSync(join(ctx.base, "pending")));
  } finally {
    cleanup(ctx);
  }
});

test("X1b a persist root nobody mounted is refused, not created on the local disk", () => {
  const ctx = setup();
  try {
    write(ctx.workspace, "src/main.py", "print(1)\n");
    const absent = join(ctx.root, "not-a-mount");

    assert.throws(
      () => sync(ctx, 1, { persistRoot: absent }),
      (err: Error & { stderr?: string }) => {
        assert.match(String(err.stderr ?? err.message), /workspace_persist_base_missing/);
        return true;
      },
      "a base that is not there means the snapshot would go to the pod's own disk " +
      "and vanish with it, while the sync reported a size and an inode count",
    );
    assert.ok(!existsSync(absent), "and the sync must not create the root it refused");
  } finally {
    cleanup(ctx);
  }
});

test("X2 the second sync hard-links what did not change", () => {
  const ctx = setup();
  try {
    write(ctx.workspace, "unchanged.txt", "same\n");
    write(ctx.workspace, "changed.txt", "before\n");
    sync(ctx, 1);
    const firstUnchanged = statSync(join(ctx.base, "current", "unchanged.txt")).ino;
    const firstChanged = statSync(join(ctx.base, "current", "changed.txt")).ino;

    write(ctx.workspace, "changed.txt", "after this is a longer line\n");
    sync(ctx, 2);

    assert.equal(
      statSync(join(ctx.base, "current", "unchanged.txt")).ino,
      firstUnchanged,
      "an untouched file should be linked forward from the previous snapshot, not copied",
    );
    assert.notEqual(
      statSync(join(ctx.base, "current", "changed.txt")).ino,
      firstChanged,
      "a modified file must be a new inode, or the link would corrupt the old snapshot",
    );
    assert.equal(snapshotFile(ctx, "changed.txt"), "after this is a longer line\n");
  } finally {
    cleanup(ctx);
  }
});

test("X3 a file rewritten inside the same second, at the same length, still lands in the snapshot", () => {
  const ctx = setup();
  try {
    // The trap --modify-window=-1 exists for. Same length and same
    // whole-second mtime read as unchanged to rsync's quick check, and with
    // --link-dest the stale copy is then linked forward for good. No sleep
    // here on purpose: the two writes have to fall inside one second for the
    // test to be testing anything.
    write(ctx.workspace, "same-length.txt", "AAAAAAAA\n");
    sync(ctx, 1);
    write(ctx.workspace, "same-length.txt", "BBBBBBBB\n");
    sync(ctx, 2);

    assert.equal(
      snapshotFile(ctx, "same-length.txt"),
      "BBBBBBBB\n",
      "the snapshot kept the pre-rewrite contents; --modify-window=-1 is not taking effect",
    );
  } finally {
    cleanup(ctx);
  }
});

test("X4 a file deleted from the workspace leaves the snapshot", () => {
  const ctx = setup();
  try {
    write(ctx.workspace, "keep.txt", "keep\n");
    write(ctx.workspace, "remove.txt", "remove\n");
    sync(ctx, 1);
    assert.ok(existsSync(join(ctx.base, "current", "remove.txt")));

    rmSync(join(ctx.workspace, "remove.txt"));
    sync(ctx, 2);

    assert.ok(!existsSync(join(ctx.base, "current", "remove.txt")), "--delete did not reach the snapshot");
    assert.ok(existsSync(join(ctx.base, "current", "keep.txt")));
  } finally {
    cleanup(ctx);
  }
});

test("X4b leftovers from a sync that died before the swap do not reach the snapshot", () => {
  // A sync killed before the two-step rename leaves its half-built copy in
  // pending/, which is a normal way for this to end: Hands' bash timeout kills
  // the process group, or the pod goes. The next sync's `--delete` does not
  // clean it up, because rsync protects excluded files on the receiving side --
  // so anything in there matching an exclude is promoted into the snapshot and
  // restored into the user's workspace on the next turn. The likeliest source is
  // this change's own exclude additions: a hands.log or a .o copied there by the
  // previous release, when they were not excluded yet.
  const ctx = setup();
  try {
    write(ctx.workspace, "real.txt", "real\n");
    write(ctx.base, "pending/kernel.o", "stale object\n");
    write(ctx.base, "pending/hands.log", "stale log\n");
    write(ctx.base, "pending/dead.txt", "never in the workspace\n");
    sync(ctx, 1);

    assert.deepEqual(
      readdirSync(join(ctx.base, "current")).sort(),
      ["real.txt"],
      "the snapshot is the workspace, not the workspace plus whatever survived",
    );
  } finally {
    cleanup(ctx);
  }
});

test("X4c a workspace that came back empty does not replace a snapshot that is not", () => {
  // The half-torn-down sandbox: the mount is still there and its contents are
  // gone. rsync copies nothing and exits 0, so without a check the swap promotes
  // an empty directory over a good snapshot, meta.json records inode_count 0, the
  // script prints OK, and the restore probe afterwards finds current/ and
  // meta.json and reports nothing wrong. A mount missing altogether is already
  // safe -- rsync exits 23 and set -e stops before the swap -- so this is the
  // shape that loses the files.
  const ctx = setup();
  try {
    write(ctx.workspace, "work.txt", "a turn's work\n");
    sync(ctx, 1);

    rmSync(join(ctx.workspace, "work.txt"));
    assert.throws(() => sync(ctx, 2), /workspace_sync_empty/);

    assert.equal(snapshotFile(ctx, "work.txt"), "a turn's work\n",
      "the previous snapshot survives an empty sync");
    assert.ok(!existsSync(join(ctx.base, "pending")), "and the empty scratch copy is cleaned up");
  } finally {
    cleanup(ctx);
  }
});

test("X4d the incremental path is decided by rsync's version, not by the flag parsing", () => {
  // --modify-window=-1 is what makes --link-dest safe, and rsync only honours a
  // negative window from 3.1.3 on. Asking `rsync --modify-window=-1 --version`
  // does not find that out: it exits 0 for any integer, including -99, so the
  // guard it was written as was true everywhere and the two options travelled
  // together onto rsync versions that ignore the first one -- where a file
  // rewritten inside one second at one length is linked forward stale and stays
  // that way. A stub that answers --version with an old number and forwards
  // everything else is the only way to reach that branch without an old rsync.
  //
  // The stub's --version output is long on purpose. Reading the version means a
  // pipe, and under pipefail a reader that stops at the first line leaves rsync
  // writing into a closed one: SIGPIPE, exit 141, no sync -- intermittently,
  // depending on whether the rest of the output had already fitted in the buffer.
  const ctx = setup();
  try {
    write(ctx.workspace, "file.txt", "content\n");
    sync(ctx, 1);

    // current/ exists from here on, so --link-dest is available and only the
    // version check stands between it and the command line.
    const oldRsync = fakeRsyncPath(ctx, "3.0.9");
    sync(ctx, 2, { path: `${oldRsync.dir}:${TOOL_PATH}` });
    const oldArgs = readFileSync(oldRsync.argsFile, "utf8");
    assert.ok(oldArgs.includes("--delete"), "the sync still ran through the stub");
    assert.ok(
      !oldArgs.includes("--modify-window"),
      "an rsync that ignores a negative window must not be given one",
    );
    assert.ok(
      !oldArgs.includes("--link-dest"),
      "and without it the copy has to be full, because a stale link is permanent",
    );

    const newRsync = fakeRsyncPath(ctx, "3.1.3");
    sync(ctx, 3, { path: `${newRsync.dir}:${TOOL_PATH}` });
    const newArgs = readFileSync(newRsync.argsFile, "utf8");
    assert.ok(newArgs.includes("--modify-window=-1"), "3.1.3 is where the man page says it works");
    assert.ok(newArgs.includes("--link-dest="), "and only then is the fast path taken");
  } finally {
    cleanup(ctx);
  }
});

test("X5 the tar fallback drops the same file, so the two paths agree", () => {
  const ctx = setup();
  try {
    write(ctx.workspace, "keep.txt", "keep\n");
    write(ctx.workspace, "remove.txt", "remove\n");
    write(ctx.workspace, "node_modules/left/index.js", "junk\n");
    sync(ctx, 1, { noRsync: true });
    assert.ok(existsSync(join(ctx.base, "current", "remove.txt")));
    assert.ok(!existsSync(join(ctx.base, "current", "node_modules")), "tar honours the same exclude list");

    rmSync(join(ctx.workspace, "remove.txt"));
    write(ctx.workspace, "keep.txt", "changed\n");
    sync(ctx, 2, { noRsync: true });

    assert.ok(
      !existsSync(join(ctx.base, "current", "remove.txt")),
      "the fallback rebuilds pending/ from scratch, so a deleted file must not survive",
    );
    assert.equal(snapshotFile(ctx, "keep.txt"), "changed\n");
  } finally {
    cleanup(ctx);
  }
});

test("X6 a crash between the two renames still leaves a usable snapshot", () => {
  const ctx = setup();
  try {
    write(ctx.workspace, "turn1.txt", "one\n");
    sync(ctx, 1);

    // Reproduce the T1 → T2 window by hand: current/ has been renamed out of
    // the way and the process died before pending/ took its place. What is on
    // disk at that moment is a populated pending/, no current/, and an
    // orphaned .swapout.
    write(ctx.workspace, "turn2.txt", "two\n");
    run(`set -e
       mkdir -p "${ctx.base}/pending"
       cp -a "${ctx.base}/current/." "${ctx.base}/pending/"
       echo two > "${ctx.base}/pending/turn2.txt"
       mv "${ctx.base}/current" "${ctx.base}/.swapout.9999"`);
    assert.ok(!existsSync(join(ctx.base, "current")));

    sync(ctx, 3);

    assert.ok(existsSync(join(ctx.base, "current")), "the prologue must promote pending/ back to current/");
    assert.equal(snapshotFile(ctx, "turn1.txt"), "one\n");
    assert.equal(snapshotFile(ctx, "turn2.txt"), "two\n");
    assert.deepEqual(
      readdirSync(ctx.base).filter((n) => n.startsWith(".swapout.")),
      [],
      "the orphaned swapout is the reaper's blind spot, so the sync has to clear it",
    );
  } finally {
    cleanup(ctx);
  }
});

test("X7 restore overwrites the snapshot's files and keeps the image's own", () => {
  const ctx = setup();
  try {
    write(ctx.workspace, "code.py", "from the snapshot\n");
    sync(ctx, 1);

    // A fresh sandbox: the workspace has what the image ships and nothing the
    // session produced.
    rmSync(ctx.workspace, { recursive: true, force: true });
    mkdirSync(ctx.workspace, { recursive: true });
    write(ctx.workspace, ".skills/from-image.md", "image\n");
    write(ctx.workspace, "code.py", "placeholder\n");

    const probe = run(buildRestoreProbeCommand(ctx.base));
    assert.ok(!probe.includes("MISSING"), "a snapshot with current/ and meta.json is not MISSING");
    run(buildRestoreCommand(ctx.base, ctx.workspace));

    assert.equal(readFileSync(join(ctx.workspace, "code.py"), "utf8"), "from the snapshot\n");
    assert.equal(
      readFileSync(join(ctx.workspace, ".skills/from-image.md"), "utf8"),
      "image\n",
      "restore must not delete what the image provided; that is why it has no --delete",
    );
  } finally {
    cleanup(ctx);
  }
});

test("X8 an absent snapshot answers MISSING rather than restoring nothing quietly", () => {
  const ctx = setup();
  try {
    assert.match(run(buildRestoreProbeCommand(ctx.base)), /MISSING/);
    // current/ without meta.json is also MISSING: a snapshot the sync never
    // finished describing is not one to restore from.
    mkdirSync(join(ctx.base, "current"), { recursive: true });
    assert.match(run(buildRestoreProbeCommand(ctx.base)), /MISSING/);
  } finally {
    cleanup(ctx);
  }
});

test("X9 meta.json describes what is actually in current/", () => {
  const ctx = setup();
  try {
    write(ctx.workspace, "a.txt", "12345\n");
    write(ctx.workspace, "dir/b.txt", "678\n");
    write(ctx.workspace, "node_modules/c.js", "not counted\n");
    sync(ctx, 11);

    const meta = JSON.parse(readFileSync(join(ctx.base, "meta.json"), "utf8"));
    assert.equal(meta.turn, 11);
    assert.equal(meta.session_id, "snapshot", "the session id is the leaf of the base path");
    assert.equal(meta.inode_count, 2, "excluded trees must not be counted");
    assert.ok(meta.size_bytes > 0);
    assert.ok(meta.taken_at > 1_700_000_000_000, "taken_at is epoch milliseconds");
    assert.ok(
      !existsSync(join(ctx.base, "meta.json.tmp")),
      "the temp file is renamed, so a reader never sees a half-written meta",
    );
  } finally {
    cleanup(ctx);
  }
});
