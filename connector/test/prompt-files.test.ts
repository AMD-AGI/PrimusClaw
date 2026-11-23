// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/** A prompt's files are saved inside the session's folder only: a symbolic link put there cannot send them elsewhere. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { savePromptFiles } from "../src/prompt-files.js";
import { tmpdir } from "./support/tmp.js";

const SID = "6f1c2a9b-8e7d-4c5b-a43f-2e1d0c9b8a7f";
const FILE = { name: "shot.png", media_type: "image/png", data: Buffer.from("new bytes").toString("base64") };
const promptDir = (root: string, cmdId: string): string =>
  path.join(root, SID, createHash("sha256").update(cmdId).digest("hex").slice(0, 16));

test("a prompt's files are saved in its own folder, and a redelivery writes the same bytes again", () => {
  const root = tmpdir();
  const [saved] = savePromptFiles(root, SID, "c1", [FILE]);
  assert.equal(saved?.path, path.join(promptDir(root, "c1"), "shot.png"));
  savePromptFiles(root, SID, "c1", [FILE]);
  assert.equal(fs.readFileSync(saved.path, "utf8"), "new bytes");
  assert.equal(fs.statSync(saved.path).mode & 0o777, 0o600);
});

test("a symbolic link where a file is saved is not followed: the file it points at is untouched", () => {
  const root = tmpdir();
  const outside = path.join(tmpdir(), "bashrc");
  fs.writeFileSync(outside, "mine");
  fs.mkdirSync(promptDir(root, "c2"), { recursive: true });
  fs.symlinkSync(outside, path.join(promptDir(root, "c2"), "shot.png"));
  assert.throws(() => savePromptFiles(root, SID, "c2", [FILE]));
  assert.equal(fs.readFileSync(outside, "utf8"), "mine");
});

test("a session's or a prompt's folder that is a symbolic link is refused: nothing is written where it points", () => {
  for (const linked of ["session", "prompt"] as const) {
    const root = tmpdir();
    const elsewhere = tmpdir();
    if (linked === "session") {
      fs.symlinkSync(elsewhere, path.join(root, SID));
    } else {
      fs.mkdirSync(path.join(root, SID));
      fs.symlinkSync(elsewhere, promptDir(root, "c3"));
    }
    assert.throws(() => savePromptFiles(root, SID, "c3", [FILE]), /not a plain folder/u);
    assert.deepEqual(fs.readdirSync(elsewhere), []);
  }
});
