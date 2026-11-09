// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

// The remote-agent catalogs say every sentence in both languages, Chinese where Chinese is asked for (`locales/`).
import assert from "node:assert/strict";
import { test } from "node:test";

import { connectorReasonHints, connectorReasonText } from "../../src/locales/connector-reasons.js";
import { connectorSetupText } from "../../src/locales/connector-setup.js";
import type { Catalog, Messages } from "../../src/locales/catalog.js";
import { SAID_IN_ENGLISH, remoteAgentText } from "../../src/locales/remote-agents.js";
import { remoteWindowText } from "../../src/locales/remote-window.js";

const CJK = /[一-鿿]/u;
/** Entries that are only punctuation around what the caller passes (a note, a mode id): nothing of them is a language. */
const FRAMES = new Set(["readyUnattended", "readyMode", "modeIs", "closedIn"]);

/** Every message of a catalog, said with sample parameters. */
function said(catalog: Catalog<Messages>, lang: "en" | "zh"): Map<string, string> {
  const params = {
    name: "dev-pod",
    ref: "dev-pod/codex",
    names: "`a`, `b`",
    code: "bad_code",
    status: 500,
    command: "cmd",
    version: "0.1.2",
    reason: "gone",
    bot: "Clawy",
    now: "",
  };
  return new Map(
    Object.entries(catalog.in(lang)).map(([key, message]) => [
      key,
      typeof message === "string" ? message : (message as (p: typeof params) => string)(params),
    ]),
  );
}

test("every remote-agent sentence exists in both languages and the chinese reads as chinese", () => {
  const catalogs = [
    remoteAgentText,
    remoteWindowText,
    connectorSetupText,
    connectorReasonText,
    connectorReasonHints,
  ] as Catalog<Messages>[];
  for (const catalog of catalogs) {
    const en = said(catalog, "en");
    const zh = said(catalog, "zh");
    assert.deepEqual([...zh.keys()], [...en.keys()]);
    for (const [key, text] of en) {
      assert.ok(text, key);
      assert.ok(!CJK.test(text), `${key}: ${text}`);
      const chinese = zh.get(key) ?? "";
      if (catalog === remoteAgentText && SAID_IN_ENGLISH.has(key)) assert.equal(chinese, text, key);
      else if (FRAMES.has(key)) continue;
      // (a separator or a punctuation-only entry is allowed to be the same, or empty, in both)
      else if (/[A-Za-z]{3}/u.test(text)) assert.ok(CJK.test(chinese), `${key}: ${chinese}`);
    }
  }
});
