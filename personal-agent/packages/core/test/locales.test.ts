// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import assert from "node:assert/strict";
import test from "node:test";
import { defineCatalog, LANGS, toLang } from "../src/index.js";

test("toLang reads exactly zh as zh and anything else as en, as the Python worker does", () => {
  assert.equal(toLang("zh"), "zh");
  for (const en of ["en", "ZH", " zh ", "zh-CN", "zh_Hans", "", undefined, "fr", "zhx"]) {
    assert.equal(toLang(en), "en", String(en));
  }
});

test("a catalog gives each language its own text, with parameters", () => {
  const text = defineCatalog({
    en: { hello: "Hello", upload: (p: { url: string }) => `Upload it here:\n${p.url}` },
    zh: { hello: "你好", upload: (p) => `请在这里上传：\n${p.url}` },
  });
  assert.deepEqual(LANGS, ["en", "zh"]);
  assert.equal(text.in("en").hello, "Hello");
  assert.equal(text.in("zh").hello, "你好");
  assert.equal(text.in("en").upload({ url: "https://x.test/a" }), "Upload it here:\nhttps://x.test/a");
  assert.equal(text.in("zh").upload({ url: "https://x.test/a" }), "请在这里上传：\nhttps://x.test/a");
});
