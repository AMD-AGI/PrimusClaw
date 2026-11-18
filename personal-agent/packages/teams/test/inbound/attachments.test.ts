// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import assert from "node:assert/strict";
import test from "node:test";
import { FILE_DOWNLOAD_INFO, inboundFiles } from "../../src/inbound/attachments.js";
import { refusedType } from "../../src/inbound/types.js";
import { BOT_URL, dm, fileInfo, image, SHAREPOINT } from "./fakes.js";

test("a pasted image and a sent file are taken and the rest is named or ignored", () => {
  const { files, unreadable } = inboundFiles(
    dm("look", [
      image(),
      image(BOT_URL, "image/png"),
      fileInfo(),
      { contentType: "text/html", content: "<p>look</p>" },
      { contentType: "application/vnd.microsoft.card.adaptive", content: {} },
      { contentType: "reference", name: "plan.docx", contentUrl: "https://contoso.sharepoint.com/plan.docx" },
      { contentType: "image/*" }, // an image with no address cannot be fetched and is not one
      "junk",
    ]),
  );
  assert.deepEqual(files, [
    { name: "", type: "", handle: { kind: "pasted", url: BOT_URL, index: 1 } },
    { name: "", type: "", handle: { kind: "pasted", url: BOT_URL, index: 2 } },
    { name: "report.pdf", type: "pdf", handle: { kind: "download", url: SHAREPOINT, index: 3 } },
  ]);
  assert.deepEqual(unreadable, ["plan.docx"]);
});

test("teams file type is what a sent file is judged by", () => {
  const { files } = inboundFiles(dm("x", [fileInfo("report.pdf", SHAREPOINT, "exe")]));
  assert.equal(files.length, 1);
  const file = files[0];
  assert.ok(file);
  assert.equal(file.type, "exe");
  assert.ok(refusedType(file));
});

test("a sent file's type is lower case, without a leading dot, at most 20 characters", () => {
  const { files } = inboundFiles(
    dm("x", [
      fileInfo("a", SHAREPOINT, ".PDF"),
      fileInfo("b", SHAREPOINT, "x".repeat(30)),
      fileInfo("c", SHAREPOINT, ""),
    ]),
  );
  assert.deepEqual(
    files.map((f) => f.type),
    ["pdf", "x".repeat(20), ""],
  );
});

test("a download info without a link, or a content that is not an object, names the file as unreadable", () => {
  const { files, unreadable } = inboundFiles(
    dm("x", [
      { contentType: FILE_DOWNLOAD_INFO, name: "a.pdf", content: { downloadUrl: 7 } },
      { contentType: FILE_DOWNLOAD_INFO, name: "b.pdf", content: "not an object" },
      { contentType: "IMAGE/PNG", contentUrl: BOT_URL, name: "shot.png" },
      { contentType: 5, name: 12 },
    ]),
  );
  assert.deepEqual(
    files.map((f) => [f.name, f.handle["kind"]]),
    [["shot.png", "pasted"]],
  );
  assert.deepEqual(unreadable, ["a.pdf", "b.pdf", "12"]);
});

test("an activity without attachments has no files", () => {
  for (const activity of [{}, { attachments: null }, { attachments: "x" }, null, "activity"]) {
    assert.deepEqual(inboundFiles(activity), { files: [], unreadable: [] });
  }
});
