// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Feedback's cards against the Python worker's snapshots. Both sides are written as `json.dumps(indent=1, sort_keys=True)`
 * writes them, so the comparison is the bytes the Python test compares, whatever layout the snapshot file has here.
 * (These four join the shared catalog, `test-support/card-catalog`, once its snapshot test reads them that way.)
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  FeedbackFlow,
  FeedbackThumbs,
  Observer,
  pyJsonDumps,
  thumbsMessage,
  type ClickHandler,
  type FeedbackFlowDeps,
  type ObserverDeps,
  type ThumbsDeps,
  type ViewMap,
} from "@primusclaw/personal-agent";

import { RENDERERS, renderView } from "../../src/views/index.js";
import { FEEDBACK_CARDS } from "../../../../test-support/card-catalog/feedback.js";
import { toInboundEvent } from "../../src/activity/inbound/index.js";
import { world } from "../../../../test-support/routing/world.js";
import { dm, grp } from "../activity/fixtures.js";

const SNAPSHOTS = new URL("../../../../test-support/data/card_snapshots/", import.meta.url);

/** Every Action.Execute of a rendered card: what a press on it sends. */
function presses(card: unknown): { readonly verb: unknown; readonly data: unknown }[] {
  if (Array.isArray(card)) return card.flatMap(presses);
  if (typeof card !== "object" || card === null) return [];
  const node = card as { readonly type?: unknown; readonly verb?: unknown; readonly data?: unknown };
  const own = node.type === "Action.Execute" ? [{ verb: node.verb, data: node.data }] : [];
  return [...own, ...Object.values(card).flatMap(presses)];
}

/**
 * Which of `handlers` a press reaches: the invoke Teams sends for it, read by the adapter's own toInboundEvent and
 * handed to the worker's real router (1:1 or group), with each handler's verbs as the worker registers them.
 */
async function reached(
  press: { readonly verb: unknown; readonly data: unknown },
  handlers: readonly (readonly [string, ClickHandler])[],
  inGroup: boolean,
): Promise<string[]> {
  const event = toInboundEvent({
    ...(inGroup ? grp("") : dm("")),
    type: "invoke",
    name: "adaptiveCard/action",
    replyToId: "card-1",
    value: { action: { type: "Action.Execute", verb: press.verb, data: press.data } },
  });
  assert.ok(event.ok && event.value?.type === "action");
  const hits: string[] = [];
  const recorder = (name: string, verbs: readonly string[]): ClickHandler => ({
    verbs,
    beforeCredential: () => {
      hits.push(name);
      return Promise.resolve(true);
    },
    inGroup: () => {
      hits.push(name);
      return Promise.resolve(true);
    },
  });
  const w = world({ handlers: { clicks: handlers.map(([name, handler]) => recorder(name, handler.verbs)) } });
  await w.router.handle(event.value);
  return hits;
}

/** The worker's feedback and observe click handlers (built only for their verbs: no press is carried out). */
function w8Handlers(): readonly (readonly [string, ClickHandler])[] {
  return [
    ["flow", new FeedbackFlow({} as unknown as FeedbackFlowDeps).clicks],
    ["thumbs", new FeedbackThumbs({} as unknown as ThumbsDeps).clicks],
    ["observe", new Observer({ users: [] } as unknown as ObserverDeps).clicks],
  ];
}

function python(value: unknown): string {
  return pyJsonDumps(value, { indent: 1, sortKeys: true });
}

for (const entry of FEEDBACK_CARDS) {
  test(`feedback card matches its snapshot: ${entry.id}`, () => {
    const snapshot: unknown = JSON.parse(readFileSync(new URL(`${entry.id}.json`, SNAPSHOTS), "utf8"));
    assert.equal(python(entry.build()), python(snapshot));
  });
}

test("a report card in a group says only the asker can use it", () => {
  const card = python(renderView(RENDERERS, { name: "feedbackReport", model: { promptId: "p-2", group: true } }));
  assert.ok(
    card.includes(
      "💬 Did something go wrong? You can tell the PrimusClaw team. Only the person who asked can use this button.",
    ),
  );
  assert.ok(card.includes('"prompt": "p-2"'));
});

test("the offer after a failed yes is a note under the question with yes and no again", () => {
  const model: ViewMap["feedbackOfferRetry"] = { offerId: "off-2", issueNumber: 7, note: "Press Yes again." };
  const card = renderView(RENDERERS, { name: "feedbackOfferRetry", model });
  const text = python(card);
  assert.ok(text.includes('"text": "🔔 Add your last question and my answer to #7?"'));
  assert.ok(text.includes('"text": "Press Yes again."'));
  assert.equal((text.match(/"offer": "off-2"/g) ?? []).length, 2);
});

test("the turn's thumbs message is the thumbs card of the snapshot, with the card's question as its fallback", () => {
  const message = thumbsMessage();
  assert.equal(message.body.type, "view");
  assert.equal(message.body.view.name, "thumbs");
  assert.equal(message.body.fallbackText, "Was this answer helpful?");
  const snapshot: unknown = JSON.parse(readFileSync(new URL("thumbs.json", SNAPSHOTS), "utf8"));
  assert.equal(python(renderView(RENDERERS, message.body.view)), python(snapshot));
});

test("every button of a feedback card reaches its handler through the adapter and the real router", async () => {
  const handlers = w8Handlers();
  const cards: readonly (readonly [string, Parameters<typeof renderView>[1], readonly string[]])[] = [
    ["report", { name: "feedbackReport", model: { promptId: "p-1", group: false } }, ["flow"]],
    ["offer", { name: "feedbackOffer", model: { offerId: "off-1", issueNumber: 7 } }, ["flow", "flow"]],
    [
      "offer again",
      { name: "feedbackOfferRetry", model: { offerId: "off-1", issueNumber: 7, note: "again" } },
      ["flow", "flow"],
    ],
    ["thumbs", { name: "thumbs", model: {} }, ["thumbs", "thumbs"]],
    ["thumb comment", { name: "thumbComment", model: {} }, ["thumbs", "thumbs"]],
  ];
  for (const inGroup of [false, true])
    for (const [what, view, expected] of cards) {
      const hits: string[] = [];
      for (const press of presses(renderView(RENDERERS, view))) hits.push(...(await reached(press, handlers, inGroup)));
      assert.deepEqual(hits, expected, `${what}${inGroup ? " in a group" : ""}`);
    }
});
