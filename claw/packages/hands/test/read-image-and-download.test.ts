// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * `read` of a picture answers with the picture, and `download_from_s3` leaves a
 * file it already holds at the offered size alone.
 */
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";

import { read } from "../src/tools/fs/read.js";
import { IMAGE_MAX_BYTES } from "../src/tools/fs/read-image.js";
import { downloadS3 } from "../src/tools/s3/download-s3.js";

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC", "base64");
// An 8x8 grey baseline JPEG, accepted by the model API through the live proxy (2026-11-03).
const JPEG = Buffer.from("/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQH/wAALCAAIAAgBAREA/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/9oACAEBAAA/ACv/2Q==", "base64");
// The first ten bytes of a JPEG: the signature is right, the file is not; the API answers "Could not process image".
const TRUNCATED_JPEG = JPEG.subarray(0, 10);

let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), "claw-hands-image-")); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

function put(name: string, body: Buffer | string): string {
  const p = path.join(dir, name);
  fs.writeFileSync(p, body);
  return p;
}

type Block = { type: string; text?: string; data?: string; mimeType?: string };

test("a PNG is read as an image block after one line naming it", async () => {
  const p = put("shot.png", PNG);
  const res = await read.execute({ path: p }) as { content: Block[]; isError?: boolean };
  assert.equal(res.isError, undefined);
  assert.equal(res.content.length, 2);
  assert.match(res.content[0].text!, /^Image .*shot\.png \(image\/png, \d+ bytes\)$/);
  assert.deepEqual(res.content[1], { type: "image", data: PNG.toString("base64"), mimeType: "image/png" });
});

test("the media type comes from the bytes, not the name", async () => {
  const res = await read.execute({ path: put("photo.png", JPEG) }) as { content: Block[] };
  assert.equal(res.content[1].mimeType, "image/jpeg");
});

test("a file named as an image that is not one is refused, not sent as an image", async () => {
  const res = await read.execute({ path: put("fake.jpg", "just text") }) as { content: Block[]; isError?: boolean };
  assert.equal(res.isError, true);
  assert.equal(res.content.length, 1);
  assert.match(res.content[0].text!, /is not a PNG, JPEG, GIF or WebP image/);
});

test("a damaged image is refused, not sent as an image", async () => {
  const brokenPng = Buffer.from(PNG);
  brokenPng[brokenPng.length - 5] ^= 0xff;   // the IEND chunk's CRC
  for (const [name, body] of [["cut.jpg", TRUNCATED_JPEG], ["crc.png", brokenPng], ["half.png", PNG.subarray(0, 40)]] as const) {
    const res = await read.execute({ path: put(name, body) }) as { content: Block[]; isError?: boolean };
    assert.equal(res.isError, true, name);
    assert.match(res.content[0].text!, /is a damaged or incomplete (JPEG|PNG) file/, name);
    assert.ok(!res.content.some((b) => b.type === "image"), name);
  }
});

test("an image over the size bound is refused with what to do instead", async () => {
  const big = Buffer.alloc(IMAGE_MAX_BYTES + 1);
  PNG.copy(big);
  const res = await read.execute({ path: put("big.png", big) }) as { content: Block[]; isError?: boolean };
  assert.equal(res.isError, true);
  assert.match(res.content[0].text!, /Make a smaller copy/);
  assert.ok(!res.content.some((b) => b.type === "image"));
});

test("any other file is still read as text", async () => {
  const res = await read.execute({ path: put("notes.txt", "hello") }) as { content: Block[] };
  assert.deepEqual(res.content, [{ type: "text", text: "hello" }]);
});

async function serve(body: string): Promise<{ url: string; hits: () => number; close: () => Promise<void> }> {
  let hits = 0;
  const server = http.createServer((_req, res) => { hits++; res.end(body); });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}/obj`, hits: () => hits, close: () => new Promise((r) => server.close(() => r())) };
}

function parsed(res: { content: Array<{ text: string }> }) {
  return JSON.parse(res.content[0].text) as { ok: string[]; failed: unknown[] };
}

test("a file already held at the offered size is not fetched again", async () => {
  const s = await serve("new body");
  try {
    const p = put("held.pdf", "12345678");
    const out = parsed(await downloadS3.execute({ files: [{ local_path: p, presigned_url: s.url, size: 8 }] }));
    assert.deepEqual(out.ok, [p]);
    assert.equal(s.hits(), 0);
    assert.equal(fs.readFileSync(p, "utf-8"), "12345678");
  } finally { await s.close(); }
});

test("a file of another size, or one offered with no size, is fetched", async () => {
  const s = await serve("new body");
  try {
    const p = put("changed.pdf", "old");
    const q = path.join(dir, "missing", "x.pdf");
    const out = parsed(await downloadS3.execute({ files: [
      { local_path: p, presigned_url: s.url, size: 8 },
      { local_path: q, presigned_url: s.url, size: 8 },
    ] }));
    assert.deepEqual(out.ok, [p, q]);
    assert.equal(s.hits(), 2);
    assert.equal(fs.readFileSync(p, "utf-8"), "new body");
    const r = put("nosize.pdf", "new body");
    parsed(await downloadS3.execute({ files: [{ local_path: r, presigned_url: s.url }] }));
    assert.equal(s.hits(), 3, "with no size there is nothing to compare, so it is fetched");
  } finally { await s.close(); }
});
