// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * `download_from_s3` does not write through a symbolic link inside the
 * workspace. Hands can write as an identity the model's commands do not have,
 * and the uploads a reused sandbox is given land in a directory those commands
 * could have replaced with a link.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const WORK = fs.mkdtempSync(path.join(os.tmpdir(), "claw-dl-ws-"));
const OUTSIDE = fs.mkdtempSync(path.join(os.tmpdir(), "claw-dl-outside-"));
process.env.WORKSPACE_PATH = WORK;
const { downloadS3 } = await import("../src/tools/s3/download-s3.js");

// The presigned GET is answered in-process: these tests are about where the bytes land, not about fetching them.
const realFetch = globalThis.fetch;
globalThis.fetch = (async () => new Response("uploaded bytes")) as typeof fetch;
const url = "http://s3.invalid/obj";
after(() => {
  globalThis.fetch = realFetch;
  fs.rmSync(WORK, { recursive: true, force: true });
  fs.rmSync(OUTSIDE, { recursive: true, force: true });
});

function result(res: { content: Array<{ text: string }> }) {
  return JSON.parse(res.content[0].text) as { ok: string[]; failed: Array<{ path: string; error: string }> };
}

test("a directory replaced by a link is not written through", async () => {
  fs.symlinkSync(OUTSIDE, path.join(WORK, ".uploads"));
  const target = path.join(WORK, ".uploads", "teams", "m1", "a.png");
  const out = result(await downloadS3.execute({ files: [{ local_path: target, presigned_url: url }] }));
  assert.deepEqual(out.ok, []);
  assert.match(out.failed[0].error, /is a symbolic link/);
  assert.deepEqual(fs.readdirSync(OUTSIDE), [], "nothing was written outside");
  fs.unlinkSync(path.join(WORK, ".uploads"));
});

test("a file replaced by a link is not written through", async () => {
  fs.mkdirSync(path.join(WORK, ".uploads"), { recursive: true });
  const victim = path.join(OUTSIDE, "victim");
  fs.writeFileSync(victim, "keep");
  fs.symlinkSync(victim, path.join(WORK, ".uploads", "b.txt"));
  const out = result(await downloadS3.execute({ files: [{ local_path: path.join(WORK, ".uploads", "b.txt"), presigned_url: url }] }));
  assert.deepEqual(out.ok, []);
  assert.equal(fs.readFileSync(victim, "utf-8"), "keep");
});

test("an ordinary path is written", async () => {
  const target = path.join(WORK, ".uploads", "c", "d.txt");
  const out = result(await downloadS3.execute({ files: [{ local_path: target, presigned_url: url }] }));
  assert.deepEqual(out.ok, [target]);
  assert.equal(fs.readFileSync(target, "utf-8"), "uploaded bytes");
});

test("a directory swapped for a link after the check is still not written through", async () => {
  const fsMod = await import("node:fs");
  const target = path.join(WORK, "race", "e.txt");
  const real = fsMod.default.mkdirSync;
  // The swap lands between the link check and the open: the moment the directories are made.
  fsMod.default.mkdirSync = ((dir: string, opts: unknown) => {
    const made = real(dir, opts as never);
    if (String(dir) === path.join(WORK, "race")) {
      fsMod.default.rmSync(dir, { recursive: true, force: true });
      fsMod.default.symlinkSync(OUTSIDE, dir);
    }
    return made;
  }) as typeof real;
  try {
    const out = result(await downloadS3.execute({ files: [{ local_path: target, presigned_url: url }] }));
    assert.deepEqual(out.ok, []);
    assert.match(out.failed[0].error, /outside the workspace/);
    assert.deepEqual(fsMod.default.readdirSync(OUTSIDE).filter((n) => n === "e.txt"), [], "nothing was left outside");
  } finally {
    fsMod.default.mkdirSync = real;
  }
});

test("a file already in the workspace is replaced by the download", async () => {
  const target = path.join(WORK, ".uploads", "c", "d.txt");
  fs.writeFileSync(target, "an older and longer body that must not survive");
  const out = result(await downloadS3.execute({ files: [{ local_path: target, presigned_url: url }] }));
  assert.deepEqual(out.ok, [target]);
  assert.equal(fs.readFileSync(target, "utf-8"), "uploaded bytes");
});

test("a directory renamed out of the workspace after the check is not left holding the bytes", async () => {
  const fsMod = (await import("node:fs")).default;
  const dir = path.join(WORK, "moving");
  const target = path.join(dir, "f.txt");
  const real = fsMod.ftruncateSync;
  // The rename lands after the opened file was found inside the workspace, just before it is written.
  fsMod.ftruncateSync = ((fd: number, len?: number) => {
    fsMod.ftruncateSync = real;
    fsMod.renameSync(dir, path.join(OUTSIDE, "moving"));
    return real(fd, len);
  }) as typeof real;
  try {
    const out = result(await downloadS3.execute({ files: [{ local_path: target, presigned_url: url }] }));
    assert.deepEqual(out.ok, []);
    assert.match(out.failed[0].error, /moved while being written/);
    assert.deepEqual(fsMod.readdirSync(path.join(OUTSIDE, "moving")), [], "nothing was left outside");
  } finally {
    fsMod.ftruncateSync = real;
  }
});

test("a file inside that is also a name for a file outside is not written", async () => {
  const victim = path.join(OUTSIDE, "linked-victim");
  fs.writeFileSync(victim, "keep");
  fs.linkSync(victim, path.join(WORK, "g.txt"));
  const out = result(await downloadS3.execute({ files: [{ local_path: path.join(WORK, "g.txt"), presigned_url: url }] }));
  assert.deepEqual(out.ok, []);
  assert.match(out.failed[0].error, /one name/);
  assert.equal(fs.readFileSync(victim, "utf-8"), "keep");
});

test("a file already there and renamed out of the workspace mid-write keeps none of the bytes", async () => {
  const fsMod = (await import("node:fs")).default;
  const dir = path.join(WORK, "moving-existing");
  fsMod.mkdirSync(dir);
  fsMod.writeFileSync(path.join(dir, "h.txt"), "old");
  const real = fsMod.ftruncateSync;
  fsMod.ftruncateSync = ((fd: number, len?: number) => {
    fsMod.ftruncateSync = real;
    fsMod.renameSync(dir, path.join(OUTSIDE, "moving-existing"));
    return real(fd, len);
  }) as typeof real;
  try {
    const out = result(await downloadS3.execute({ files: [{ local_path: path.join(dir, "h.txt"), presigned_url: url }] }));
    assert.deepEqual(out.ok, []);
    assert.match(out.failed[0].error, /moved while being written/);
    assert.equal(fsMod.readFileSync(path.join(OUTSIDE, "moving-existing", "h.txt"), "utf-8"), "", "the bytes did not stay outside");
  } finally {
    fsMod.ftruncateSync = real;
  }
});
