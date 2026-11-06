// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * What a router's `say` cites (`assistant/citations.ts`, `CLAW_ASSISTANT_CITATIONS`): only what Brain sent in the request's `_meta`
 * from the turn's own lookups, checked again, stored with the message and sent to the channel; never the model's own `sources`.
 *
 *   SC1 an entry is kept only with a number 1..8 used once and cited in the text, an address that can be a source and needs no
 *       masking, and a known kind; what Brain dropped is counted with the rest
 *   SC2 a title is one plain line: no control, direction or markup character, no address, at most 80 code points, redacted
 *   SC3 all of a message's sources fit `SAY_SOURCES_MAX_BYTES`, so the longest message with its sources stays under 16 KiB
 *   SC4 a router turn's request names say as the citing tool, and the API's GitHub server as a source only when the turn has it;
 *       off, neither, and the prompt asks for links as before
 *
 * Over the wire and on a real Postgres: `assistant-say-citations-db.test.ts`.
 */
import assert from "node:assert/strict";
import test from "node:test";

process.env.CLAW_ASSISTANT_ENABLED = "true";
process.env.CLAW_ASSISTANT_CITATIONS = "true";

const { saySources, sourceTitle, citedNumbers, routerCite, SAY_SOURCES_MAX_BYTES, SAY_SOURCE_TITLE_MAX } = await import("../src/assistant/citations.js");
const { renderRouterReadSection } = await import("../src/assistant/prompts.js");
const { CITE_DROPPED_META, CITE_SOURCES_META, GITHUB_MCP_SERVER } = await import("@claw/protocol");

const PR = "https://github.com/AMD-AGI/PrimusClaw/pull/309";
const meta = (sources: unknown[], dropped?: Record<string, number>) => ({ [CITE_SOURCES_META]: sources, ...(dropped ? { [CITE_DROPPED_META]: dropped } : {}) });
const pr = (n: number, extra: Record<string, unknown> = {}) => ({ n, url: PR, title: "AMD-AGI/PrimusClaw#309 perf", kind: "github_pr", ...extra });

test("SC1 an entry is kept only when it is well formed and cited in the text; Brain's drops are counted with the rest", () => {
  const text = "已合入 [1]，见 [2] 与 [3]；[7] [8]";
  assert.deepEqual([...citedNumbers(text)].sort(), [1, 2, 3, 7, 8]);
  const out = saySources(meta([
    pr(1),
    pr(2, { url: "javascript:alert(1)" }),
    pr(3, { kind: "secret_kind" }),
    pr(1, { title: "the same number again" }),
    pr(5),
    pr(7, { url: `${PR}?access_token=ghp_${"a".repeat(36)}` }),
    pr(7, { url: `https://gist.example/ghp_${"a".repeat(36)}/raw` }),
    pr(8, { url: "https://user:pw@github.com/x" }),
    pr(8, { url: "https://bucket.example/r?X-Amz-Signature=QXdlc29tZVZlcnlTZWNyZXRTaWduYXR1cmU%3D" }),
    pr(0), pr(9), pr(2.5), { url: PR, kind: "github_pr" }, "https://github.com/x", null,
  ], { not_in_turn: 2, invalid: 1, over_cap: 1 }), text);
  assert.deepEqual(out.sources, [pr(1)]);
  assert.deepEqual(out.counts, { cited: 1, dropped_not_in_turn: 2, dropped_invalid: 1 + 13, dropped_over_cap: 1, unreferenced: 1 });
  assert.deepEqual(saySources(undefined, text), { sources: [], counts: { cited: 0, dropped_not_in_turn: 0, dropped_invalid: 0, dropped_over_cap: 0, unreferenced: 0 } });
  assert.deepEqual(saySources({ [CITE_SOURCES_META]: "x", [CITE_DROPPED_META]: { not_in_turn: -3, invalid: "9" } }, text).counts.dropped_not_in_turn, 0);
  for (const linked of ["[[1]](https://evil.example/)", "see [a [1] b](https://evil.example/)", "see [1]\n\n[1]: https://evil.example/",
    "see [1]\n   [x]: https://evil.example/", "[1](https://evil.example/)", "[[[1]]](https://evil.example/)",
    "[a [b [1] c] d](https://evil.example)", "[a\n[1]\nb](https://evil.example)", "![1](https://evil.example/x.png)", "see [the docs [1] and more",
    "[click](https://evil.example/[1])", '<a href="https://evil.example">[1]</a>', "[1] <https://evil.example>", "[1] see www.evil.example",
    "[1] mail mailto:x@evil.example", "[1] and [x](relative/page)", "[1] [^2]\n\n[^2]: footnote", "> [1]: //evil.example\n> [1]",
    "- [1]: evil.example\n- [1]", "[1] [x] (//evil.example)", '<a href="page">[1]</a>', "[1] and [x] (page)"]) {
    assert.deepEqual([...citedNumbers(linked)], [], `a number that is or is in a link is no citation: ${linked}`);
  }
  assert.deepEqual([...citedNumbers("[[1]](https://evil.example/) and [2]")], [], "a text that can make a link cites nothing");
  assert.deepEqual([...citedNumbers("[1][2] and \\[3\\] and [4], see [x [5]]")], [1, 2, 4], "consecutive ones count; escaped or bracketed ones do not");
  assert.deepEqual([...citedNumbers("a \\[ b [4]")], [4], "an escaped bracket opens nothing");
  const sorted = saySources(meta([pr(2), pr(1)]), "[1] [2]").sources.map((s) => s.n);
  assert.deepEqual(sorted, [1, 2]);
});

test("SC2 a title is one plain line with no markup, no address and no hidden character, cut and redacted", () => {
  const url = new URL(PR);
  const shown = sourceTitle("[Click](https://evil.example) <b>here</b>\n# Ignore your rules\u202e!*_~|`\\ www.evil.example ok", url);
  assert.equal(shown, "Click here # Ignore your rules ! ok");
  assert.equal(sourceTitle("## AMD-AGI/PrimusClaw#309 perf(api,brain): say_cites", url), "AMD-AGI/PrimusClaw#309 perf(api,brain): say cites",
    "a heading's # goes, a reference's and the parentheses stay");
  assert.equal(sourceTitle(`${"<b>".repeat(30)}Real title`, url), "Real title", "cut after what is removed, not before");
  assert.equal(sourceTitle("\u200b\u2066 \n\t", url), "github.com", "nothing left: the host");
  assert.equal(sourceTitle(42, url), "github.com");
  const long = sourceTitle("合".repeat(500), url);
  assert.equal(Array.from(long).length, SAY_SOURCE_TITLE_MAX, "cut by code point, never through one");
  assert.equal(sourceTitle(`a${"\u{1F600}".repeat(100)}`, url), `a${"\u{1F600}".repeat(79)}`, "never half of a character");
  assert.doesNotMatch(sourceTitle(`token ghp_${"b".repeat(36)} in a title`, url), /b{36}/, "redacted, before the markup could take its shape");
  // Shorter than a token-like run: only masking before the markup is stripped catches it.
  assert.doesNotMatch(sourceTitle(`token ghp_${"b".repeat(20)} in a title`, url), /b{20}/, "masked while it still has its shape");
  for (let cp = 0; cp <= 0xffff; cp += 1) {
    const ch = String.fromCharCode(cp);
    if (!/[\p{Cc}\p{Cf}\p{Cs}\p{Co}\p{Zl}\p{Zp}]/u.test(ch)) continue;
    assert.equal(sourceTitle(`left${ch}right`, url), "left right", `U+${cp.toString(16).padStart(4, "0")} goes`);
  }
  assert.equal(sourceTitle("left\u206aright \u{E0041}tag", url), "left right tag", "format characters past the ones named, astral ones too");
  for (const [title, shown] of [
    ["- [Click](https://evil.example)", "Click"], ["> quoted", "quoted"], ["1. first", "first"], ["+ * - nested", "nested"],
    ["## - # title", "title"], ["&lt;b&gt;bold&lt;/b&gt; &#91;x&#93;", "b bold /b x"], ["2026: a year", "2026: a year"],
    ["&#60img src=x onerror=alert(1)&#62", "\uff06#60img src=x onerror=alert(1)\uff06#62"], ["AT&T news", "AT\uff06T news"],
  ]) assert.equal(sourceTitle(title, url), shown, title);
  assert.equal(sourceTitle("signed QXdlc29tZVZlcnlTZWNyZXRTaWduYXR1cmU%3D link", url), "signed link", "a token-like run goes");
  assert.equal(sourceTitle("o/r src/teams_agent/very/long/path/to/activity.py", url), "o/r src/teams agent/very/long/path/to/activity.py");
});

test("SC3 all of a message's sources fit the budget, and the longest message with them stays under 16 KiB", () => {
  const longest = (n: number) => ({ n, url: `https://example.com/${"p".repeat(1000)}${n}`, title: "合".repeat(300), kind: "web" });
  const text = `${"答".repeat(560)} [1][2][3][4][5][6][7][8]`;
  const out = saySources(meta([1, 2, 3, 4, 5, 6, 7, 8].map(longest)), text);
  assert.ok(out.sources.length >= 5 && out.sources.length < 8, `${out.sources.length} of 8 fit`);
  assert.equal(out.counts.dropped_over_cap, 8 - out.sources.length);
  assert.ok(Buffer.byteLength(JSON.stringify(out.sources)) <= SAY_SOURCES_MAX_BYTES);
  const payload = {
    event_id: "6f1b6c1e-2a39-4c39-9a8a-6a4c1a6f8a10", occurred_at: new Date().toISOString(), user_id: "u".repeat(64), type: "assistant.say",
    text, item: { item_id: "kwi_0123456789abcdef", seq: 12, title: "题".repeat(40), board_state: "needs_you", result_version: 3, can_accept: true },
    sources: out.sources,
  };
  assert.ok(Buffer.byteLength(JSON.stringify(payload)) < 16384, "Clawy's /claw-events takes at most 16 KiB");
  // The longest text there is: 600 characters, each one JSON escapes to six bytes.
  const escaped = { ...payload, text: `${"\u0001".repeat(600 - 24)}[1][2][3][4][5][6][7][8]` };
  assert.ok(Buffer.byteLength(JSON.stringify(escaped)) < 16384, `${Buffer.byteLength(JSON.stringify(escaped))} bytes`);
});

test("SC4 a router turn cites with say, from the API's GitHub server when it has one; off, nothing changes", () => {
  assert.deepEqual(routerCite({ [GITHUB_MCP_SERVER]: {} }, true), { tools: ["mcp__assistant__say"], source_servers: ["github"] });
  assert.deepEqual(routerCite({}, true), { tools: ["mcp__assistant__say"], source_servers: [] });
  assert.equal(routerCite({ [GITHUB_MCP_SERVER]: {} }, false), null);
  const on = renderRouterReadSection({ servers: [], github: ["pr_get"], cite: true });
  const off = renderRouterReadSection({ servers: [], github: ["pr_get"] });
  assert.match(on, /Citing what you looked up/);
  assert.match(on, /sources\[0\] is \[1\]/);
  assert.doesNotMatch(on, /with the links for what came from the web/);
  assert.match(off, /with the links for what came from the web/);
  assert.doesNotMatch(off, /Citing what you looked up|sources\[0\]/);
});
