// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Files the agent delivered (Brain's `deliver_file`): read from the tool's terminal event, shown after the answer as a
 * delivery view in a 1:1 chat (a small image inside it), and as one line with the link and nothing of the file in a group
 * chat (test_deliveries.py). The card's JSON is the Teams view's test.
 */

import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { it } from "node:test";

import type { JsonObject } from "../../src/json.js";
import type { OutMessage } from "../../src/ports/surface.js";
import { type Delivery, deliveryOf, INLINE_IMAGE_MAX_BYTES, sizeText } from "../../src/turn/deliveries.js";
import { play, type Run } from "./play.js";
import { ev, result, type Script, textOf } from "./world.js";

const ID = "0f8fad5b-d9cb-469f-a165-70867728950e";
const ID2 = "1f8fad5b-d9cb-469f-a165-70867728950e";
const SESSION = "sess-ak";
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(300)]);
const B64 = PNG.toString("base64");

function delivered(
  options: {
    id?: string;
    name?: string;
    size?: number;
    contentType?: string;
    caption?: string;
    data?: string | null;
    extra?: Record<string, unknown>;
  } = {},
): ReturnType<typeof ev> {
  const {
    id = ID,
    name = "chart.png",
    size = PNG.length,
    contentType = "image/png",
    caption = "CPU vs GPU",
    data = B64,
  } = options;
  const raw = { id, name, size, content_type: contentType, caption, ...(data === null ? {} : { data_base64: data }) };
  return ev("toolUsed", "m1", {
    tool: "deliver_file",
    actionId: `a-${id}`,
    status: "success",
    description: `Delivered ${name}`,
    delivery: raw,
    ...options.extra,
  });
}

function delivery(id: string, name: string, size: number, contentType: string, caption = "", image = ""): Delivery {
  return { id, name, size, contentType, caption, image };
}

// --- what is a delivery ---------------------------------------------------------------------------------------------

const GOOD = { id: ID, name: "report.xlsx", size: 10, content_type: "application/vnd.ms-excel", caption: "Q3" };

it("test_a_delivery_is_read_only_from_a_successful_deliver_file_that_says_what_it_delivered", () => {
  const cases: Array<[string, string, string, JsonObject, Delivery | undefined]> = [
    [
      "a delivery",
      "deliver_file",
      "success",
      { delivery: GOOD },
      delivery(ID, "report.xlsx", 10, "application/vnd.ms-excel", "Q3"),
    ],
    [
      "bytes that came with a file that is no image are ignored",
      "deliver_file",
      "success",
      { delivery: { ...GOOD, data_base64: "AAAA" } },
      delivery(ID, "report.xlsx", 10, "application/vnd.ms-excel", "Q3"),
    ],
    [
      "no caption, no type",
      "deliver_file",
      "success",
      { delivery: { id: ID, name: "a", size: 0 } },
      delivery(ID, "a", 0, "application/octet-stream"),
    ],
    ["another tool", "write", "success", { delivery: GOOD }, undefined],
    ["the start", "deliver_file", "start", { delivery: GOOD }, undefined],
    ["a refusal", "deliver_file", "success", { description: "Error: /workspace/x does not exist" }, undefined],
    ["an id that is not one", "deliver_file", "success", { delivery: { ...GOOD, id: "../../x" } }, undefined],
    ["an id in capitals", "deliver_file", "success", { delivery: { ...GOOD, id: ID.toUpperCase() } }, undefined],
    ["no name", "deliver_file", "success", { delivery: { ...GOOD, name: "  " } }, undefined],
    ["a size that is not a count", "deliver_file", "success", { delivery: { ...GOOD, size: true } }, undefined],
    ["a negative size", "deliver_file", "success", { delivery: { ...GOOD, size: -1 } }, undefined],
    ["a size as text", "deliver_file", "success", { delivery: { ...GOOD, size: "10" } }, undefined],
    ["not an object", "deliver_file", "success", { delivery: [GOOD] }, undefined],
  ];
  for (const [name, tool, status, data, want] of cases) assert.deepEqual(deliveryOf(tool, status, data), want, name);
});

it("test_an_image_is_shown_only_as_exactly_the_small_image_the_delivery_says", () => {
  const cases: Array<[string, Record<string, unknown>, boolean]> = [
    ["a small png that came along", { data_base64: B64 }, true],
    ["no bytes came", {}, false],
    ["not base64", { data_base64: `!!!${B64}` }, false],
    ["bytes of another size", { data_base64: PNG.subarray(0, -1).toString("base64") }, false],
    ["a type Teams may not draw", { content_type: "image/svg+xml", data_base64: B64 }, false],
    ["not an image", { content_type: "text/csv", data_base64: B64 }, false],
    [
      "larger than a message holds",
      {
        size: INLINE_IMAGE_MAX_BYTES + 1,
        data_base64: Buffer.alloc(INLINE_IMAGE_MAX_BYTES + 1, "x").toString("base64"),
      },
      false,
    ],
    ["bytes that are not text", { data_base64: 7 }, false],
  ];
  for (const [name, raw, shown] of cases) {
    const d = deliveryOf("deliver_file", "success", {
      delivery: { id: ID, name: "c.png", size: PNG.length, content_type: "image/png", ...raw },
    });
    assert.equal(d?.image, shown ? `data:image/png;base64,${B64}` : "", name);
  }
});

it("test_names_and_captions_are_one_clipped_line", () => {
  const d = deliveryOf("deliver_file", "success", {
    delivery: { ...GOOD, name: `a\nb${"x".repeat(500)}`, caption: "c\n".repeat(400) },
  });
  assert.ok(d !== undefined);
  assert.ok(!d.name.includes("\n") && Array.from(d.name).length === 200);
  assert.ok(!d.caption.includes("\n") && Array.from(d.caption).length === 280);
});

it("test_sizes_read_like_a_file_manager", () => {
  const cases: Array<[number, string]> = [
    [0, "0 B"],
    [1023, "1023 B"],
    [1024, "1.0 KB"],
    [15_000, "15 KB"],
    [3 * 1024 ** 2, "3.0 MB"],
    [5 * 1024 ** 4, "5120 GB"],
  ];
  for (const [size, shown] of cases) assert.equal(sizeText(size), shown, String(size));
});

// --- after a 1:1 answer ---------------------------------------------------------------------------------------------

interface DeliveryView {
  readonly at: number;
  readonly delivery: Delivery;
  readonly url: string;
}

/** The delivery views that were sent, with where they are among what was sent. */
function deliveryViews(run: Run): DeliveryView[] {
  return run.bus.sent.flatMap((s, at) => {
    const body: OutMessage["body"] | undefined = s.message?.body;
    if (s.operation !== "send" || body?.type !== "view" || body.view.name !== "delivery") return [];
    return [{ at, delivery: body.view.model.delivery, url: body.view.model.url }];
  });
}

async function oneOnOne(events: Script): Promise<Run> {
  return play([
    [0.1, ev("toolUsed", "m1", { tool: "deliver_file", actionId: "a1", status: "start" })],
    ...events,
    [1.0, result("Here is the chart.")],
  ]);
}

it("test_a_delivered_small_image_is_a_card_after_the_answer_with_the_image_in_it", async () => {
  const run = await oneOnOne([[0.5, delivered()]]);
  const views = deliveryViews(run);
  assert.equal(views.length, 1);
  const [view] = views;
  assert.ok(view !== undefined);
  assert.ok(view.delivery.name === "chart.png" && view.delivery.caption === "CPU vs GPU");
  assert.equal(view.delivery.image, `data:image/png;base64,${B64}`);
  assert.equal(view.url, `https://claw.test/v1/sessions/${SESSION}/deliveries/${ID}`);
  const answered = Math.max(
    ...run.bus.sent.flatMap((s, i) => (textOf(s.message).includes("Here is the chart.") ? [i] : [])),
  );
  assert.ok(view.at > answered); // after the answer
  const called = new Set(run.claw.calls.map((c) => c[0]));
  for (const call of called)
    assert.ok(["create", "stream", "turn", "send", "changes"].includes(String(call)), String(call)); // nothing is fetched for it
});

it("test_a_file_with_no_image_is_a_card_with_download_alone", async () => {
  const run = await oneOnOne([[0.5, delivered({ name: "r.xlsx", contentType: "application/zip", data: null })]]);
  const views = deliveryViews(run);
  assert.equal(views.length, 1);
  assert.equal(views[0]?.delivery.image, "");
  assert.ok(run.texts.some((t) => t.includes("Here is the chart.")) && !run.texts.join(" ").includes("went wrong"));
});

it("test_each_file_once_in_order_and_none_from_a_sub_agent_or_a_refusal", async () => {
  const run = await oneOnOne([
    [0.2, delivered({ name: "a.csv", contentType: "text/csv" })],
    [0.3, delivered({ name: "a.csv", contentType: "text/csv" })], // a replayed event
    [0.4, delivered({ id: ID2, name: "b.zip", contentType: "application/zip" })],
    [0.5, delivered({ id: "2f8fad5b-d9cb-469f-a165-70867728950e", name: "sub.txt", extra: { subagent_id: "sa-1" } })],
    [
      0.6,
      ev("toolUsed", "m1", {
        tool: "deliver_file",
        actionId: "a9",
        status: "success",
        description: "Error: x is a directory",
      }),
    ],
  ]);
  assert.deepEqual(
    deliveryViews(run).map((v) => v.delivery.name),
    ["a.csv", "b.zip"],
  );
});

it("test_no_delivery_no_card", async () => {
  const run = await oneOnOne([]);
  assert.deepEqual(deliveryViews(run), []);
});

// --- in a group chat ------------------------------------------------------------------------------------------------

it("test_a_group_gets_one_line_with_the_link_and_nothing_of_the_file", async () => {
  const run = await play(
    [
      [0.5, delivered()],
      [1.0, result("Here is the chart.")],
    ],
    { request: { group: true } },
  );
  assert.deepEqual(deliveryViews(run), []);
  const lines = run.bus.sent.map((s) => textOf(s.message)).filter((t) => t.includes("Download"));
  assert.equal(lines.length, 1);
  const line = lines[0] ?? "";
  assert.ok(
    line.includes("chart.png") &&
      line.includes(`/deliveries/${ID}`) &&
      line.includes("only the person who asked can open it"),
  );
  const everything = run.bus.everything();
  assert.ok(!everything.includes("base64") && !everything.includes(B64.slice(0, 12))); // nothing of the file
});
