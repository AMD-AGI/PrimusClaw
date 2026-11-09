// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * A world for the assistant's actions and their buttons: the real store, a Claw that records how a held write was answered, a token
 * exchange the test steers, a command path that records what it was handed, and a click that records how it was settled.
 */
import { openTestStore } from "../../../../test-support/store.js";
import { AssistantActions } from "../../src/assistant/actions.js";
import type { CardClick } from "../../src/approvals/click.js";
import { agentActionAllowed, channelActions } from "../../src/capabilities/visibility.js";
import type { Lang } from "../../src/locales/lang.js";
import type { Logger } from "../../src/ports/logger.js";
import type { SettleOptions } from "../../src/ports/routing.js";
import type { JsonObject } from "../../src/ports/store/json.js";
import type { OutMessage } from "../../src/ports/surface.js";
import type { ExchangeError, TokenExchange } from "../../src/plugins/token-exchange.js";
import { err, ok, type Result } from "../../src/result.js";

export const ALICE = "aad-a";
export const BOB = "aad-b";
/** What a 1:1 message of Alice's declares, as the chat of the Python tests' world does (GitHub and remote agents on, no brief). */
export const DECLARED = [...new Set(channelActions(new Set(["github", "remote"])).map((a) => a.name))];
/** The commands the worker handles itself (understanding.exact_command, for the words these tests use). */
const KNOWN = new Set([
  "quiet",
  "memory",
  "unlink",
  "github",
  "link",
  "agent",
  "brief",
  "board",
  "lang",
  "pause",
  "resume",
]);

function exactCommand(text: string): boolean {
  const word = text.split(/\s+/)[0] ?? "";
  return word.startsWith("/") && KNOWN.has(word.slice(1).toLowerCase());
}

/** Claw's answer to a held write's press when the test sets none (the Python tests' FakeClaw). */
function answer(confirmationId: string, decision: string): JsonObject {
  if (decision === "deny") {
    return {
      confirmation_id: confirmationId,
      kind: "trigger_create",
      status: "denied",
      answered_now: true,
      result: null,
    };
  }
  const trigger = {
    trigger_id: "t-1",
    name: "PR brief",
    schedule: "0 9 * * *",
    timezone: "Asia/Shanghai",
    next_fire_at: "2026-11-07T01:00:00.000Z",
  };
  return {
    confirmation_id: confirmationId,
    kind: "trigger_create",
    status: "done",
    answered_now: true,
    result: { trigger },
  };
}

export interface Settled {
  readonly card: OutMessage | string;
  readonly options: SettleOptions | undefined;
}

type Token = (user: string) => Promise<Result<string, ExchangeError>>;

const bound: Token = (user) =>
  Promise.resolve(user === ALICE || user === BOB ? ok(`tok-${user}`) : err({ kind: "not_bound" as const }));

/** A token exchange the test steers: on or off, and what it answers. */
class SteeredExchange implements TokenExchange {
  enabled = true;
  token: Token = bound;
  tokenFor(user: string): Promise<Result<string, ExchangeError>> {
    return this.token(user);
  }
  bindingRequest(): Promise<Result<never, { kind: "exchange_unavailable" }>> {
    return Promise.resolve(err({ kind: "exchange_unavailable" as const }));
  }
  invalidate(): void {
    return undefined;
  }
}

export class ActionsWorld {
  readonly store = openTestStore().store;
  readonly decided: [string, string, string][] = [];
  readonly ran: string[] = [];
  readonly warned: string[] = [];
  readonly settled: Settled[] = [];
  /** What Claw answers a held write's press with (undefined: its usual answer). */
  held: JsonObject | Error | undefined;
  commandDone = true;
  readonly exchange = new SteeredExchange();
  readonly actions: AssistantActions;

  set exchangeOn(on: boolean) {
    this.exchange.enabled = on;
  }

  get token(): Token {
    return this.exchange.token;
  }

  set token(token: Token) {
    this.exchange.token = token;
  }

  constructor(options: { understands?: boolean; reachable?: boolean } = {}) {
    this.actions = new AssistantActions({
      store: this.store,
      claw: { decideConfirmation: (token, id, decision) => this.decide(token, id, decision) },
      exchange: this.exchange,
      runCommand: (text) => this.command(text),
      exactCommand,
      agentActionAllowed,
      understands: (user) => (options.understands ?? true) && user === ALICE,
      reachable: () => options.reachable ?? true,
      logger: this.logger(),
    });
  }

  private logger(): Logger {
    const logger: Logger = {
      debug: () => undefined,
      info: () => undefined,
      warn: (message) => this.warned.push(message),
      error: () => undefined,
      child: () => logger,
    };
    return logger;
  }

  private decide(token: string, confirmationId: string, decision: string): Promise<JsonObject> {
    this.decided.push([token, confirmationId, decision]);
    const held = this.held;
    if (held instanceof Error) return Promise.reject(held);
    return Promise.resolve(held ?? answer(confirmationId, decision));
  }

  private command(text: string): Promise<boolean> {
    this.ran.push(text);
    return Promise.resolve(this.commandDone);
  }

  click(data: Record<string, unknown>, user = ALICE, lang: Lang = "en"): CardClick {
    return {
      sender: { id: user, name: "", email: "", channelUserId: "" },
      conversation: {} as CardClick["conversation"],
      scope: "",
      action: { data },
      lang: () => lang,
      settle: (card, options) => {
        this.settled.push({ card, options });
        return Promise.resolve(true);
      },
    };
  }

  /** What the person was last told: a note's text, or the line said beside a card. */
  said(): string {
    const last = this.settled.at(-1);
    if (last === undefined) return "(nothing)";
    return typeof last.card === "string" ? last.card : (last.options?.fallback ?? "");
  }

  /** The card the press left: a note's text, or the card's own text when it is a card again. */
  card(): { text: string; view: string; model: Record<string, unknown> } {
    const last = this.settled.at(-1);
    if (last === undefined) return { text: "", view: "none", model: {} };
    if (typeof last.card === "string") return { text: last.card, view: "note", model: {} };
    const body = last.card.body;
    if (body.type !== "view") return { text: "", view: body.type, model: {} };
    const model = body.view.model as unknown as Record<string, unknown>;
    return { text: typeof model["text"] === "string" ? model["text"] : "", view: body.view.name, model };
  }

  /** A message the worker sent for `user` declaring `declared`; its channel message id. */
  message(id = "act-1", user = ALICE, declared: readonly string[] = DECLARED): string {
    this.store.assistantMessages.noteAssistantMessage(id, user, declared);
    return id;
  }

  action(channelMessageId: string, name: string, args = "", eventId = "ev-1"): JsonObject {
    return {
      type: "assistant.action",
      event_id: eventId,
      occurred_at: "2026-11-04T05:00:00Z",
      user_id: "u-alice",
      channel_message_id: channelMessageId,
      action: { name, args },
    };
  }

  runAction(event: JsonObject, user = ALICE): Promise<"delivered" | "dropped"> {
    return this.actions.runAction(user, event, (text) => this.command(text));
  }

  actionCard(channelMessageId: string, name: string, args: string, user = ALICE): string {
    return this.store.assistantButtons.addActionCard(user, channelMessageId, name, args);
  }

  confirmCard(confirmationId = "cf-1", kind = "trigger_create", label = "Create", user = ALICE): string {
    return this.store.assistantButtons.addConfirmCard(user, confirmationId, kind, label);
  }

  run(card: string, user = ALICE, op = "run"): Promise<void> {
    return this.actions.actionClick(this.click({ primusclaw: "assistant_action", op, card }, user), `ak-${user}`);
  }

  confirm(
    card: string,
    op = "allow",
    user = ALICE,
    extra: Record<string, unknown> = {},
    lang: Lang = "en",
  ): Promise<void> {
    return this.actions.confirmClick(this.click({ primusclaw: "assistant_confirm", op, card, ...extra }, user, lang));
  }
}
