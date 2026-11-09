// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import assert from "node:assert/strict";
import test from "node:test";
import { MARK_CLOSE, MARK_OPEN, markedText } from "../../src/inbound-text/marked-text.js";
import { insertLinks, withLinks } from "../../src/inbound-text/with-links.js";
import type { InboundMention } from "../../src/ports/surface.js";

const PR = "https://github.com/example-org/example-repo/pull/204";
const mask = (text: string): string => text.replace(/ghp_[A-Za-z0-9]+/g, "[hidden]");

test("an address goes after the words shown for it, or on a line of its own", () => {
  assert.equal(
    insertLinks("fix the plugin check", [{ url: PR, title: "fix the plugin check" }]),
    `fix the plugin check <${PR}>`,
  );
  assert.equal(insertLinks("review this", [{ url: PR, title: "Fix it" }]), `review this\nFix it <${PR}>`);
  assert.equal(insertLinks("see this", [{ url: PR, title: "" }]), `see this\n${PR}`);
  assert.equal(insertLinks(`review ${PR}`, [{ url: PR, title: "" }]), `review ${PR}`);
});

test("the same words for two links go to the two places they stand", () => {
  const links = [
    { url: "https://example.test/a", title: "here" },
    { url: "https://example.test/b", title: "here" },
  ];
  assert.equal(
    insertLinks("see here and here", links),
    "see here <https://example.test/a> and here <https://example.test/b>",
  );
  assert.equal(insertLinks("only here", links), "only here <https://example.test/a>\nhere <https://example.test/b>");
});

test("a group masks a credential in an address and a one to one chat does not", () => {
  const url = "https://example.test/doc?token=ghp_" + "A1b2C3d4E5".repeat(4);
  const links = [{ url, title: "the docs" }];
  assert.equal(
    withLinks("read the docs", links, { group: true, redact: mask }),
    "read the docs <https://example.test/doc?token=[hidden]>",
  );
  assert.equal(withLinks("read the docs", links, { redact: mask }), `read the docs <${url}>`);
  assert.equal(withLinks("read the docs", links), `read the docs <${url}>`);
});

const BOB: InboundMention = { channelUserId: "29:bob", userId: "aad-bob", name: "Bob", shown: "Bob" };
const DANA: InboundMention = { channelUserId: "29:dana", userId: "", name: "Dana", shown: "Dana" };

test("each mention is replaced by its marker, in order", () => {
  const marked = markedText("请 Bob 帮我 review, cc Dana", [BOB, DANA]);
  assert.equal(marked.text, `请 ${MARK_OPEN}0${MARK_CLOSE} 帮我 review, cc ${MARK_OPEN}1${MARK_CLOSE}`);
  assert.deepEqual(marked.mentions, [BOB, DANA]);
});

test("a typed marker is no mention and a mention not in the text is left out", () => {
  const marked = markedText(` ${MARK_OPEN}0${MARK_CLOSE} ask Dana `, [BOB, DANA, { ...BOB, shown: "" }]);
  assert.equal(marked.text, `0 ask ${MARK_OPEN}0${MARK_CLOSE}`);
  assert.deepEqual(marked.mentions, [DANA]);
});

test("the marked text gets the addresses behind its links, masked in a group", () => {
  const marked = markedText("ask Bob about fix it", [BOB], {
    links: [{ url: "https://example.test/x?k=ghp_abc", title: "fix it" }],
    group: true,
    redact: mask,
  });
  assert.equal(marked.text, `ask ${MARK_OPEN}0${MARK_CLOSE} about fix it <https://example.test/x?k=[hidden]>`);
});
