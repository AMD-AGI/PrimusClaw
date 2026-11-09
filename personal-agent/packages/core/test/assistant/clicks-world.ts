// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/** A press world: a real store, the in-memory board, a recording conversation and a click that records how it was settled. */
import { FakeWorkItems } from "../../../../test-support/assistant/work-items.js";
import { openTestStore } from "../../../../test-support/store.js";
import { FakeSurface, testConversation } from "../../../../test-support/surface.js";
import { Board } from "../../src/assistant/board.js";
import { WatchClicks } from "../../src/assistant/watch-clicks.js";
import { WorkClicks } from "../../src/assistant/work-clicks.js";
import { WorkCardClicks } from "../../src/assistant/work-handler.js";
import type { CardClick } from "../../src/approvals/click.js";
import { silentLogger } from "../../src/ports/logger.js";
import type { ClickRoute, SettleOptions } from "../../src/ports/routing.js";
import type { OutMessage } from "../../src/ports/surface.js";
import { err, ok } from "../../src/result.js";
import type { TokenExchange } from "../../src/plugins/token-exchange.js";

export const ALICE = "aad-a";

export interface Settled {
  readonly card: OutMessage | string;
  readonly options: SettleOptions | undefined;
}

export function describe(m: OutMessage | string | undefined): string {
  if (m === undefined) return "(none)";
  if (typeof m === "string") return m;
  return m.body.type === "view" ? `view:${m.body.view.name}` : m.body.type === "rich" ? m.body.markdown : m.body.text;
}

export function clicksWorld(options: { exchange?: boolean; token?: string | undefined } = {}) {
  const { store, clock } = openTestStore();
  const claw = new FakeWorkItems();
  const surface = new FakeSurface();
  const conversation = surface.conversation(testConversation(`c-${ALICE}`));
  const stopped: string[] = [];
  const exchange: TokenExchange = {
    enabled: options.exchange ?? true,
    tokenFor: () =>
      Promise.resolve(options.token === undefined ? err({ kind: "not_bound" as const }) : ok(options.token)),
    bindingRequest: () => Promise.resolve(err({ kind: "exchange_unavailable" as const })),
    invalidate: () => undefined,
  };
  const board = new Board({
    store,
    claw,
    logger: silentLogger,
    on: () => true,
    remoteAsk: (r) => ({ body: { type: "text", text: `ask ${r.sessionId} ${String(r.ask["action_id"])}` } }),
  });
  const work = new WorkClicks({ store, claw, board, onStopped: (id) => stopped.push(id) });
  const watch = new WatchClicks({ store, claw, exchange, logger: silentLogger });
  const handler = new WorkCardClicks(work, watch, exchange, (u) => store.links.getKey(u) !== null, silentLogger);

  function click(data: Record<string, unknown>, user = ALICE) {
    const settled: Settled[] = [];
    const route = {
      sender: { id: user, name: "", email: "", channelUserId: "" },
      conversation,
      scope: "",
      action: { type: "action", id: "c1", verb: "", data, cardMessageId: "card-1" },
      lang: () => "en" as const,
      settle: (card: OutMessage | string, o?: SettleOptions) => {
        settled.push({ card, options: o });
        return Promise.resolve(true);
      },
    } as unknown as ClickRoute & CardClick;
    return { route, settled };
  }

  function sent(): string[] {
    return surface.outbox.flatMap((r) => (r.op === "send" ? [describe(r.message)] : []));
  }

  return { store, clock, claw, surface, conversation, board, work, watch, handler, click, sent, stopped };
}
