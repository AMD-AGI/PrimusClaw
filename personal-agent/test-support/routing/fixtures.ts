// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/** What the routing tests share: people, conversations, a note factory and a token exchange that answers as told. */
import {
  err,
  ok,
  textMessage,
  type BindingRequest,
  type ConversationRef,
  type ExchangeError,
  type InboundAction,
  type Result,
  type TokenExchange,
  type UserRef,
} from "@primusclaw/personal-agent";

import { inboundAction } from "../inbound.js";
import type { NoteFactory } from "../../packages/core/src/routing/features.js";

export const ALICE: UserRef = { id: "aad-a", channelUserId: "29:a", name: "Alice", email: "" };
export const BOB: UserRef = { id: "aad-b", channelUserId: "29:b", name: "Bob", email: "bob@example.com" };

export function personal(id = "dm-a"): ConversationRef {
  return { id, kind: "personal", tenantId: "t1", wire: { conversation: { id } } };
}

export function group(id = "g-1"): ConversationRef {
  return { id, kind: "group", tenantId: "t1", wire: { conversation: { id, conversationType: "groupChat" } } };
}

/** A note card as plain text, so a test reads what it says ("note: <text> [buttons]"). */
export const note: NoteFactory = (text, options = {}) => {
  const buttons = (options.buttons ?? []).map((b) => b.title).join(",");
  return textMessage(`note:${options.title ?? ""}:${text}${buttons ? ` [${buttons}]` : ""}`);
};

export function click(verb: string, data: Record<string, unknown> = {}, cardMessageId = "card-1"): InboundAction {
  return inboundAction({
    id: `act-${verb}`,
    sender: ALICE,
    conversation: personal(),
    locale: "",
    clientPlatform: "",
    verb,
    clickVerb: verb,
    data,
    cardMessageId,
  });
}

/** An identity service that answers as the test sets it. */
export class FakeExchange implements TokenExchange {
  enabled = true;
  /** userId -> token; a person not here is not bound. */
  readonly tokens = new Map<string, string>();
  down = false;
  bindingDown = false;
  readonly invalidated: string[] = [];
  readonly asked: string[] = [];

  tokenFor(userId: string): Promise<Result<string, ExchangeError>> {
    this.asked.push(userId);
    if (this.down) return Promise.resolve(err({ kind: "exchange_failed", reason: "503" }));
    const token = this.tokens.get(userId);
    return Promise.resolve(token === undefined ? err({ kind: "not_bound" }) : ok(token));
  }

  bindingRequest(userId: string): Promise<Result<BindingRequest, { kind: "exchange_failed"; reason: string }>> {
    if (this.bindingDown) return Promise.resolve(err({ kind: "exchange_failed", reason: "503" }));
    return Promise.resolve(ok({ confirmUrl: `https://id.test/confirm?u=${userId}`, expiresInSeconds: 600 }));
  }

  invalidate(userId: string): void {
    this.invalidated.push(userId);
  }
}
