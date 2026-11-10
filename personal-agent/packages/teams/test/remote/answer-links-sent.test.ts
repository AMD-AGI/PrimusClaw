// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * What a remote agent and its connector write reaches the chat with nothing clickable in the message as it is sent (ported from
 * the Python worker's test_answer_links and test_meta_links): checked on the rich text activity Teams gets, not on the markdown.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { remoteDomain, remoteView, turn } from "@primusclaw/personal-agent";

import { SETUP, agent, connector } from "../../../../test-support/card-catalog/remote.js";
import { richTextActivity } from "../../src/richtext/index.js";
import { informativeText } from "../../src/stream/informative.js";

interface AnswerCase {
  readonly about: string;
  readonly input: string;
  readonly lang: "en" | "zh";
}
interface MetaCase {
  readonly input: string;
}

function cases<T>(name: string): T[] {
  const url = new URL(`../../../../test-support/data/${name}`, import.meta.url);
  return (JSON.parse(readFileSync(url, "utf8")) as { cases: T[] }).cases;
}

/** The message as it is sent: the chat's rich text, which makes a bare http(s) address a link by itself. */
function sent(markdown: string): string {
  const text = richTextActivity(markdown)["text"];
  assert.ok(typeof text === "string");
  return text;
}

/** No anchor, no image, no `href` in the activity as sent. */
function assertNothingClickable(html: string, label: string): void {
  assert.ok(!/<a[\s>]|<img[\s>]|href=/iu.test(html), `${label}: ${html}`);
}

/** The prose of the sent message: what is not drawn as code. */
function prose(html: string): string {
  return html.replace(/<code>[\s\S]*?<\/code>|<pre>[\s\S]*?<\/pre>/gu, "");
}

test("nothing clickable is left in the message as sent", () => {
  for (const c of cases<AnswerCase>("answer-link-cases.json")) {
    for (const part of remoteDomain.answerParts(c.input, c.lang)) {
      const html = sent(part);
      assertNothingClickable(html, c.about);
      assert.ok(!/(?<![\w`>])(https?|ftp):\/\//u.test(html.replaceAll("&#x200b;", "\u{200b}")), `${c.about}: ${html}`);
      assert.ok(
        !html.toLowerCase().includes("www.") && !part.replaceAll("\\", "").toLowerCase().includes("www."),
        c.about,
      );
    }
  }
});

test("a short line of an agent or a connector holds no link as sent", () => {
  for (const c of cases<MetaCase>("meta-link-cases.json")) {
    const html = sent(remoteDomain.lit(c.input, 200));
    assertNothingClickable(html, c.input);
  }
});

test("a connectors name and a health checks detail are no links as sent", () => {
  const machine = connector({
    connectorId: "c1",
    name: "dev-pod https://evil.example/x",
    online: true,
    agents: [
      agent({
        agentId: "cx",
        kind: "codex",
        name: "Codex www.evil.example",
        capabilities: {
          health: {
            problems: [
              { code: "something_new", severity: "fail", scope: "machine", detail: "see https://evil.example/fix" },
            ],
          },
        },
      }),
    ],
  });
  const html = sent(remoteDomain.agentsText([machine], SETUP, "en"));
  assertNothingClickable(html, "agents text");
  assert.ok(html.includes("evil.example"), html);
});

test("an agents plan and a tools title are no links as sent", () => {
  const view = new remoteView.RemoteLiveView("Codex", "en");
  view.apply(remoteDomain.remoteStep({ plan: "\u{1f4cb} Plan: 0 of 1 done, now: open https://evil.example/x" }));
  view.apply(remoteDomain.remoteStep({ note: "see https://note.example/y" }));
  view.apply(
    remoteDomain.remoteStep({ tool: { id: "t0", title: "fetch https://failed.example/z", status: "in_progress" } }),
  );
  view.apply(
    remoteDomain.remoteStep({ tool: { id: "t0", title: "fetch https://failed.example/z", status: "failed" } }),
  );
  view.apply(
    remoteDomain.remoteStep({ tool: { id: "t1", title: "Fetch https://running.example/w", status: "in_progress" } }),
  );
  view.apply(
    remoteDomain.remoteStep({ chunk: { kind: "message", text: "reading [docs](https://docs.example/x) now" } }),
  );
  view.apply(remoteDomain.remoteStep({ tool: { id: "t2", title: "x", status: "completed" } }));
  view.apply(remoteDomain.remoteStep({ chunk: { kind: "thought", text: "check https://t.example/y first" } }));
  const html = sent(view.render());
  assertNothingClickable(html, "live view");
  for (const host of [
    "evil.example",
    "note.example",
    "failed.example",
    "running.example",
    "docs.example",
    "t.example",
  ]) {
    assert.ok(html.includes(host), `${host}: ${html}`);
  }
  // (the floating status the stream starts with is the agent's plan and step titles)
  const status = informativeText(view.statusLines());
  assert.ok(!status.includes("://") && status.includes("evil.example") && status.includes("running.example"), status);
});

test("a bidi override cannot join an address once sent", () => {
  for (const hidden of ["\u{202e}", "\u{202a}", "\u{2066}", "\u{2069}"]) {
    const html = sent(remoteDomain.lit(`see https:${hidden}//evil.example/x`, 200));
    assertNothingClickable(html, JSON.stringify(hidden));
  }
});

test("a www address or an escaped one is no address once read", () => {
  for (const line of ["connector www.evil.example/x", "connector www\\.evil.example", "go https:\\/\\/evil.example"]) {
    const shown = remoteDomain.neutral(line, 200);
    assert.ok(
      !shown.replaceAll("\\", "").toLowerCase().includes("www.") && !shown.replaceAll("\\", "").includes("://"),
      shown,
    );
    assertNothingClickable(sent(shown), line);
  }
});

test("an address after any character is no link as sent", () => {
  for (const text of [
    "a@https://evil.example/x",
    "_https://evil.example/x",
    "xhttps://evil.example/x",
    "x/https://evil.example",
  ]) {
    assertNothingClickable(sent(remoteDomain.answerParts(text, "en").join("\n\n")), text);
  }
});

test("a block is code here exactly when the rich text draws it as code", () => {
  const texts = [
    "```lang`bad\nwww.evil.example\n```",
    "x\x85```\nwww.evil.example\n```",
    "x\u{2028}```\nwww.evil.example\n```",
    "\x0b```\nfoo\n```\nwww.evil.example\n```",
    "```\x1c\nfoo\n```\x0b\nwww.evil.example",
    "a\r```\rfoo\r```\rwww.evil.example",
    "~~~x`y\nfoo\n~~~\nwww.evil.example",
  ];
  for (const text of texts) {
    const html = sent(remoteDomain.inertAnswer(text));
    assert.ok(!prose(html).includes("www.") && !prose(html).includes("://"), `${JSON.stringify(text)}: ${html}`);
  }
});

test("a character the rich text drops cannot hide an address", () => {
  for (const control of ["\x01", "\x08", "\x1f", "\x7f", "\u{202e}", "\u{2069}", "\x00"]) {
    for (const text of [
      `https:${control}//evil.example/x`,
      `www${control}.evil.example`,
      `see h${control}ttps://evil.example`,
    ]) {
      for (const part of remoteDomain.answerParts(text, "en")) {
        const html = sent(part);
        assertNothingClickable(html, JSON.stringify(text));
        assert.ok(html.includes("evil.example") && !html.includes("://") && !html.includes("www."), html);
      }
    }
  }
});

test("a markdown escape cannot hide an address", () => {
  const texts = [
    "www\\.evil.example/path",
    "https:\\/\\/evil.example/x",
    "https\\:\\/\\/evil.example",
    "https:/\\/evil.example",
    "WWW\\\\.evil.example",
  ];
  for (const text of texts) {
    for (const part of remoteDomain.answerParts(text, "en")) {
      const html = sent(part);
      assertNothingClickable(html, text);
      for (const shown of [html, part.replaceAll("\\", "")]) {
        assert.ok(!shown.toLowerCase().includes("www.") && !shown.includes("://"), `${text}: ${shown}`);
      }
    }
  }
});

/** A small seeded generator, so a failure is the same failure again. */
function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

test("no address reaches the message as prose on random text", () => {
  const pieces = [
    "`",
    "```",
    "\n",
    "www.e.example",
    " ",
    "a",
    "~~~",
    "\x85",
    "\r",
    "\x0b",
    "\u{2028}",
    "    ",
    "x/",
    "(",
    ")",
    "[",
    "]",
    "https://e.example",
    "\n\n",
    ">",
    "- ",
    "|",
    "https:",
    "//e.example",
    "www",
    ".e.example",
    "\x01",
    "\x1f",
    "\x7f",
    "\u{202e}",
    "\u{2066}",
    "\x00",
  ];
  const random = seeded(11);
  for (let n = 0; n < 2000; n += 1) {
    const count = 1 + Math.floor(random() * 10);
    let text = "";
    for (let i = 0; i < count; i += 1) text += pieces[Math.floor(random() * pieces.length)] ?? "";
    const html = sent(remoteDomain.inertAnswer(text));
    assert.ok(!prose(html).includes("www.") && !prose(html).includes("://"), `${JSON.stringify(text)}: ${html}`);
    assertNothingClickable(html, JSON.stringify(text));
  }
});

test("claws own answer keeps its links", () => {
  const text = "See [the release](https://github.com/AMD-AGI/PrimusClaw/releases/tag/v1).";
  assert.ok((turn.answerParts(text, "")[0] ?? "").includes("[the release](https://github.com/"));
});
