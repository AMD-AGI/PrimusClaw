// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The hyperlinks behind the words of a message: a link shown as other words, a link preview, an entity's url. Ported
 * from the Python suite's test_message_links.py; what it asked of the agent, the store and the review requests belongs
 * to those lines.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { MARK_CLOSE, MARK_OPEN } from "@primusclaw/personal-agent";
import { LINK_COUNT, linksOf, messageText, type Activity } from "../../src/activity/inbound/index.js";
import {
  dm,
  grp,
  htmlAttachment,
  markedTextOf,
  quoteBlockOf,
  replyEntity,
  replyHtml,
  said,
  WHEN,
  withLinksOf,
} from "./fixtures.js";

const PR = "https://github.com/example-org/example-repo/pull/204";

function anchor(url = PR, words = "fix the plugin check"): string {
  return `<a href="${url}" rel="noreferrer noopener" target="_blank">${words}</a>`;
}

function htmlOf(inner: string): Record<string, unknown> {
  return htmlAttachment(`<p>${inner}</p>`);
}

function thumbnail(url = PR, title = "Fix the plugin check", image = "https://cdn.example.test/preview.png") {
  return {
    contentType: "application/vnd.microsoft.card.thumbnail",
    content: {
      title,
      text: "example-org/example-repo",
      images: [{ url: image }],
      tap: { type: "openUrl", value: url },
      buttons: [{ type: "openUrl", title: "Open", value: url }],
    },
  };
}

function adaptive(url = PR, title = "Fix the plugin check") {
  return {
    contentType: "application/vnd.microsoft.card.adaptive",
    content: {
      type: "AdaptiveCard",
      version: "1.4",
      body: [
        { type: "Image", url: "https://cdn.example.test/logo.png" },
        { type: "TextBlock", text: title },
      ],
      actions: [{ type: "Action.OpenUrl", title, url }],
    },
  };
}

const ASK = "请 <at>Bob</at> 帮我 review 合入";
const BOB = { type: "mention", text: "<at>Bob</at>", mentioned: { id: "29:bob", name: "Bob" } };

/** A group request to review and merge, as Teams shows it: the words in `text`, the bot's mention and Bob's. */
function ask(textAfter: string, attachments: readonly unknown[] = []): Activity {
  return grp(`<at>PrimusClaw Assistant</at> ${ASK} ${textAfter}`.trimEnd(), { entities: [BOB], attachments });
}

const SHAPES: readonly [string, Activity, string][] = [
  [
    "a link shown as other words (1:1)",
    dm("fix the plugin check", { attachments: [htmlOf(anchor())] }),
    `fix the plugin check <${PR}>`,
  ],
  [
    "a link shown as other words, in a sentence",
    dm("please look at fix the plugin check today", {
      attachments: [htmlOf("please look at " + anchor() + " today")],
    }),
    `please look at fix the plugin check <${PR}> today`,
  ],
  [
    "tags inside the link",
    dm("the plugin check", { attachments: [htmlOf(anchor(PR, "the <b>plugin</b> check"))] }),
    `the plugin check <${PR}>`,
  ],
  [
    "a link in a group message",
    grp("<at>PrimusClaw Assistant</at> check fix the plugin check", {
      attachments: [htmlOf('<at id="0">PrimusClaw Assistant</at> check ' + anchor())],
    }),
    `check fix the plugin check <${PR}>`,
  ],
  [
    "a preview card and no address in the words (Bot Framework thumbnail card)",
    dm("review this", { attachments: [htmlOf("review this"), thumbnail()] }),
    `review this\nFix the plugin check <${PR}>`,
  ],
  [
    "a preview card (Adaptive Card, Action.OpenUrl)",
    dm("review this", { attachments: [adaptive()] }),
    `review this\nFix the plugin check <${PR}>`,
  ],
  [
    "a preview card whose title is in the words",
    dm("Fix the plugin check", { attachments: [thumbnail()] }),
    `Fix the plugin check <${PR}>`,
  ],
  [
    "an entity that has a url",
    dm("see this", { entities: [{ type: "https://schema.org/Message", name: "The PR", url: PR }] }),
    `see this\n${PR}`,
  ],
  [
    "two links, the second one's words are not in the text",
    dm("one and two", {
      attachments: [
        htmlOf(anchor("https://example.test/a", "one") + " and " + anchor("https://example.test/b", "other")),
      ],
    }),
    "one <https://example.test/a> and two\nother <https://example.test/b>",
  ],
  [
    "the same words for two links go to the two places they stand",
    dm("see here and here", {
      attachments: [
        htmlOf("see " + anchor("https://example.test/a", "here") + " and " + anchor("https://example.test/b", "here")),
      ],
    }),
    "see here <https://example.test/a> and here <https://example.test/b>",
  ],
  [
    "a link with no words of its own (an image)",
    dm("look", { attachments: [htmlOf(anchor(PR, '<img src="x">'))] }),
    `look\n${PR}`,
  ],
  [
    "with a quote: the user's link is added, the quote stays out of it",
    dm('<quoted messageId="m-100"/> fix the plugin check', {
      entities: [replyEntity()],
      attachments: [
        htmlAttachment(
          replyHtml({ preview: "see " + anchor("https://example.test/old", "the old PR"), own: anchor() }),
        ),
      ],
    }),
    `fix the plugin check <${PR}>`,
  ],
];

for (const [name, activity, expected] of SHAPES) {
  test(`the address behind the words is in the text: ${name}`, () => {
    assert.equal(said(activity), expected, name);
  });
}

// --- left alone ------------------------------------------------------------------------------------------------------

const UNCHANGED: readonly [string, Activity][] = [
  ["a plain message", dm("what is the status of node 3?")],
  ["a plain address, with its html", dm(`review ${PR}`, { attachments: [htmlOf("review " + anchor(PR, PR))] })],
  ["a plain address, no html", dm(`review ${PR}`)],
  [
    "the html of a message with no link (a trace of Teams)",
    dm("my ad user", {
      attachments: [htmlAttachment('<div><span style="font-size:inherit">my ad user</span></div>')],
    }),
  ],
  [
    "a plain address in a group",
    grp(`<at>PrimusClaw Assistant</at> review ${PR}`, {
      attachments: [htmlOf('<at id="0">PrimusClaw Assistant</at> review ' + anchor(PR, PR))],
    }),
  ],
];

for (const [name, activity] of UNCHANGED) {
  test(`a message that has its address in the words is not changed: ${name}`, () => {
    const entities = (activity.entities ?? []).filter(
      (e) => typeof e === "object" && e !== null && (e as Record<string, unknown>)["type"] === "mention",
    );
    const bare: Activity = { ...activity, attachments: [], entities };
    assert.equal(said(activity), messageText(bare), name);
    const hasHref = JSON.stringify(activity.attachments ?? []).includes("href");
    assert.deepEqual(linksOf(activity), hasHref ? [{ url: PR, label: "" }] : []);
  });
}

const NOT_LINKS: readonly [string, unknown[], unknown[]][] = [
  [
    "other schemes",
    [
      htmlOf(
        anchor("javascript:alert(1)", "a") +
          anchor("mailto:a@example.test", "b") +
          anchor("ftp://example.test/f", "c") +
          anchor("file:///etc/passwd", "d") +
          anchor("//example.test/x", "e") +
          anchor("data:text/html,x", "f"),
      ),
    ],
    [],
  ],
  [
    "an address with a space or a quote",
    [htmlOf(anchor("https://example.test/a b", "a") + anchor("https://example.test/&quot;x", "b"))],
    [],
  ],
  [
    "a file: its downloadUrl is a credential",
    [
      {
        contentType: "application/vnd.microsoft.teams.file.download.info",
        contentUrl: "https://contoso.sharepoint.com/report.pdf",
        name: "report.pdf",
        content: { downloadUrl: "https://download.example/report.pdf?tempauth=abc", fileType: "pdf" },
      },
    ],
    [],
  ],
  ["a picture", [{ contentType: "image/png", contentUrl: "https://example.test/inline.png" }], []],
  [
    "pictures on a card",
    [
      {
        contentType: "application/vnd.microsoft.card.hero",
        content: { images: [{ url: "https://example.test/p.png" }], thumbnailUrl: "https://example.test/t.png" },
      },
    ],
    [],
  ],
  [
    "entities that are no links",
    [],
    [
      { type: "clientInfo", locale: "en-us", url: "https://example.test/c" },
      { type: "mention", text: "<at>X</at>", mentioned: { id: "29:x" }, url: "https://example.test/m" },
      { type: "ProductInfo", id: "COPILOT", url: "https://example.test/p" },
    ],
  ],
  [
    "junk",
    [
      null,
      "x",
      { contentType: "text/html" },
      { contentType: "text/html", content: 5 },
      { contentType: "application/vnd.microsoft.card.hero", content: "not a dict" },
    ],
    ["junk", { type: "x", url: 5 }],
  ],
];

for (const [name, attachments, entities] of NOT_LINKS) {
  test(`only web addresses of the users own words are read: ${name}`, () => {
    const a = dm("hello", { attachments, entities });
    assert.deepEqual(linksOf(a), [], name);
    assert.equal(said(a), "hello", name);
  });
}

test("a card that is a preview is read deep but not for ever", () => {
  let deep: Record<string, unknown> = { type: "x", url: "https://example.test/deep" };
  for (let i = 0; i < 12; i++) deep = { body: [deep] };
  const a = dm("hi", { attachments: [{ contentType: "application/vnd.microsoft.card.hero", content: deep }] });
  assert.deepEqual(linksOf(a), []);
  const shallow = dm("hi", {
    attachments: [
      {
        contentType: "application/vnd.microsoft.card.hero",
        content: { body: [{ items: [{ url: "https://example.test/ok" }] }] },
      },
    ],
  });
  assert.deepEqual(
    linksOf(shallow).map((l) => l.url),
    ["https://example.test/ok"],
  );
});

test("the same address is added once and the most added is bounded", () => {
  const twice = dm("go", {
    attachments: [
      htmlOf(anchor("https://example.test/a", "x") + anchor("https://example.test/a", "y")),
      thumbnail("https://example.test/a"),
    ],
  });
  assert.equal(said(twice).split("https://example.test/a").length - 1, 1);
  const many = dm("go", {
    attachments: [
      htmlOf(
        Array.from({ length: 40 }, (_, i) => anchor(`https://example.test/${String(i)}`, `w${String(i)}`)).join(""),
      ),
    ],
  });
  assert.equal(linksOf(many).length, LINK_COUNT);
  assert.equal(said(many).split("https://example.test/").length - 1, LINK_COUNT);
});

test("the words shown for a link are found in the original text only", () => {
  // The address inserted after one link's words must not be where the next link's words are looked for.
  const a = dm("pull it, pull it", {
    attachments: [htmlOf(anchor(PR, "pull") + ", " + anchor("https://example.test/b", "pull"))],
  });
  assert.equal(said(a), `pull <${PR}> it, pull <https://example.test/b> it`);
});

// --- a quote is the quote's ------------------------------------------------------------------------------------------

test("a link in the quote stays in the quote as the words and the address", () => {
  const a = dm("what about it?", {
    attachments: [
      htmlAttachment(
        replyHtml({
          preview: "see " + anchor("https://example.test/old", "the old PR") + " and " + anchor(PR, PR),
          own: "what about it?",
        }),
      ),
    ],
  });
  assert.deepEqual(linksOf(a), []);
  assert.equal(said(a), "what about it?");
  assert.equal(
    quoteBlockOf(a),
    `Quoted message from Bob (${WHEN}):\n> see the old PR <https://example.test/old> and ${PR}`,
  );
});

test("the marked text of a review request keeps its markers and gets the address", () => {
  const [text, mentions] = markedTextOf(ask("fix the plugin check", [htmlOf(ASK + " " + anchor())]));
  assert.equal(text, `请 ${MARK_OPEN}0${MARK_CLOSE} 帮我 review 合入 fix the plugin check <${PR}>`);
  assert.equal(mentions.length, 1);
});

// --- the commands read the words alone -------------------------------------------------------------------------------

test("the words a command is read from never carry an address", () => {
  const a = dm("fix the plugin check", { attachments: [htmlOf(anchor())] });
  assert.equal(messageText(a), "fix the plugin check");
  assert.equal(said(a), `fix the plugin check <${PR}>`);
});

// --- what a group is not sent unmasked -------------------------------------------------------------------------------

const SECRET_URL = "https://example.test/doc?token=ghp_" + "A1b2C3d4E5".repeat(4);

test("a group masks a credential in the address behind the words and a 1on1 chat does not", () => {
  const group = grp("<at>PrimusClaw Assistant</at> read the docs", {
    attachments: [htmlOf(anchor(SECRET_URL, "the docs"))],
  });
  const one = dm("read the docs", { attachments: [htmlOf(anchor(SECRET_URL, "the docs"))] });
  assert.ok(!withLinksOf("read the docs", group).includes("ghp_"));
  assert.ok(withLinksOf("read the docs", group).includes("[hidden]"));
  assert.ok(withLinksOf("read the docs", group).startsWith("read the docs <https://example.test/doc?token="));
  assert.equal(withLinksOf("read the docs", one), `read the docs <${SECRET_URL}>`);
  assert.ok(!markedTextOf(group)[0].includes("ghp_"));
});
