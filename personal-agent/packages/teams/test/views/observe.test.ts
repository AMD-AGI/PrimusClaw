// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/** The suggestion card of an observed group, against what the Python worker's observe.suggestion_card built. */
import assert from "node:assert/strict";
import test from "node:test";

import {
  FeedbackFlow,
  FeedbackThumbs,
  Observer,
  pyJsonDumps,
  type ClickHandler,
  type FeedbackFlowDeps,
  type ObserverDeps,
  type ThumbsDeps,
} from "@primusclaw/personal-agent";

import { toInboundEvent } from "../../src/activity/inbound/index.js";
import { RENDERERS, renderView } from "../../src/views/index.js";
import { world } from "../../../../test-support/routing/world.js";
import { dm, grp } from "../activity/fixtures.js";

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

/** observe.suggestion_card("oc-1", "Infra on-call", "can someone restart the runner?", "在群里回复 / Reply in the group", "on it") */
const PYTHON: unknown = {
  attachments: [
    {
      content: {
        $schema: "http://adaptivecards.io/schemas/adaptive-card.json",
        actions: [
          {
            data: {
              card: "oc-1",
              op: "accept",
              primusclaw: "observe",
            },
            style: "positive",
            title: "接受 / Accept",
            type: "Action.Execute",
            verb: "primusclaw.observe_accept",
          },
          {
            data: {
              card: "oc-1",
              op: "dismiss",
              primusclaw: "observe",
            },
            title: "忽略 / Dismiss",
            type: "Action.Execute",
            verb: "primusclaw.observe_dismiss",
          },
        ],
        body: [
          {
            columns: [
              {
                items: [
                  {
                    color: "Accent",
                    size: "Large",
                    text: "┃",
                    type: "TextBlock",
                    weight: "Bolder",
                  },
                ],
                spacing: "None",
                type: "Column",
                width: "auto",
              },
              {
                items: [
                  {
                    size: "Medium",
                    text: "🔔 群聊观察建议 / Suggestion from a group",
                    type: "TextBlock",
                    weight: "Bolder",
                    wrap: true,
                  },
                  {
                    isSubtle: true,
                    size: "Small",
                    spacing: "None",
                    text: "Infra on-call",
                    type: "TextBlock",
                    wrap: true,
                  },
                ],
                spacing: "Small",
                type: "Column",
                verticalContentAlignment: "Center",
                width: "stretch",
              },
            ],
            type: "ColumnSet",
          },
          {
            facts: [
              {
                title: "群⁠里⁠说 / Said",
                value: "can someone restart the runner?",
              },
              {
                title: "建⁠议 / Would",
                value: "在群里回复 / Reply in the group",
              },
            ],
            type: "FactSet",
          },
          {
            text: "on it",
            type: "TextBlock",
            wrap: true,
          },
          {
            isSubtle: true,
            size: "Small",
            text: "只是记录：按“接受”才会照上面这样执行一次（群里的回复末尾会注明是你的助理起草、你确认的）。 / Only recorded: Accept carries out exactly this, once (a reply in the group ends with a line saying your assistant drafted it and you sent it).",
            type: "TextBlock",
            wrap: true,
          },
        ],
        type: "AdaptiveCard",
        version: "1.5",
      },
      contentType: "application/vnd.microsoft.card.adaptive",
    },
  ],
  type: "message",
};

function python(value: unknown): string {
  return pyJsonDumps(value, { indent: 1, sortKeys: true });
}

test("the observe suggestion card is the python card byte for byte", () => {
  const card = renderView(RENDERERS, {
    name: "observeSuggestion",
    model: {
      cardId: "oc-1",
      group: "Infra on-call",
      message: "can someone restart the runner?",
      kind: "在群里回复 / Reply in the group",
      what: "on it",
    },
  });
  assert.equal(python(card), python(PYTHON));
});

test("a suggestion from a group with no name and an empty reply says so", () => {
  const card = python(
    renderView(RENDERERS, {
      name: "observeSuggestion",
      model: { cardId: "oc-2", group: "", message: "x".repeat(400), kind: "remind", what: "" },
    }),
  );
  assert.ok(card.includes('"text": "群聊 / group chat"') && card.includes('"text": "（空）"'));
  // (Python: the fact's value is clipped to the card kit's 200, after the 300 the suggestion card asks for)
  assert.ok(card.includes(`${"x".repeat(199)}…`) && !card.includes("x".repeat(200)));
});

test("Accept and Dismiss reach the observer through the adapter and the real router", async () => {
  const card = renderView(RENDERERS, {
    name: "observeSuggestion",
    model: { cardId: "oc-1", group: "Infra on-call", message: "x", kind: "k", what: "w" },
  });
  const hits: string[] = [];
  for (const press of presses(card)) hits.push(...(await reached(press, w8Handlers(), false)));
  assert.deepEqual(hits, ["observe", "observe"]);
});
