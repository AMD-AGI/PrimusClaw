// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The turn's cards (test_deliveries.py and test_changes_card.py, the card halves): a delivered file's card and the changes
 * card under a finished answer, built from what core reads of Claw's events and replies.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { it } from "node:test";

import { turn } from "@primusclaw/personal-agent";
import { Ajv } from "ajv";

import { isObject, walk, type JsonObject } from "../src/cards/json.js";
import { ADAPTIVE_CARD } from "../src/cards/kit.js";
import { CHANGES_PATH_MAX, changesCard, deliveryCard } from "../src/views/turn/index.js";
import { stopCard } from "../src/views/turn/stop.js";

const PUBLIC = "https://example.test";
const ID = "0f8fad5b-d9cb-469f-a165-70867728950e";
const SESSION = "sess-ak-alice";
const DATA = new URL("../../../test-support/data/", import.meta.url);
const schema = JSON.parse(readFileSync(new URL("adaptive-card-1.5.schema.json", DATA), "utf8")) as JsonObject;
const validate = new Ajv({ strict: false, allErrors: false }).compile({
  ...Object.fromEntries(Object.entries(schema).filter(([k]) => k !== "$schema" && k !== "id")),
  $id: typeof schema["id"] === "string" ? schema["id"] : "",
});

/** The card of a message activity, checked against the Adaptive Card schema (the Python tests' VALIDATOR). */
function cardOf(activity: JsonObject): JsonObject {
  const attachments = activity["attachments"];
  assert.ok(Array.isArray(attachments) && attachments.length === 1);
  const attachment = attachments[0];
  assert.ok(isObject(attachment) && attachment["contentType"] === ADAPTIVE_CARD);
  const card = attachment["content"];
  assert.ok(isObject(card));
  assert.ok(validate(card), JSON.stringify(validate.errors));
  return card;
}

/** Every line a card shows, top down: its TextBlocks, not a header's colour bar (`texts_in`). */
function textsIn(card: JsonObject): string[] {
  const body = card["body"];
  const out: string[] = [];
  for (const node of walk(body)) {
    const text = node["text"];
    if (node["type"] === "TextBlock" && typeof text === "string" && text !== "┃") out.push(text);
  }
  return out;
}

function bodyBlocks(card: JsonObject): JsonObject[] {
  return card["body"] as JsonObject[];
}

function actions(card: JsonObject): JsonObject[] {
  return (card["actions"] ?? []) as JsonObject[];
}

const delivery = (fields: Partial<turn.Delivery>): turn.Delivery => ({
  id: ID,
  name: "",
  size: 0,
  contentType: "",
  caption: "",
  image: "",
  ...fields,
});

// --- a delivered file -----------------------------------------------------------------------------------------------

it("test_the_card_names_the_file_says_its_size_and_caption_and_has_download", () => {
  const url = `https://claw.test/v1/sessions/s1/deliveries/${ID}`;
  const rendered = cardOf(
    deliveryCard({
      delivery: delivery({ name: "__init__.py", size: 2048, contentType: "text/plain", caption: "the *module*" }),
      url,
    }),
  );
  assert.deepEqual(textsIn(rendered), ["📎 \\_\\_init\\_\\_.py", "2.0 KB", "the \\*module\\*"]);
  assert.deepEqual(actions(rendered), [{ type: "Action.OpenUrl", title: "Download", url, style: "positive" }]); // (the primary)
  assert.ok(!bodyBlocks(rendered).some((b) => b["type"] === "Image"));
});

it("test_an_image_that_came_along_is_in_the_card", () => {
  const rendered = cardOf(
    deliveryCard({
      delivery: delivery({ name: "c.png", size: 9, contentType: "image/png", image: "data:image/png;base64,AAAA" }),
      url: "https://x.test/d",
    }),
  );
  const images = bodyBlocks(rendered).filter((b) => b["type"] === "Image");
  assert.deepEqual(images, [{ type: "Image", url: "data:image/png;base64,AAAA", altText: "c.png" }]);
});

it("test_a_delivered_small_image_is_a_card_after_the_answer_with_the_image_in_it (card)", () => {
  // the card core's view model of a turn's deliver_file event is drawn as (the turn's side is in core's deliveries tests)
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...new Array<number>(300).fill(0)]);
  const b64 = Buffer.from(png).toString("base64");
  const found = turn.deliveryOf("deliver_file", "success", {
    delivery: {
      id: ID,
      name: "chart.png",
      size: png.length,
      content_type: "image/png",
      caption: "CPU vs GPU",
      data_base64: b64,
    },
  });
  assert.ok(found);
  const url = `https://claw.test/v1/sessions/${SESSION}/deliveries/${ID}`;
  const rendered = cardOf(deliveryCard({ delivery: found, url }));
  assert.ok(textsIn(rendered)[0] === "📎 chart.png" && textsIn(rendered).includes("CPU vs GPU"));
  const images = bodyBlocks(rendered).filter((b) => b["type"] === "Image");
  assert.equal(images.length, 1);
  assert.equal(images[0]?.["url"], `data:image/png;base64,${b64}`);
  assert.equal(actions(rendered)[0]?.["url"], url);
});

// --- the changes card -----------------------------------------------------------------------------------------------

interface F {
  path: string;
  status: string | null;
  additions: number | null;
  deletions: number | null;
  binary: boolean;
}

function f(
  path: string,
  status: string | null = "M",
  additions: number | null = 1,
  deletions: number | null = 0,
  binary = false,
): F {
  return { path, status, additions, deletions, binary };
}

interface RepoOptions {
  path?: string;
  branch?: string | null;
  head?: string;
  truncated?: boolean;
  totals?: JsonObject;
}

function repo(files: F[], options: RepoOptions = {}): JsonObject {
  return {
    path: options.path ?? "/workspace/app",
    branch: options.branch === undefined ? "feat/x" : options.branch,
    head: options.head ?? "a1b2c3d",
    truncated: options.truncated ?? false,
    totals: options.totals ?? {
      files: files.length,
      additions: files.reduce((n, x) => n + (x.additions ?? 0), 0),
      deletions: files.reduce((n, x) => n + (x.deletions ?? 0), 0),
    },
    files: files as unknown as JsonObject[],
  };
}

function reply(repos: JsonObject[], truncated = false): JsonObject {
  return { ok: true, session_id: "s1", generated_at: "2026-10-29T08:00:00Z", truncated, repos };
}

function card(reply_: JsonObject, sessionId = "s1", base = PUBLIC): JsonObject {
  const changes = turn.parseChanges(reply_);
  assert.ok(changes);
  return cardOf(changesCard({ changes, sessionId, publicBaseUrl: base }));
}

const lines = (rendered: JsonObject): string[] => textsIn(rendered);

const MIXED = reply([
  repo([
    f("src/app.py", "M", 12, 3),
    f("src/new.py", "A", 40, 0),
    f("old.txt", "D", 0, 9),
    f("a.py -> b.py", "R", 2, 2),
    f("notes.md", "?", 5, 0),
  ]),
]);

it("test_the_card_lists_each_file_with_its_status_and_counts", () => {
  const cases: Array<[string, JsonObject, string[]]> = [
    [
      "a modified file",
      reply([repo([f("src/app.py", "M", 12, 3)])]),
      ["📝 Changes", "1 file changed, +12 -3", "app · feat/x · a1b2c3d", "M src/app.py +12 -3"],
    ],
    [
      "every status",
      MIXED,
      [
        "📝 Changes",
        "5 files changed, +59 -14",
        "app · feat/x · a1b2c3d",
        "M src/app.py +12 -3",
        "A src/new.py +40 -0",
        "D old.txt +0 -9",
        "R a.py -> b.py +2 -2",
        "? notes.md +5 -0",
      ],
    ],
    [
      "a binary file has no counts",
      reply([repo([f("logo.png", "A", null, null, true)])]),
      ["📝 Changes", "1 file changed, +0 -0", "app · feat/x · a1b2c3d", "A logo.png (binary)"],
    ],
    [
      "a binary file whose counts Claw gave anyway",
      reply([repo([f("logo.png", "M", 5, 5, true)])]),
      ["📝 Changes", "1 file changed, +5 -5", "app · feat/x · a1b2c3d", "M logo.png (binary)"],
    ],
    [
      "counts Claw could not give",
      reply([repo([f("odd.txt", "M", null, null)])]),
      ["📝 Changes", "1 file changed, +0 -0", "app · feat/x · a1b2c3d", "M odd.txt"],
    ],
    [
      "one count missing",
      reply([repo([f("half.txt", "M", 4, null)])]),
      ["📝 Changes", "1 file changed, +4 -0", "app · feat/x · a1b2c3d", "M half.txt +4 -0"],
    ],
    [
      "a status Claw does not know",
      reply([repo([f("x.txt", "U", 1, 1), f("y.txt", null, 1, 1)])]),
      ["📝 Changes", "2 files changed, +2 -2", "app · feat/x · a1b2c3d", "? x.txt +1 -1", "? y.txt +1 -1"],
    ],
    [
      "a detached head with no branch",
      reply([repo([f("a.py")], { branch: null })]),
      ["📝 Changes", "1 file changed, +1 -0", "app · a1b2c3d", "M a.py +1 -0"],
    ],
    [
      "no branch and no head says nothing of the repository",
      reply([repo([f("a.py")], { branch: null, head: "" })]),
      ["📝 Changes", "1 file changed, +1 -0", "M a.py +1 -0"],
    ],
    [
      "two repositories each get their line",
      reply([
        repo([f("a.py")]),
        repo([f("b.py", "A", 3, 0)], { path: "/workspace/lib", branch: "main", head: "9f8e7d6" }),
      ]),
      [
        "📝 Changes",
        "2 files changed, +4 -0",
        "app · feat/x · a1b2c3d",
        "M a.py +1 -0",
        "lib · main · 9f8e7d6",
        "A b.py +3 -0",
      ],
    ],
    [
      "a repository nothing changed in is left out",
      reply([repo([]), repo([f("b.py")], { path: "/workspace/lib" })]),
      ["📝 Changes", "1 file changed, +1 -0", "lib · feat/x · a1b2c3d", "M b.py +1 -0"],
    ],
  ];
  for (const [name, reply_, expected] of cases) assert.deepEqual(lines(card(reply_)), expected, name);
});

function files(n: number, prefix = "f"): F[] {
  return Array.from({ length: n }, (_, i) => f(`${prefix}${String(i)}.py`, "M", i + 1, 0));
}

it("test_at_most_eight_files_are_listed_and_the_rest_is_a_count", () => {
  const cases: Array<[number, number, string | undefined]> = [
    [1, 1, undefined],
    [7, 7, undefined],
    [8, 8, undefined],
    [9, 8, "+1 more"],
    [12, 8, "+4 more"],
    [150, 8, "+142 more"],
  ];
  for (const [count, shown, more] of cases) {
    const body = lines(card(reply([repo(files(count))])));
    const listed = body.filter((t) => t.startsWith("M "));
    assert.equal(listed.length, shown, String(count));
    assert.deepEqual(
      listed.map((t) => t.split(" ")[1]),
      Array.from({ length: shown }, (_, i) => `f${String(i)}.py`),
    );
    if (more) assert.equal(body.at(-1), more);
    else assert.ok(!body.some((t) => t.includes("more")));
    const added = (count * (count + 1)) / 2;
    assert.equal(body[1], `${String(count)} file${count !== 1 ? "s" : ""} changed, +${String(added)} -0`);
  }
});

it("test_the_eight_are_counted_over_all_repositories_in_order", () => {
  const body = lines(
    card(
      reply([
        repo(files(5, "a")),
        repo(files(5, "b"), { path: "/workspace/lib" }),
        repo(files(2, "c"), { path: "/workspace/docs" }),
      ]),
    ),
  );
  assert.deepEqual(
    body.filter((t) => t.startsWith("M ")).map((t) => t.split(" ")[1]),
    ["a0.py", "a1.py", "a2.py", "a3.py", "a4.py", "b0.py", "b1.py", "b2.py"],
  );
  assert.ok(
    body.at(-1) === "+4 more" &&
      (body[1] ?? "").startsWith("12 files changed") &&
      !body.includes("docs · feat/x · a1b2c3d"),
  );
  assert.ok(body.includes("lib · feat/x · a1b2c3d"));
});

it("test_a_list_claw_cut_says_so_in_its_counts", () => {
  const cases: Array<[string, JsonObject, string, string]> = [
    [
      "Claw cut the list at 200 and says how many there are",
      reply([repo(files(200), { truncated: true, totals: { files: 350, additions: 9, deletions: 1 } })]),
      "350 files changed, +9 -1",
      "+342 more",
    ],
    [
      "Claw cut the list and the count is only what it listed",
      reply([repo(files(200), { truncated: true, totals: { files: 200, additions: 9, deletions: 1 } })]),
      "200+ files changed, +9 -1",
      "+192+ more",
    ],
    [
      "a truncated flag on the whole reply alone changes nothing",
      reply([repo(files(10))], true),
      "10 files changed, +55 -0",
      "+2 more",
    ],
  ];
  for (const [name, reply_, countLine, more] of cases) {
    const body = lines(card(reply_));
    assert.ok(body[1] === countLine && body.at(-1) === more, `${name}: ${JSON.stringify([body[1], body.at(-1)])}`);
  }
});

it("test_a_total_smaller_than_what_was_listed_is_not_believed", () => {
  const body = lines(card(reply([repo(files(3), { totals: { files: 1, additions: 6, deletions: 0 } })])));
  assert.equal(body[1], "3 files changed, +6 -0");
});

it("test_a_long_path_keeps_its_end_and_fits_a_phone_line", () => {
  const path = `packages/${"very-long-directory-name/".repeat(6)}src/module.py`;
  const listed = lines(card(reply([repo([f(path)])]))).filter((t) => t.startsWith("M "));
  assert.equal(listed.length, 1);
  const line = listed[0] ?? "";
  const shown = line.split(" ")[1] ?? "";
  assert.ok(shown.startsWith("…") && shown.endsWith("src/module.py") && Array.from(shown).length === CHANGES_PATH_MAX);
  assert.equal(CHANGES_PATH_MAX, 60);
  assert.equal(line, `M ${shown} +1 -0`);
});

it("test_a_path_is_not_read_as_markdown", () => {
  const cases: Array<[string, string]> = [
    ["src/__init__.py", "src/\\_\\_init\\_\\_.py"],
    ["a*b[1].py", "a\\*b\\[1\\].py"],
    ["<at>x</at>.txt", "\\<at>x\\</at>.txt"],
    ["back\\slash`tick`", "back\\\\slash\\`tick\\`"],
    ["plain/path-1.2.py", "plain/path-1.2.py"],
  ];
  for (const [path, shown] of cases) {
    const listed = lines(card(reply([repo([f(path)])]))).filter((t) => t.startsWith("M "));
    assert.deepEqual(listed, [`M ${shown} +1 -0`], path);
  }
});

it("test_a_header_is_not_read_as_markdown_either", () => {
  const body = lines(card(reply([repo([f("a.py")], { path: "/workspace/__app__", branch: "feat/<x>*" })])));
  assert.equal(body[2], "\\_\\_app\\_\\_ · feat/\\<x>\\* · a1b2c3d");
});

it("test_the_buttons_are_create_pr_and_open_diff_in_claw_and_carry_the_session", () => {
  const rendered = card(MIXED, "sess-9");
  const [create, diff] = actions(rendered);
  assert.ok(create && diff);
  assert.deepEqual(
    [create["type"], create["title"], create["verb"]],
    ["Action.Execute", "Create PR", "primusclaw.create_pr"],
  );
  assert.deepEqual(create["data"], { primusclaw: "create_pr", session_id: "sess-9" });
  assert.deepEqual(diff, { type: "Action.OpenUrl", title: "Open diff in Claw", url: `${PUBLIC}/primus-claw/sess-9` });
  assert.ok(actions(rendered).length <= 3 && rendered["version"] === "1.5");
});

it("test_without_an_https_console_address_there_is_no_open_diff_button_but_create_pr_stays", () => {
  const rendered = card(MIXED, "s1", "http://insecure.test");
  assert.deepEqual(
    actions(rendered).map((a) => a["title"]),
    ["Create PR"],
  );
});

it("test_a_finished_answer_is_followed_by_the_changes_card (card)", () => {
  // the card core's changes view is drawn as (the turn's side is in core's changes tests)
  const rendered = card(MIXED, SESSION);
  assert.deepEqual(lines(rendered).slice(0, 2), ["📝 Changes", "5 files changed, +59 -14"]);
  assert.equal((actions(rendered)[0]?.["data"] as JsonObject)["session_id"], SESSION);
});

it("test_the_card_says_what_it_does_in_the_persons_language_and_carries_only_the_token", () => {
  const zh = stopCard({ token: "tok", lang: "zh" });
  const en = stopCard({ token: "tok", lang: "en" });
  const zhCard = zh.attachments[0]?.content as Record<string, unknown>;
  const enCard = en.attachments[0]?.content as Record<string, unknown>;
  assert.deepEqual(zhCard["actions"], [
    {
      type: "Action.Execute",
      title: "停止",
      verb: "primusclaw.turn_stop",
      style: "destructive",
      data: { primusclaw: "turn_stop", turn: "tok" },
    },
  ]);
  assert.equal((enCard["actions"] as Array<Record<string, unknown>>)[0]?.["title"], "Stop");
  assert.equal(zhCard["version"], "1.5");
});
