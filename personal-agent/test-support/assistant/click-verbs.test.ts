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
import { CHOICE_VERB } from "../../packages/core/src/assistant/choice-clicks.js";
import { WorkCardClicks } from "../../packages/core/src/assistant/work-handler.js";
import type { WatchClicks } from "../../packages/core/src/assistant/watch-clicks.js";
import type { WorkClicks } from "../../packages/core/src/assistant/work-clicks.js";
import type { TokenExchange } from "../../packages/core/src/plugins/token-exchange.js";
import { silentLogger } from "../../packages/core/src/ports/logger.js";
import { link, said, world } from "../routing/world.js";
import { APPROVAL_CARDS } from "../card-catalog/approval.js";
import { ASSISTANT_CARDS, wi } from "../card-catalog/assistant.js";
import { assistantRenderers, boardButtons } from "../../packages/teams/src/views/assistant/index.js";
import { PROACTIVE_CARDS } from "../card-catalog/proactive.js";
import { SKILL_CARDS } from "../card-catalog/skills.js";
import { SKILL_VERB } from "../../packages/core/src/skills/views.js";

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
  ...[...APPROVAL_CARDS, ...ASSISTANT_CARDS, ...PROACTIVE_CARDS, ...SKILL_CARDS].map(
    (entry) => [entry.id, entry.build()] as const,
  ),
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

/** A button's `op`, as text. */
function opOf(data: Readonly<Record<string, unknown>>): string {
  const op = data["op"];
  return typeof op === "string" ? op : "";
}

/** The handlers of these cards, each recording which of its features a press reached and settling it, as they do. */
function handlers(reached: string[]): ClickHandler[] {
  const hit = async (click: ClickRoute, what: string): Promise<void> => {
    reached.push(what);
    await click.settle(what);
  };
  const decisions = {
    decide: (click: ClickRoute) => hit(click, `decide ${click.action.verb}`),
  } as unknown as ApprovalDecisions;
  const work = {
    acceptOrStop: (click: ClickRoute, _k: string, op: string) => hit(click, `work ${op}`),
    retry: (click: ClickRoute) => hit(click, "work retry"),
    acceptAll: (click: ClickRoute) => hit(click, "work accept_all"),
  } as unknown as WorkClicks;
  const watch = {
    watch: (click: ClickRoute) => hit(click, "work watch"),
    unwatch: (click: ClickRoute) => hit(click, "work unwatch"),
  } as unknown as WatchClicks;
  return [
    new ApprovalClicks(
      decisions,
      () => false,
      () => Promise.resolve("ak"),
    ),
    new WorkCardClicks(work, watch, { enabled: false } as unknown as TokenExchange, () => true, silentLogger),
    new AssistantActionClicks({
      actionClick: (click) => hit(click as ClickRoute, `action ${opOf(click.action.data)}`),
      confirmClick: (click) => hit(click as ClickRoute, `confirm ${opOf(click.action.data)}`),
    }),
    {
      verbs: [CHOICE_VERB],
      beforeCredential: async (click) => {
        await hit(click, "choice");
        return true;
      },
    },
    {
      verbs: [SKILL_VERB],
      withCredential: (click) => hit(click, `skill ${opOf(click.action.data)}`),
    },
  ];
}

const INACTIVE = "That button is not active any more.";

/**
 * A worker's router (W4's, as production assembles it) with the handlers of these cards registered, Alice linked, and
 * every session a Show here button names answered.
 */
function routed(reached: string[]) {
  const w = world({ handlers: { clicks: handlers(reached) } });
  link(w, "aad-a", "ak");
  for (const button of BUTTONS) {
    const session = button.data["session_id"];
    if (button.data["primusclaw"] === "show" && typeof session === "string") {
      w.turns.lastAnswers.set(session, `The answer of ${session}.`);
    }
  }
  return w;
}

/** Press `button` as Teams sends it, read by the Teams adapter, handled by the router. */
async function pressed(button: Button) {
  const reached: string[] = [];
  const w = routed(reached);
  await w.router.handle(actionOf(button));
  await w.router.settled();
  return { w, reached, said: said(w) };
}

it("every button of these cards is answered by the handler of its kind, through the router", async () => {
  assert.ok(BUTTONS.length > 0);
  for (const button of BUTTONS) {
    const { reached, said: out } = await pressed(button);
    assert.ok(
      !out.includes(INACTIVE),
      `${button.card}: ${JSON.stringify(button.data["primusclaw"])} is answered by no handler`,
    );
    const shown = out.some((t) => t.startsWith("Here is the answer."));
    assert.equal(reached.length + (shown ? 1 : 0), 1, `${button.card}: ${JSON.stringify(reached)} ${out.join(" | ")}`);
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
    ["assistant choice", (b) => b.data["primusclaw"] === "assistant_choice", "choice"],
    ["skill undo", (b) => b.data["primusclaw"] === SKILL_VERB && b.data["op"] === "undo", "skill undo"],
    ["skill edit", (b) => b.data["primusclaw"] === SKILL_VERB && b.data["op"] === "edit", "skill edit"],
    [
      "skill save changes",
      (b) => b.data["primusclaw"] === SKILL_VERB && b.data["op"] === "save_edit",
      "skill save_edit",
    ],
  ];
  for (const [what, which, outcome] of expected) {
    const button = BUTTONS.find(which);
    assert.ok(button, `no ${what} button in the catalog`);
    const { reached } = await pressed(button);
    assert.deepEqual(reached, [outcome], what);
  }
});

it("Show here on a run's card and on the digest posts that session's answer and makes it the chat's session", async () => {
  // W4's handler (Python agent.py `_show`): read with the presser's own key, answered in the chat, then the current session.
  for (const card of ["run_completed", "run_failed", "digest"]) {
    const button = BUTTONS.find((b) => b.card === card && b.data["primusclaw"] === "show");
    assert.ok(button, `no Show here on ${card}`);
    const session = button.data["session_id"];
    assert.ok(typeof session === "string", card);
    const { w, said: out } = await pressed(button);
    assert.deepEqual(w.turns.lastAnswerReads, [["ak", session]], card);
    assert.ok(
      out.some(
        (t) => t === `Here is the answer. Your next message continues this session.\n\nThe answer of ${session}.`,
      ),
      `${card}: ${out.join(" | ")}`,
    );
    assert.equal(w.store.sessions.getSession("aad-a"), session, card);
  }
});
