// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import assert from "node:assert/strict";
import { test } from "node:test";

import { markText, withLinks } from "../../src/review/message.js";

test("mentions become markers in order and a typed marker is dropped", () => {
  const marked = markText(
    "⟦9⟧请 <at>Bob</at> 和 <at>Carol</at> review 合入，cc <at>Zed</at>",
    [
      { channelUserId: "29:b", userId: "aad-b", name: "Bob", shown: "<at>Bob</at>" },
      { channelUserId: "29:c", userId: "", name: "Carol", shown: "<at>Carol</at>" },
      { channelUserId: "29:q", userId: "", name: "Q", shown: "<at>Q</at>" },
    ],
    [],
  );
  // (the typed marker characters go, what was between them stays: it is no mention)
  assert.equal(marked.text, "9请 ⟦0⟧ 和 ⟦1⟧ review 合入，cc Zed");
  assert.deepEqual(
    marked.mentions.map((m) => m.channelUserId),
    ["29:b", "29:c"],
  );
});

test("a link's address goes after the words shown for it, or on a line of its own", () => {
  const url = "https://github.com/AMD-AGI/x/pull/1";
  assert.equal(
    withLinks("请 Bob review 合入 这个 PR", [{ url, title: "这个 PR" }]),
    `请 Bob review 合入 这个 PR <${url}>`,
  );
  assert.equal(withLinks("看看", [{ url, title: "elsewhere" }]), `看看\nelsewhere <${url}>`);
  assert.equal(withLinks("看看", [{ url, title: "" }]), `看看\n${url}`);
  assert.equal(withLinks(`已有 ${url}`, [{ url, title: "x" }]), `已有 ${url}`);
  assert.equal(
    withLinks("PR 和 PR", [
      { url: "u1", title: "PR" },
      { url: "u2", title: "PR" },
    ]),
    "PR <u1> 和 PR <u2>",
  );
  assert.equal(
    markText("see it", [], [{ url: "https://h/?token=abc", title: "it" }], () => "masked").text,
    "see it <masked>",
  );
});
