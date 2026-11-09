// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * What the assistant asks this chat to do, and the buttons it puts to the person for that (teams_agent/agent.py `run_action`,
 * `_action_click`, `_confirm_click`). A command is carried out only for a message this worker sent for the person (by its id),
 * only for an action that message declared, once, and exactly as if the person had typed it. Cards are not trusted: a button
 * carries the id of the card this worker recorded, what it means is read from the record, and of two presses exactly one goes on.
 * A held write is answered as the person, with the token the identity service exchanges for them, never their linked key.
 */
import { viewMessage, type CardClick } from "../approvals/click.js";
import { errorName } from "../errors.js";
import { assistantActionText } from "../locales/assistant-actions.js";
import type { ClawAssistantPort } from "../ports/claw/assistant.js";
import type { Logger } from "../ports/logger.js";
import type { ActionCard, ConfirmCard } from "../ports/store/assistant.js";
import type { StorePort } from "../ports/store/index.js";
import type { TokenExchange } from "../plugins/token-exchange.js";
import { cpLength, pySplit, pyStr, pyStrip } from "../text/py-text.js";
import { serviceRefusal } from "../claw/service-refusal.js";
import { CONTEXT_TEXT_MAX } from "./chat.js";
import { confirmOutcome } from "./confirm-outcome.js";
import { refusal, unreachable } from "./failures.js";
import { finish } from "./finish.js";

/** The handoff a message declares for a review asked of someone else: started by the review line (W7), not here. */
export const REVIEW_HANDOFF = "review_for_other";

export type AssistantActionStore = Pick<StorePort, "assistantButtons" | "assistantMessages" | "idempotency">;

export interface AssistantActionDeps {
  readonly store: AssistantActionStore;
  readonly claw: Pick<ClawAssistantPort, "decideConfirmation">;
  readonly exchange: TokenExchange;
  /** Carries out `text` exactly as if the presser had typed it, with their linked `key`; false when it was not done. */
  readonly runCommand: (text: string, click: CardClick, key: string) => Promise<boolean>;
  /** The router's test of a command typed whole. */
  readonly exactCommand: (text: string) => boolean;
  /** The arguments of an `agent` action are one the assistant may ask for. */
  readonly agentActionAllowed: (args: string) => boolean;
  /** The assistant understands the person's messages. */
  readonly understands: (userId: string) => boolean;
  /** The person's assistant can answer them. */
  readonly reachable: (userId: string) => boolean;
  readonly logger: Logger;
}

type Event = Readonly<Record<string, unknown>>;

function record(value: unknown): Event {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Event) : {};
}

/** Python's f-string of a JSON value (`None` for none). */
function formatted(value: unknown): string {
  if (value === null || value === undefined) return "None";
  if (typeof value === "string") return value;
  if (typeof value === "number") return String(value);
  if (typeof value === "boolean") return value ? "True" : "False";
  return JSON.stringify(value);
}

const t = assistantActionText.in("en");

export class AssistantActions {
  constructor(private readonly deps: AssistantActionDeps) {}

  /** A message this worker sent for `userId` declared `name`, and `/{name} {args}` is a command it may carry out. */
  private declared(userId: string, channelMessageId: string, name: string, args: string): boolean {
    const sent = this.deps.store.assistantMessages.assistantMessage(channelMessageId);
    return (
      sent !== null &&
      sent.userId === userId &&
      sent.actions.has(name) &&
      (name !== "agent" || this.deps.agentActionAllowed(args))
    );
  }

  /**
   * An `assistant.action` event for `userId`: carried out by `run` (the command exactly as typed, as the person) only for a message
   * this worker sent for them that declared it, and once per event id. A review handoff is the review line's (W7) and is dropped.
   */
  async runAction(
    userId: string,
    event: Event,
    run: (text: string) => Promise<boolean>,
  ): Promise<"delivered" | "dropped"> {
    const action = record(event["action"]);
    const name = pyStr(action["name"]);
    const args = pySplit(pyStr(action["args"])).join(" ");
    // TODO(W7): `review_for_other` (or any event that carries `review`) is the review handoff (`_review_handoff`).
    if (name === REVIEW_HANDOFF || "review" in event) return "dropped";
    const declared =
      this.declared(userId, pyStr(event["channel_message_id"]), name, args) &&
      cpLength(args) <= CONTEXT_TEXT_MAX &&
      this.deps.understands(userId) &&
      this.deps.reachable(userId);
    if (!declared) {
      // (its name is Claw's text: not logged)
      this.deps.logger.warn("an assistant action was not carried out: not one this chat declared");
      return "dropped";
    }
    const text = pyStrip(`/${name} ${args}`);
    if (
      !this.deps.exactCommand(text) ||
      !this.deps.store.idempotency.claimProcessed(`assistant-action:${formatted(event["event_id"])}`)
    ) {
      return "dropped";
    }
    return (await run(text)) ? "delivered" : "dropped";
  }

  /**
   * Run or Cancel (`op`) under a command the assistant put to the person. The card must be the presser's and not yet used; the
   * command is the recorded one, for a message this worker sent for them that declared it. Run carries it out as typed.
   */
  async actionClick(click: CardClick, key: string): Promise<void> {
    const { store } = this.deps;
    const data = click.action.data;
    const card = store.assistantButtons.getActionCard(pyStr(data["card"]));
    const op = data["op"];
    if ((op !== "run" && op !== "cancel") || card === null || card.userId !== click.sender.id) {
      await finish(click, t.actionGone);
      return;
    }
    if (!store.assistantButtons.moveActionCard(card.cardId, op === "run" ? "busy" : "done", { onlyFrom: "open" })) {
      await finish(click, t.actionUsed);
      return;
    }
    const text = pyStrip(`/${card.name} ${card.args}`);
    if (op === "cancel") {
      await finish(click, t.notRun({ text }));
      return;
    }
    await this.run(click, key, card, text);
  }

  private async run(click: CardClick, key: string, card: ActionCard, text: string): Promise<void> {
    const { store } = this.deps;
    if (!this.declared(click.sender.id, card.channelMessageId, card.name, card.args) || !this.deps.exactCommand(text)) {
      store.assistantButtons.moveActionCard(card.cardId, "done");
      await finish(click, t.actionInvalid({ text }));
      return;
    }
    const done = await this.deps.runCommand(text, click, key);
    store.assistantButtons.moveActionCard(card.cardId, "done");
    await finish(click, done ? t.ran({ text }) : t.couldNotRun({ text }));
  }

  /**
   * Allow or Deny (`op`) on a write Claw holds until the person answers. The card must be the presser's and not yet used; what it
   * answers is the recorded confirmation, as the person with their exchanged token. Of two presses exactly one is sent.
   */
  async confirmClick(click: CardClick): Promise<void> {
    const { store } = this.deps;
    const data = click.action.data;
    const card = store.assistantButtons.getConfirmCard(pyStr(data["card"]));
    const op = data["op"];
    if ((op !== "allow" && op !== "deny") || card === null || card.userId !== click.sender.id) {
      await finish(click, t.confirmGone);
      return;
    }
    if (card.state !== "open") {
      await finish(click, t.confirmUsed);
      return;
    }
    const token = await this.token(click, card);
    if (token === undefined) return;
    if (!store.assistantButtons.moveConfirmCard(card.cardId, "busy", { onlyFrom: "open" })) {
      await finish(click, t.confirmUsed); // (a double tap loses here)
      return;
    }
    let out: Event;
    try {
      out = await this.deps.claw.decideConfirmation(token, card.confirmationId, op);
    } catch (error) {
      await this.notAnswered(click, card, error);
      return;
    }
    store.assistantButtons.moveConfirmCard(card.cardId, "done");
    await finish(click, confirmOutcome(card.kind, out, click.lang()));
  }

  /** The presser's exchanged token; undefined when it cannot be had (the card was answered with why, as it was). */
  private async token(click: CardClick, card: ConfirmCard): Promise<string | undefined> {
    const { exchange, logger } = this.deps;
    const said = assistantActionText.in(click.lang());
    if (!exchange.enabled) {
      await finish(click, said.noExchange);
      return undefined;
    }
    const token = await exchange.tokenFor(click.sender.id);
    if (token.ok) return token.value;
    if (token.error.kind === "not_bound") {
      await this.again(click, card, said.notBound);
      return undefined;
    }
    logger.warn("the token to answer a held write could not be exchanged", {
      reason: token.error.kind === "exchange_failed" ? token.error.reason : token.error.kind,
    });
    await this.again(click, card, said.exchangeFailed);
    return undefined;
  }

  /** Claw did not answer, or refused: a 403 or 404 ends the card (pressing again cannot help); anything else gives it back. */
  private async notAnswered(click: CardClick, card: ConfirmCard, error: unknown): Promise<void> {
    if (!(refusal(error) || unreachable(error))) throw error;
    const { store, logger } = this.deps;
    const said = assistantActionText.in(click.lang());
    const refused = refusal(error);
    logger.warn("a held write's card could not be answered", { error: errorName(error), status: refused?.status });
    if (refused !== undefined && (refused.status === 403 || refused.status === 404)) {
      store.assistantButtons.moveConfirmCard(card.cardId, "done");
      await finish(click, refused.status === 404 ? t.confirmGone : serviceRefusal(refused, said.nothingDone));
      return;
    }
    store.assistantButtons.moveConfirmCard(card.cardId, "open");
    await this.again(click, card, said.clawSilent);
  }

  /** Nothing was answered: the card comes back with `note`, and pressing it again can help. */
  private async again(click: CardClick, card: ConfirmCard, note: string): Promise<void> {
    const model = { text: note, cardId: card.cardId, allowLabel: card.label, lang: click.lang() };
    await click.settle(viewMessage({ name: "confirmWrite", model }), { fallback: note });
  }
}
