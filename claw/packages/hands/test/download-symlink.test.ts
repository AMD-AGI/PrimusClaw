// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * `download_from_s3` writes only where the path names inside the workspace: not
 * through a symbolic link, not into another name of the same file, and not into
 * a directory renamed out meanwhile. Hands can write as an identity the model's
 * commands do not have, and the uploads a reused sandbox is given land in a
 * directory those commands could change while the download runs.
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

/** Replace `fs.<name>` until its first call, running `meanwhile` just before that call goes through. */
function onFirstCall(name: "renameSync" | "writeFileSync", meanwhile: (...args: any[]) => void): () => void {
  const real = fs[name] as (...args: any[]) => any;
  (fs as any)[name] = (...args: any[]) => {
    (fs as any)[name] = real;
    meanwhile(...args);
    return real(...args);
  };
  return () => { (fs as any)[name] = real; };
}

function outsideHolds(text: string): string[] {
  return (fs.readdirSync(OUTSIDE, { recursive: true }) as string[])
    .map((n) => path.join(OUTSIDE, n))
    .filter((f) => fs.lstatSync(f).isFile() && fs.readFileSync(f, "utf-8").includes(text));
}

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

test("a final link is replaced in the workspace, never written through", async () => {
  fs.mkdirSync(path.join(WORK, ".uploads"), { recursive: true });
  const victim = path.join(OUTSIDE, "victim");
  fs.writeFileSync(victim, "keep");
  const target = path.join(WORK, ".uploads", "b.txt");
  fs.symlinkSync(victim, target);
  const out = result(await downloadS3.execute({ files: [{ local_path: target, presigned_url: url }] }));
  assert.deepEqual(out.ok, [target]);
  assert.equal(fs.readFileSync(victim, "utf-8"), "keep");
  assert.equal(fs.lstatSync(target).isFile(), true);
  assert.equal(fs.readFileSync(target, "utf-8"), "uploaded bytes");
});

test("an ordinary path is written, readable as any new file is", async () => {
  const target = path.join(WORK, ".uploads", "c", "d.txt");
  const out = result(await downloadS3.execute({ files: [{ local_path: target, presigned_url: url }] }));
  assert.deepEqual(out.ok, [target]);
  assert.equal(fs.readFileSync(target, "utf-8"), "uploaded bytes");
  assert.equal(fs.statSync(target).mode & 0o777, 0o666 & ~process.umask());
  assert.deepEqual(fs.readdirSync(path.dirname(target)), ["d.txt"], "no part file is left");
});

test("a directory swapped for a link right after it is made is not written through", async () => {
  const dir = path.join(WORK, "race");
  const realMkdir = fs.mkdirSync;
  // The swap lands between making the directory and opening it.
  fs.mkdirSync = ((at: string, opts: unknown) => {
    const made = realMkdir(at, opts as never);
    if (String(at).endsWith("/race")) {
      fs.rmSync(dir, { recursive: true, force: true });
      fs.symlinkSync(OUTSIDE, dir);
    }
    return made;
  }) as typeof realMkdir;
  try {
    const out = result(await downloadS3.execute({ files: [{ local_path: path.join(dir, "e.txt"), presigned_url: url }] }));
    assert.deepEqual(out.ok, []);
    assert.match(out.failed[0].error, /race is a symbolic link/);
    assert.deepEqual(outsideHolds("uploaded bytes"), [], "nothing was written outside");
  } finally {
    fs.mkdirSync = realMkdir;
  }
});

test("while the bytes are written, the file is one only Hands can open", async () => {
  let modeWhileWritten = -1;
  const restore = onFirstCall("writeFileSync", (fd: number) => { modeWhileWritten = fs.fstatSync(fd).mode & 0o777; });
  try {
    const out = result(await downloadS3.execute({ files: [{ local_path: path.join(WORK, "private", "q.txt"), presigned_url: url }] }));
    assert.equal(out.ok.length, 1);
    assert.equal(modeWhileWritten, 0o600);
  } finally {
    restore();
  }
});

test("a file already in the workspace is replaced by the download", async () => {
  const target = path.join(WORK, ".uploads", "c", "d.txt");
  fs.writeFileSync(target, "an older and longer body that must not survive");
  const out = result(await downloadS3.execute({ files: [{ local_path: target, presigned_url: url }] }));
  assert.deepEqual(out.ok, [target]);
  assert.equal(fs.readFileSync(target, "utf-8"), "uploaded bytes");
});

test("a file inside that is also a name for a file outside gets a new file, the outside one is untouched", async () => {
  const victim = path.join(OUTSIDE, "linked-victim");
  fs.writeFileSync(victim, "keep");
  const target = path.join(WORK, "g.txt");
  fs.linkSync(victim, target);
  const out = result(await downloadS3.execute({ files: [{ local_path: target, presigned_url: url }] }));
  assert.deepEqual(out.ok, [target]);
  assert.equal(fs.readFileSync(victim, "utf-8"), "keep");
  assert.equal(fs.readFileSync(target, "utf-8"), "uploaded bytes");
});

for (const existing of [false, true]) {
  test(`a directory renamed out of the workspace before the file takes its name keeps none of the bytes (${existing ? "replacing a file" : "new file"})`, async () => {
    const name = `moving-${existing}`;
    const dir = path.join(WORK, name);
    fs.mkdirSync(dir);
    if (existing) fs.writeFileSync(path.join(dir, "f.txt"), "old");
    const restore = onFirstCall("renameSync", () => fs.renameSync(dir, path.join(OUTSIDE, name)));
    try {
      const out = result(await downloadS3.execute({ files: [{ local_path: path.join(dir, "f.txt"), presigned_url: url }] }));
      assert.deepEqual(out.ok, []);
      assert.match(out.failed[0].error, /moved while being written/);
      assert.deepEqual(outsideHolds("uploaded bytes"), [], "the bytes did not stay outside");
    } finally {
      restore();
    }
  });
}

test("a write that fails part way leaves no part of the download", async () => {
  const target = path.join(WORK, "partial", "p.txt");
  const restore = onFirstCall("writeFileSync", (fd: number) => {
    fs.writeSync(fd, "uploaded");
    throw Object.assign(new Error("no space left on device"), { code: "ENOSPC" });
  });
  try {
    const out = result(await downloadS3.execute({ files: [{ local_path: target, presigned_url: url }] }));
    assert.deepEqual(out.ok, []);
    assert.match(out.failed[0].error, /no space left/);
    assert.deepEqual(fs.readdirSync(path.dirname(target)), [], "neither the file nor its part is left");
  } finally {
    restore();
  }
});
