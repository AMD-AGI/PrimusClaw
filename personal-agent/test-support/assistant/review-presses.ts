// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * A worker as far as a review and the presses on its cards reach (the Python `test_github_review` / `test_review_items` worlds):
 * W7's review service (`reviewWorld`, its turns started on the router through `routedReviewTurns`), W4's router with this
 * line's click handlers (approval and question cards, work-item cards), and one store and one channel for all of them.
 */
import {
  ApprovalClicks,
  ApprovalDecisions,
  Board,
  ClawError,
  GithubReview,
  WorkCardClicks,
  WorkClicks,
  type ClawWorkItemsPort,
  type Decision,
  type WatchClicks,
  type WorkItem,
  routedReviewTurns,
  silentLogger,
  type ClawSessionsPort,
  type InboundAction,
  type JsonObject,
  type StartReviewTurn,
  type TokenExchange,
  type UserRef,
} from "@primusclaw/personal-agent";

import type { Chat } from "../../packages/core/src/routing/chat.js";
import { ClawHttp } from "../../packages/runtime/src/claw/http.js";
import { HttpWorkItems } from "../../packages/runtime/src/claw/work-items.js";
import { Credentials } from "../../packages/core/src/routing/credentials.js";
import { CommandViews } from "../../packages/core/src/routing/views.js";
import { inboundAction } from "../inbound.js";
import { SeededRandom } from "../random.js";
import {
  ALICE,
  ALICE_DM,
  CONV,
  PR,
  reviewWorld,
  withItems,
  type WorldOptions as ReviewOptions,
} from "../review-world.js";
import { world as routerWorld } from "../routing/world.js";

/** The approval of a review's own turn (Python `OPEN_APPROVAL`) and the session the review's turn makes of the asker's token. */
export const OPEN_APPROVAL = { tool: "gh_pr_review", toolUseId: "tu9" } as const;
export const REVIEW_SESSION = "sess-tok-aad-a";
export const ORDINARY_SESSION = "sess-ordinary";
export const ALICE_KEY = "ak-alice-linked";

/** A Claw that answers approvals and records them (Python `world.claw.calls` "decide" and `acting_decides`). */
export class DecidingClaw {
  readonly decides: [string, string, string, string, string][] = [];
  readonly acting: [string, string, string][] = [];
  failWith: Error | undefined;

  port(): Pick<ClawSessionsPort, "decide" | "answer"> {
    return {
      decide: (credential, sessionId, toolUseId, action, options) => {
        this.decides.push(["decide", credential, sessionId, toolUseId, action]);
        if (options?.acting === true) this.acting.push([credential, sessionId, toolUseId]);
        return this.failWith === undefined ? Promise.resolve() : Promise.reject(this.failWith);
      },
      answer: () => Promise.reject(new Error("no question is answered here")),
    };
  }
}

/** The identity service of the review world, with what a test sets: a person not bound, the service down, who was asked. */
export class Exchange implements TokenExchange {
  readonly enabled = true;
  readonly asked: string[] = [];
  down = false;

  constructor(
    private readonly inner: TokenExchange,
    readonly bound: Set<string>,
  ) {}

  tokenFor(userId: string): ReturnType<TokenExchange["tokenFor"]> {
    this.asked.push(userId);
    if (this.down)
      return Promise.resolve({ ok: false, error: { kind: "exchange_failed", reason: "identity service down" } });
    return this.inner.tokenFor(userId);
  }

  bindingRequest(userId: string): ReturnType<TokenExchange["bindingRequest"]> {
    return Promise.resolve({
      ok: true,
      value: { confirmUrl: `https://id.test/confirm?u=${userId}`, expiresInSeconds: 600 },
    });
  }

  invalidate(): void {
    return undefined;
  }
}

export function pressesWorld(options: ReviewOptions = {}) {
  const review = reviewWorld(["AMD-AGI"], options);
  const { store, clock, surface } = review;
  const decider = new DecidingClaw();
  const exchange = new Exchange(review.deps.exchange, review.bound);
  const router = routerWorld({ testStore: { store, clock } as never, surface });
  const credentials = new Credentials(
    { ...router.deps, exchange },
    new CommandViews(router.deps.config.botName, router.deps.config.publicBaseUrl, router.deps.note),
  );
  const decisions = new ApprovalDecisions({
    store,
    claw: decider.port(),
    exchange,
    allowance: { take: () => undefined, giveBack: () => undefined },
    audit: () => undefined,
    logger: silentLogger,
    connectIdentity: async (click) => {
      const chat = { sender: click.sender, lang: click.lang } as unknown as Chat;
      await click.conversation.send(await credentials.bindingCard(chat));
    },
  });
  const approvals = new ApprovalClicks(
    decisions,
    (sessionId) => store.reviewDelegation.isActingSession(sessionId),
    (userId) => Promise.resolve(store.links.getKey(userId)),
  );
  (router.deps.handlers as unknown as { clicks: unknown[] }).clicks = [approvals];
  // The review's turns run on the router (Python `_guarded` for a review), as the worker's assembly wires them.
  const startTurn = routedReviewTurns(
    (request) => router.router.startTurn(request),
    (request: StartReviewTurn) => router.router.chat(request.message.sender, request.conversation, request.scope),
    store,
    () => Promise.resolve(),
  );
  const service = new GithubReview(
    { ...review.deps, host: { ...review.deps.host, startTurn } },
    new SeededRandom(7),
    () => Promise.resolve(),
  );
  return { ...review, service, router, decider, exchange };
}

export type PressesWorld = ReturnType<typeof pressesWorld>;

/**
 * A tap on Approve / Deny under an approval card (Python `approval_click`): in the group the card is in, or in the person's own
 * chat (Claw's notification). The card is message "card-9".
 */
export function approvalClick(
  options: {
    user?: UserRef;
    session?: string;
    action?: string;
    chat?: "group" | "1:1";
    id?: string;
    toolUseId?: string;
  } = {},
): InboundAction {
  const user = options.user ?? ALICE;
  const group = (options.chat ?? "group") === "group";
  const id = group ? CONV : `conv-${user.id}`;
  const data: JsonObject = {
    primusclaw: "decision",
    session_id: options.session ?? REVIEW_SESSION,
    tool: OPEN_APPROVAL.tool,
    tool_use_id: options.toolUseId ?? OPEN_APPROVAL.toolUseId,
    action: options.action ?? "allow",
  };
  return inboundAction({
    id: options.id ?? "a1",
    sender: user,
    conversation: {
      id,
      kind: group ? "group" : "personal",
      tenantId: "tenant-1",
      wire: { conversation: { id }, serviceUrl: "https://smba.test/" },
    },
    verb: "decision",
    clickVerb: "primusclaw.decision",
    data,
    cardMessageId: "card-9",
  });
}

/**
 * An approval of `user` waiting in a session, written the way the notification path writes it (Python `waiting`): in a session
 * that acts as a user when `acting`, else in an ordinary one.
 */
export function waiting(world: PressesWorld, acting = true, user = "aad-a"): string {
  const session = acting ? REVIEW_SESSION : ORDINARY_SESSION;
  if (acting) world.store.reviewDelegation.noteActingSession(session, "aad-a", "aad-b");
  const saved = world.store.approvals.saveApproval({
    userId: user,
    sessionId: session,
    toolUseId: OPEN_APPROVAL.toolUseId,
    tool: OPEN_APPROVAL.tool,
    expiresAt: world.store.now() + 600,
  });
  if (!saved) throw new Error("the approval was not saved");
  return session;
}

// --- the Stop card of a review item (test_review_items) ---------------------------------------------------------------------

/** What Claw answers a Stop with: a decision (Python `world.claw.decision`), or Claw's own HTTP answer, read by the real client. */
export class StopClaw {
  readonly calls: [string, string, string][] = [];
  decision: Decision | undefined;
  /** [status, body]: the answer of `POST /v1/work-items/:id/stop` (Python `stop_answer`). */
  answer: [number, unknown] | undefined;

  port(): Pick<ClawWorkItemsPort, "get" | "accept" | "stop" | "retry"> {
    const real = new HttpWorkItems(
      new ClawHttp("https://claw.test", () => {
        const [status, body] = this.answer ?? [500, {}];
        return Promise.resolve(
          new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }),
        );
      }),
    );
    return {
      get: () => Promise.reject(new Error("no get here")),
      accept: () => Promise.reject(new Error("no accept here")),
      retry: () => Promise.reject(new Error("no retry here")),
      stop: (key, itemId) => {
        this.calls.push(["stop_item", key, itemId]);
        if (this.answer !== undefined) return real.stop(key, itemId);
        if (this.decision === undefined) return Promise.reject(new ClawError(500));
        return Promise.resolve(this.decision);
      },
    };
  }
}

/** A review item as Claw answers it (Python `item(**changes)`): #1, done and stopped unless changed. */
export function stoppedItem(changes: Partial<WorkItem> = {}): WorkItem {
  return {
    itemId: "item-1",
    seq: 1,
    title: `Review ${PR}`,
    boardState: "done",
    resultVersion: 0,
    canAccept: false,
    lastReportKind: null,
    pendingQuestion: null,
    summary: "",
    outcome: "stopped",
    kind: "review",
    params: { pr: { owner: "AMD-AGI", repo: "Hyperloom", number: 12 } },
    pull: { owner: "AMD-AGI", repo: "Hyperloom", number: 12 },
    updatedAt: "",
    ...changes,
  };
}

/** The asker's view of Bob's finished review, as the fake ends it at the first read (Python `ItemsClaw`). */
export const ENDED_VIEW = {
  status: "done",
  prUrl: "https://github.com/AMD-AGI/Hyperloom/pull/12",
  verdict: "approve",
  merged: true,
};

/**
 * The world of a review Claw makes as an item (Python `items_world`): Alice has a 1:1 chat, the items are #1.., their Stop
 * cards are answered by this line's WorkCardClicks on the router, and a stop made there ends what follows the item here.
 */
export function itemsWorld(options: ReviewOptions = {}) {
  const w = pressesWorld(options);
  withItems(w, { seqFrom: 1 });
  w.claw.views.set("item-1", ENDED_VIEW);
  w.store.references.saveReference("aad-a", { conversation: { id: ALICE_DM } });
  const stops = new StopClaw();
  const board = new Board({
    store: w.store,
    claw: {
      list: () => Promise.resolve([]),
      askedOfOthers: () => Promise.resolve([]),
      watches: () => Promise.resolve([]),
    },
    logger: silentLogger,
    on: () => true,
    remoteAsk: { askOf: () => undefined } as never,
  });
  const routerCtx = (w.router.router as unknown as { ctx: { itemStopped(itemId: string): void } }).ctx;
  const work = new WorkClicks({
    store: w.store,
    claw: stops.port(),
    board,
    // (the review's own follow ends as stopped, and the router's turn that follows the item: Python `_item_stopped`)
    onStopped: (itemId) => {
      w.service.itemStopped(itemId);
      routerCtx.itemStopped(itemId);
    },
  });
  const clicks = new WorkCardClicks(
    work,
    {} as WatchClicks,
    w.exchange,
    (userId) => w.store.links.getKey(userId) !== null,
    silentLogger,
  );
  (w.router.deps.handlers as unknown as { clicks: unknown[] }).clicks.push(clicks);
  return { ...w, stops };
}

export type ItemsWorld = ReturnType<typeof itemsWorld>;
