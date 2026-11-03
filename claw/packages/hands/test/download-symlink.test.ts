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
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";

const WORK = fs.mkdtempSync(path.join(os.tmpdir(), "claw-dl-ws-"));
const OUTSIDE = fs.mkdtempSync(path.join(os.tmpdir(), "claw-dl-outside-"));
process.env.WORKSPACE_PATH = WORK;
const { downloadS3 } = await import("../src/tools/s3/download-s3.js");

const server = http.createServer((_req, res) => res.end("uploaded bytes"));
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/obj`;
after(() => {
  server.close();
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
