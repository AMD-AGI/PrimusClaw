// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Every button on the assistant's, approval and proactive cards reaches the handler that answers it: the press is built as Teams
 * sends it (an `adaptiveCard/action` invoke carrying the button's verb and data), read by the Teams adapter (`toInboundEvent`), and
 * dispatched by its verb as the router does (`ClickHandler.verbs`). A test that calls a handler directly never sees a verb that
 * does not match.
 */
import assert from "node:assert/strict";
import { it } from "node:test";

import type { JsonObject } from "../../packages/teams/src/cards/json.js";
import { toInboundEvent } from "../../packages/teams/src/activity/inbound/to-event.js";
import type { ClickHandler, ClickRoute } from "../../packages/core/src/ports/routing.js";
import type { InboundAction } from "../../packages/core/src/ports/surface.js";
import { ApprovalClicks } from "../../packages/core/src/approvals/handler.js";
import type { ApprovalDecisions } from "../../packages/core/src/approvals/decide.js";
import { AssistantActionClicks } from "../../packages/core/src/assistant/action-handler.js";
import { WorkCardClicks } from "../../packages/core/src/assistant/work-handler.js";
import type { WatchClicks } from "../../packages/core/src/assistant/watch-clicks.js";
import type { WorkClicks } from "../../packages/core/src/assistant/work-clicks.js";
import type { TokenExchange } from "../../packages/core/src/plugins/token-exchange.js";
import { silentLogger } from "../../packages/core/src/ports/logger.js";
import { APPROVAL_CARDS } from "../card-catalog/approval.js";
import { ASSISTANT_CARDS, wi } from "../card-catalog/assistant.js";
import { assistantRenderers, boardButtons } from "../../packages/teams/src/views/assistant/index.js";
import { PROACTIVE_CARDS } from "../card-catalog/proactive.js";

/** The verbs of buttons other lines answer (W4b's Show here). */
const ELSEWHERE = new Set(["show"]);

interface Button {
  readonly card: string;
  readonly type: string;
  readonly verb: string;
  readonly data: JsonObject;
}

function* buttonsIn(card: string, node: unknown): Generator<Button> {
  if (Array.isArray(node)) {
    for (const child of node) yield* buttonsIn(card, child);
    return;
  }
  if (typeof node !== "object" || node === null) return;
  const fields = node as JsonObject;
  const type = fields["type"];
  if (type === "Action.Execute" || type === "Action.Submit") {
    const verb = fields["verb"];
    yield {
      card,
      type,
      verb: typeof verb === "string" ? verb : "",
      data: (fields["data"] ?? {}) as JsonObject,
    };
  }
  for (const value of Object.values(fields)) yield* buttonsIn(card, value);
}

/** The buttons the catalog's cards do not show: the board's Accept all and Retry, a task card's Watch and Unwatch. */
function moreCards(): ReadonlyArray<readonly [string, unknown]> {
  const task = wi({ boardState: "in_progress", canAccept: false });
  const card = (watch: boolean, watching: boolean) =>
    assistantRenderers.workCard({ item: task, text: "t", cardId: "card-9", note: "", watch, watching, lang: null });
  return [
    [
      "board buttons",
      boardButtons(["card-1", "card-2"], [{ cardId: "card-3", item: wi({ boardState: "done" }) }], "en"),
    ],
    ["work watch", card(true, false)],
    ["work unwatch", card(false, true)],
  ];
}

const BUTTONS = [
  ...[...APPROVAL_CARDS, ...ASSISTANT_CARDS, ...PROACTIVE_CARDS].map((entry) => [entry.id, entry.build()] as const),
  ...moreCards(),
].flatMap(([id, card]) => [...buttonsIn(id, card)]);

/** The activity Teams sends for a press on `button` in a 1:1 chat. */
function press(button: Button): JsonObject {
  const base = {
    id: "inv-1",
    replyToId: "card-1",
    serviceUrl: "https://smba.trafficmanager.net/amer/",
    from: { id: "29:a", aadObjectId: "aad-a", name: "Hui Rui" },
    recipient: { id: "28:bot" },
    conversation: { id: "a:1", conversationType: "personal" },
  };
  return button.type === "Action.Execute"
    ? {
        ...base,
        type: "invoke",
        name: "adaptiveCard/action",
        value: { action: { type: "Action.Execute", verb: button.verb, data: button.data } },
      }
    : { ...base, type: "message", text: "", value: button.data };
}

function actionOf(button: Button): InboundAction {
  const read = toInboundEvent(press(button));
  assert.ok(read.ok && read.value?.type === "action", `${button.card}: ${JSON.stringify(button.data)}`);
  return read.value;
}

/** The three handlers of these cards, each recording which of its features a press reached. */
function handlers(reached: string[]): ClickHandler[] {
  const decisions = {
    decide: (click: ClickRoute) => Promise.resolve(void reached.push(`decide ${click.action.verb}`)),
  } as unknown as ApprovalDecisions;
  const work = {
    acceptOrStop: (_c: ClickRoute, _k: string, op: string) => Promise.resolve(void reached.push(`work ${op}`)),
    retry: () => Promise.resolve(void reached.push("work retry")),
    acceptAll: () => Promise.resolve(void reached.push("work accept_all")),
  } as unknown as WorkClicks;
  const watch = {
    watch: () => Promise.resolve(void reached.push("work watch")),
    unwatch: () => Promise.resolve(void reached.push("work unwatch")),
  } as unknown as WatchClicks;
  return [
    new ApprovalClicks(
      decisions,
      () => false,
      () => Promise.resolve("ak"),
    ),
    new WorkCardClicks(work, watch, { enabled: false } as unknown as TokenExchange, () => true, silentLogger),
    new AssistantActionClicks({
      actionClick: (click) => Promise.resolve(void reached.push(`action ${String(click.action.data["op"])}`)),
      confirmClick: (click) => Promise.resolve(void reached.push(`confirm ${String(click.action.data["op"])}`)),
    }),
  ];
}

/** Dispatch by verb, as the router does: the handler whose verbs name it, with the person's credential. */
async function dispatch(action: InboundAction, reached: string[]): Promise<void> {
  const handler = handlers(reached).find((h) => h.verbs.includes(action.verb));
  assert.ok(handler !== undefined, `no handler answers the verb "${action.verb}"`);
  const click = { action, sender: { id: "aad-a" } } as unknown as ClickRoute;
  assert.ok(handler.withCredential !== undefined);
  await handler.withCredential(click, "ak");
}

it("every button of these cards is read with a verb that a handler answers", () => {
  assert.ok(BUTTONS.length > 0);
  const verbs = new Set(handlers([]).flatMap((h) => [...h.verbs]));
  for (const button of BUTTONS) {
    const { verb } = actionOf(button);
    assert.ok(verbs.has(verb) || ELSEWHERE.has(verb), `${button.card}: "${verb}" is answered by no handler`);
  }
});

it("a press on each kind of card reaches what answers it", async () => {
  const expected: ReadonlyArray<readonly [string, (b: Button) => boolean, string]> = [
    ["approval", (b) => b.data["primusclaw"] === "decision", "decide decision"],
    ["question", (b) => b.data["primusclaw"] === "answer", "decide answer"],
    ["work card", (b) => b.data["primusclaw"] === "work" && b.data["op"] === "stop", "work stop"],
    ["work card accept", (b) => b.data["primusclaw"] === "work" && b.data["op"] === "accept", "work accept"],
    ["board retry", (b) => b.data["primusclaw"] === "work" && b.data["op"] === "retry", "work retry"],
    ["board accept all", (b) => b.data["primusclaw"] === "work" && b.data["op"] === "accept_all", "work accept_all"],
    ["work watch", (b) => b.data["primusclaw"] === "work" && b.data["op"] === "watch", "work watch"],
    ["work unwatch", (b) => b.data["primusclaw"] === "work" && b.data["op"] === "unwatch", "work unwatch"],
    ["assistant action", (b) => b.data["primusclaw"] === "assistant_action" && b.data["op"] === "run", "action run"],
    [
      "assistant action cancel",
      (b) => b.data["primusclaw"] === "assistant_action" && b.data["op"] === "cancel",
      "action cancel",
    ],
    [
      "assistant confirm",
      (b) => b.data["primusclaw"] === "assistant_confirm" && b.data["op"] === "allow",
      "confirm allow",
    ],
    [
      "assistant confirm deny",
      (b) => b.data["primusclaw"] === "assistant_confirm" && b.data["op"] === "deny",
      "confirm deny",
    ],
  ];
  for (const [what, which, outcome] of expected) {
    const button = BUTTONS.find(which);
    assert.ok(button, `no ${what} button in the catalog`);
    const reached: string[] = [];
    await dispatch(actionOf(button), reached);
    assert.deepEqual(reached, [outcome], what);
  }
});
