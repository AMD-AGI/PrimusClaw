// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/** The suggestion card of an observed group, against what the Python worker's observe.suggestion_card built. */
import assert from "node:assert/strict";
import test from "node:test";

import { pyJsonDumps } from "@primusclaw/personal-agent";

import { RENDERERS, renderView } from "../../src/views/index.js";

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
