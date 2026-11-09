// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import assert from "node:assert/strict";
import test from "node:test";
import { safeName } from "../../src/inbound/names.js";
import { fileType, imageType, refusedType } from "../../src/inbound/types.js";
import { bytes, pasted, PNG, sent } from "./fakes.js";

const cases: readonly (readonly [string, Uint8Array, number, string])[] = [
  ["report.pdf", bytes("%PDF"), 1, "report.pdf"],
  ["../../etc/passwd", bytes("x"), 1, "passwd"],
  ["C:\\Users\\a\\log.txt", bytes("x"), 1, "log.txt"],
  [".bashrc", bytes("x"), 1, "bashrc"],
  ["a..b.csv", bytes("x"), 1, "a_b.csv"],
  ["weird<>|name?.txt", bytes("x"), 1, "weird_name_.txt"],
  ["", PNG, 2, "image-2.png"],
  ["", new Uint8Array([0xff, 0xd8, 0xff, 0xe0]), 3, "image-3.jpg"],
  ["", new Uint8Array([...bytes("RIFF"), 0, 0, 0, 0, ...bytes("WEBPVP8 ")]), 1, "image-1.webp"],
  ["", bytes("unknown"), 4, "image-4"],
  ["x".repeat(300) + ".pdf", bytes("x"), 1, "x".repeat(90) + ".pdf"],
];

for (const [name, content, index, expected] of cases) {
  test(`a file name is one safe path component: ${JSON.stringify(name)}`, () => {
    assert.equal(safeName(name, content, index), expected);
  });
}

test("a long name without a short extension is cut to 100 characters", () => {
  assert.equal(safeName("y".repeat(150), bytes("x"), 1), "y".repeat(100));
  assert.equal(safeName(`${"y".repeat(150)}.abcdefghijk`, bytes("x"), 1), "y".repeat(100));
});

test("a name of other scripts becomes underscores, one per run", () => {
  assert.equal(safeName("报告 2026.pdf", bytes("x"), 1), "_ 2026.pdf");
  assert.equal(safeName("😀😀.txt", bytes("x"), 1), "_.txt");
});

test("a gif is told by its bytes, either version", () => {
  assert.equal(imageType(bytes("GIF87a....")), "gif");
  assert.equal(imageType(bytes("GIF89a....")), "gif");
  assert.equal(imageType(bytes("RIFF")), "");
  assert.equal(imageType(new Uint8Array()), "");
});

test("a sent file's type is teams' type, else its name's extension", () => {
  assert.equal(fileType(sent("a.PDF", "https://x.test/a")), "pdf");
  assert.equal(fileType(sent("a.pdf", "https://x.test/a", "docx")), "docx");
  assert.equal(fileType(sent("README", "https://x.test/a")), "");
  assert.equal(fileType(sent(".bashrc", "https://x.test/a")), "", "a name that is only an extension has none");
  assert.equal(fileType(sent("a.tar-gz", "https://x.test/a")), "");
  assert.equal(fileType(sent("a.pdé", "https://x.test/a")), "");
  assert.equal(fileType(sent("a.", "https://x.test/a")), "");
});

test("a pasted image is never refused for its type, and the refusal names the type", () => {
  assert.equal(refusedType(pasted()), "");
  assert.equal(
    refusedType(sent("a.exe", "https://x.test/a")),
    "files of type .exe are not taken; text, logs, data, code, documents, images, audio, video and archives are",
  );
  assert.equal(
    refusedType(sent("README", "https://x.test/a")),
    "a file without a type is not taken; text, logs, data, code, documents, images, audio, video and archives are",
  );
});
