// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Files in, results out, on the assistant path (tests/test_assistant_files.py): what a person sends with a message reaches their
 * assistant, and what the work hands back (a worker's delivered files, a long answer) reaches the person whole.
 */
import assert from "node:assert/strict";
import { it } from "node:test";

import { ALICE, AssistantWorld } from "../../../../test-support/assistant/assistant-world.js";
import { modelOf, viewsOf } from "../../../../test-support/assistant/view-of.js";
import { openTestStore } from "../../../../test-support/store.js";
import type { MessageFiles } from "../../src/assistant/files.js";
import { SayPlanner, type DeliveryLink } from "../../src/assistant/say.js";
import type { JsonObject } from "../../src/json.js";
import type { InboundFile, OutMessage } from "../../src/ports/surface.js";
import { MAX_ANSWER_CHARS, MAX_ANSWER_MESSAGES, WHOLE_CUT_NOTE, wholeParts } from "../../src/turn/answer-parts.js";

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...new Array<number>(24).fill(0)]);
const PDF = new TextEncoder().encode(`%PDF-1.7\n${"x".repeat(100)}`);
const DELIVERY = "0f8fad5b-d9cb-469f-a165-70867728950e";
const FILES: Record<string, [Uint8Array, string]> = {
  "err.png": [PNG, "image/png"],
  "report.pdf": [PDF, "application/pdf"],
};

/** The channel's side of a message's files (`inbound.FileFetcher`): by name, or why not; what the person is told is recorded. */
function fetcher(fail: readonly string[] = []) {
  const told: (readonly (readonly [string, string])[])[] = [];
  const files: MessageFiles = {
    fetch: (wanted) => {
      const fetched = wanted.flatMap((f) => {
        const found = FILES[f.name];
        return fail.includes(f.name) || !found ? [] : [{ name: f.name, bytes: found[0], mediaType: found[1] }];
      });
      const failed = wanted
        .filter((f) => fail.includes(f.name))
        .map((f): [string, string] => [f.name, "Teams answered 403"]);
      return Promise.resolve({ fetched, failed });
    },
    uploadFolder: (messageId) => `.uploads/teams/${messageId}`,
    failedLine: (failed) => {
      told.push(failed);
      return `could not pass on ${String(failed.length)}`;
    },
  };
  return { files, told };
}

const inbound = (...names: string[]): InboundFile[] =>
  names.map((name) => ({ name, type: name.endsWith(".png") ? "image/png" : "application/pdf", handle: {} }));

function understand(w: AssistantWorld, prompt: string, activityId: string, files: InboundFile[]) {
  return w.chat.understand({
    userId: ALICE,
    credential: "ak-alice",
    modelKey: "",
    prompt,
    context: { channel_message_id: activityId },
    lang: "en",
    conversation: w.conversation(),
    files,
  });
}

const namedFiles = (w: AssistantWorld) => w.claw.heard.at(-1)?.context?.["files"] as JsonObject[] | undefined;

it("files go to the assistant with the message", async () => {
  const { files, told } = fetcher();
  const w = await AssistantWorld.start({ understanding: [ALICE], files });
  await understand(w, "这个报错是什么意思？", "act-f1", inbound("err.png", "report.pdf"));
  assert.deepEqual(w.heard(), ["这个报错是什么意思？"]);
  const session = w.claw.heard.at(-1)?.sessionId;
  assert.deepEqual(
    w.uploaded.map((u) => [u.sessionId, `${u.folder}/${u.name}`, u.bytes]),
    [
      [session, ".uploads/teams/act-f1/err.png", PNG],
      [session, ".uploads/teams/act-f1/report.pdf", PDF],
    ],
  );
  assert.deepEqual(namedFiles(w), [
    { path: "teams/act-f1/err.png", name: "err.png", media_type: "image/png", size: PNG.length },
    { path: "teams/act-f1/report.pdf", name: "report.pdf", media_type: "application/pdf", size: PDF.length },
  ]);
  assert.deepEqual(told, [], "nothing is said about files not being passed on");
});

it("files alone are a message to the assistant", async () => {
  const { files } = fetcher();
  const w = await AssistantWorld.start({ understanding: [ALICE], files });
  await understand(w, w.chat.filesOnly("en"), "act-f2", inbound("err.png"));
  assert.deepEqual(w.heard(), ["(sent files, with no message)"]);
  assert.deepEqual(
    namedFiles(w)?.map((f) => f["name"]),
    ["err.png"],
  );
});

it("files go with a message on the route path too", async () => {
  const { files, told } = fetcher();
  const w = await AssistantWorld.start({ files });
  await w.say("summarise the report", ALICE, inbound("report.pdf"));
  assert.deepEqual(w.heard(), ["summarise the report"]);
  const named = namedFiles(w) ?? [];
  assert.deepEqual(
    named.map((f) => [f["name"], f["media_type"]]),
    [["report.pdf", "application/pdf"]],
  );
  const path = named[0]?.["path"];
  assert.ok(typeof path === "string");
  assert.equal(`${w.uploaded[0]?.folder.replace(".uploads/", "") ?? ""}/report.pdf`, path);
  assert.ok(path.endsWith("/report.pdf"));
  assert.deepEqual(told, []);
});

it("a file that does not reach claw is named counted and the message still goes", async () => {
  const { files, told } = fetcher(["err.png"]);
  const w = await AssistantWorld.start({ understanding: [ALICE], files });
  w.claw.refuseFiles.add("report.pdf");
  await understand(w, "look", "act-f3", inbound("err.png", "report.pdf"));
  assert.deepEqual(w.heard(), ["look"]);
  assert.deepEqual(namedFiles(w), [], "nothing is named that Claw does not hold");
  assert.deepEqual(told, [
    [
      ["err.png", "Teams answered 403"],
      ["report.pdf", "Claw did not take it"],
    ],
  ]);
  assert.ok(w.texts().includes("could not pass on 2"));
  assert.deepEqual(w.dropped, [["assistant", 2]]);
});

it("whole parts keeps three full messages whole", () => {
  const paragraphs = Array.from({ length: 60 }, (_, i) => `第${String(i)}段：${"这是一段很长的回答，".repeat(18)}`);
  const text = paragraphs.join("\n\n").slice(0, MAX_ANSWER_CHARS * MAX_ANSWER_MESSAGES);
  let parts = wholeParts(text);
  assert.ok(parts.length <= MAX_ANSWER_MESSAGES && parts.every((p) => p.length <= MAX_ANSWER_CHARS));
  assert.equal(parts.join("").replaceAll("\n", ""), text.trim().replaceAll("\n", ""), "nothing cut, nothing added");
  // With room to spare the cuts are at paragraph breaks, not in the middle of a line.
  const roomy = paragraphs.slice(0, 35).join("\n\n");
  assert.ok(roomy.length < MAX_ANSWER_CHARS * MAX_ANSWER_MESSAGES - 1000);
  parts = wholeParts(roomy);
  assert.equal(parts.length, MAX_ANSWER_MESSAGES);
  assert.ok(parts.every((p) => p.endsWith("回答，")));
  assert.equal(parts.join("\n\n"), roomy);
});

it("whole parts short and over long", () => {
  assert.deepEqual(wholeParts("hello"), ["hello"]);
  const oneLine = "x".repeat(MAX_ANSWER_CHARS * MAX_ANSWER_MESSAGES);
  assert.equal(wholeParts(oneLine).join(""), oneLine);
  const parts = wholeParts("y".repeat(MAX_ANSWER_CHARS * MAX_ANSWER_MESSAGES + 50));
  assert.equal(parts.length, MAX_ANSWER_MESSAGES);
  assert.ok(parts.at(-1)?.endsWith(WHOLE_CUT_NOTE));
  assert.ok((parts.at(-1)?.length ?? Infinity) <= MAX_ANSWER_CHARS);
});

function planner(exact = false) {
  const { store } = openTestStore();
  return new SayPlanner({
    store,
    exactCommand: () => exact,
    style: () => ({ citations: true, suggestedReplies: true }),
  });
}

const words = (out: readonly OutMessage[]) =>
  out.flatMap((m) => (m.body.type === "rich" ? [m.body.markdown] : m.body.type === "text" ? [m.body.text] : []));

it("a long answer arrives whole", () => {
  const long = Array.from(
    { length: 32 },
    (_, i) => `- PR ${String(i)}: ${"a change to the scheduler ".repeat(10)}`,
  ).join("\n\n");
  assert.ok(long.length > 6000 && long.length <= 9000);
  const texts = words(planner().messages(ALICE, { type: "assistant.say", event_id: "e-long", text: long })).filter(
    (t) => t.trim(),
  );
  assert.ok(texts.length >= 2 && texts.length <= 3);
  const joined = texts.join("");
  for (let i = 0; i < 32; i += 1) assert.ok(joined.includes(`PR ${String(i)}:`), String(i));
});

const READY = {
  item_id: "it-1",
  seq: 1,
  title: "Weekly report",
  board_state: "needs_you",
  result_version: 1,
  can_accept: true,
  last_report_kind: "ready",
};

it("a long answer about a result ends in its card", () => {
  const long = Array.from({ length: 30 }, (_, i) => `paragraph ${String(i)}: ${"z".repeat(280)}`).join("\n\n");
  assert.ok(long.length <= 9000);
  const out = planner().messages(ALICE, { type: "assistant.say", event_id: "e-card", text: long, item: READY });
  const last = out.at(-1);
  assert.ok(last?.body.type === "view" && last.body.view.name === "workCard");
  const said = words(out).join(" ") + JSON.stringify(last.body.view.model);
  for (let i = 0; i < 30; i += 1) assert.ok(said.includes(`paragraph ${String(i)}:`), String(i));
});

function filesEvent(files: JsonObject[], text = "#3 Weekly report delivered a file: chart.png (12 B)"): JsonObject {
  return { type: "assistant.say", event_id: "e-file", text, fallback: true, files };
}

const base64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64");

it("a delivered file is a download card", () => {
  const links: [string, string][] = [];
  const linkFor: DeliveryLink = (sessionId, deliveryId) => {
    links.push([sessionId, deliveryId]);
    return `https://claw.test/v1/sessions/${sessionId}/deliveries/${deliveryId}`;
  };
  const image = base64(PNG);
  const file = { item_id: "kwi_1", session_id: "worker-1", id: DELIVERY, name: "chart.png", size: PNG.length };
  let out = planner().messages(ALICE, filesEvent([{ ...file, content_type: "image/png", data_base64: image }]), {
    linkFor,
  });
  assert.deepEqual(links, [["worker-1", DELIVERY]]);
  assert.equal(out.length, 2);
  assert.ok(words(out)[0]?.includes("Weekly report"), "the words first, whole");
  const model = modelOf(viewsOf(out)[0], "delivery");
  assert.equal(model.url, `https://claw.test/v1/sessions/worker-1/deliveries/${DELIVERY}`);
  assert.equal(model.delivery.name, "chart.png");
  assert.equal(model.delivery.image, `data:image/png;base64,${image}`);
  // A file with a caption of its own: the words are still said, whole, and the caption stays the file's.
  const text = "The invoice covers January and includes the revised tax total. ".repeat(5);
  const invoice = {
    ...file,
    name: "invoice.pdf",
    size: 9,
    content_type: "application/pdf",
    caption: "Generated invoice",
  };
  out = planner().messages(ALICE, filesEvent([invoice], text), { linkFor });
  assert.equal(out.length, 2);
  assert.ok(words(out)[0]?.includes(text.trim().slice(0, 200)));
  assert.equal(modelOf(viewsOf(out)[0], "delivery").delivery.caption, "Generated invoice");
});

it("a file that does not say what it is is not drawn", () => {
  const linkFor: DeliveryLink = (sid, did) => `https://claw.test/${sid}/${did}`;
  for (const bad of [
    { session_id: "w", id: "not-a-uuid", name: "a.png", size: 1 },
    { session_id: "", id: DELIVERY, name: "a.png", size: 1 },
    { session_id: "w", id: DELIVERY, name: "", size: 1 },
    { session_id: "w", id: DELIVERY, name: "a.png", size: -1 },
  ]) {
    const out = planner().messages(ALICE, filesEvent([bad]), { linkFor });
    assert.equal(out.length, 1);
    assert.deepEqual(viewsOf(out), [], "the words only: no card for a file that does not say what it is");
  }
  // No link to give (Claw not reached over https): the words name the file.
  const out = planner().messages(ALICE, filesEvent([{ session_id: "w", id: DELIVERY, name: "chart.png", size: 1 }]), {
    linkFor: () => null,
  });
  assert.equal(out.length, 1);
  assert.ok(JSON.stringify(out[0]).includes("chart.png"));
});

it("files with a result to accept keep its card", () => {
  const out = planner().messages(
    ALICE,
    {
      type: "assistant.say",
      event_id: "e-both",
      text: "#1 Weekly report is ready, with its file.",
      item: READY,
      files: [
        { session_id: "worker-1", id: DELIVERY, name: "report.docx", size: 4096, content_type: "application/msword" },
      ],
    },
    { linkFor: (sid, did) => `https://claw.test/v1/sessions/${sid}/deliveries/${did}` },
  );
  const views = viewsOf(out);
  assert.deepEqual(
    views.map((v) => v.name),
    ["workCard", "delivery"],
  );
  assert.equal(modelOf(views[0], "workCard").item.canAccept, true);
  assert.equal(
    modelOf(views[1], "delivery").delivery.name,
    "report.docx",
    "the file comes after the card with buttons",
  );
});

it("files with a command to confirm keep its card", () => {
  const out = planner(true).messages(
    ALICE,
    {
      type: "assistant.say",
      event_id: "e-cmd",
      text: "Shall I turn on your morning brief at 10:00?",
      confirm_action: { name: "brief", args: "on 10:00", channel_message_id: "cm-1" },
      files: [{ session_id: "worker-1", id: DELIVERY, name: "plan.md", size: 10, content_type: "text/markdown" }],
    },
    { linkFor: (sid, did) => `https://claw.test/${sid}/${did}` },
  );
  assert.deepEqual(
    viewsOf(out).map((v) => v.name),
    ["actionCard", "delivery"],
  );
});
