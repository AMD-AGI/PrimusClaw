// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import { errorName } from "../errors.js";
import type { Lang } from "../locales/lang.js";
import type { InboundFile } from "../ports/surface.js";
import { REPO_HOST } from "../commands/repo.js";
import { routingText } from "../locales/routing.js";
import { cpHead, squashSpaces } from "../text/py-text.js";
import type { Chat } from "./chat.js";
import type { RouterContext } from "./context.js";
import { ActiveTurn, chatTurnKey, reviewTurnKey, type TurnKey } from "./turn-registry.js";
import type { ReviewRunFields, TurnHooks, TurnOutcome, TurnRun } from "./turn-runner.js";

/** What a waiting message gives the turn in front to start running in Claw (`_queue_behind`). */
export const SUBMIT_WAIT_SECONDS = 15;
const MOBILE_PLATFORMS = ["ios", "ipados", "android"];

/** Teams on a phone or a tablet: its own Stop under a reply is greyed out, and its own thumbs never reach the worker. */
export function isMobile(clientPlatform: string): boolean {
  return MOBILE_PLATFORMS.includes(clientPlatform.toLowerCase());
}

/** A review the review service starts as a turn here (its item runs in Claw already; the turn only follows it). */
export interface ReviewTurnStart {
  /** The work item Claw made for it ("" none: the turn makes a session of its own). */
  readonly itemId: string;
  /** The item's session (null: none yet). */
  readonly itemSessionId: string | null;
  /** The pull request, as `owner/repo#N`: a review is kept per pull request when it has no item. */
  readonly pull: string;
  /** The model it runs on ("" the worker's review model). */
  readonly model: string;
  /** Its request's language: a review's own lines follow it. */
  readonly lang: Lang;
  /** The review's own fields of the run. */
  readonly fields: ReviewRunFields & { readonly kind: "review" };
  /** The review's session exists (it is not the chat's: only the review remembers it). */
  onSession(sessionId: string): void;
  /** After the turn, unless it failed. */
  after(outcome: TurnOutcome): Promise<void>;
}

/** A turn that was started: it runs on its own, and `done` settles when it is over (it never rejects). */
export interface RunningTurn {
  readonly done: Promise<void>;
}

export interface StartTurn {
  readonly chat: Chat;
  /** What the turn calls Claw with (for a review: the asker's identity token). */
  readonly credential: string;
  readonly text: string;
  readonly messageId: string;
  readonly clientPlatform: string;
  readonly quote?: string;
  readonly sent?: string;
  readonly files?: readonly InboundFile[];
  readonly review?: ReviewTurnStart;
}

/**
 * Starting and following a turn (the Python `Agent._start_turn`, `_queue_behind`, `_guarded`, `_record_session`,
 * `_record_turn`): a new task is admitted under the person's task limit; a message sent while the chat's turn runs is
 * queued in Claw behind it (one at most); a review has a session of its own and is neither queued nor queued behind.
 */
export class TurnStarter {
  private readonly running = new Set<Promise<void>>();

  constructor(private readonly ctx: RouterContext) {}

  /** The turns that run now (a test waits for them). */
  settled(): Promise<void> {
    return Promise.all([...this.running]).then(() => undefined);
  }

  /** The turn that runs (its end is `done`), or undefined when none was started (the person was told why). */
  async start(request: StartTurn): Promise<RunningTurn | undefined> {
    const { chat, review } = request;
    const key = review
      ? reviewTurnKey(chat.sender.id, chat.scope, review.itemId, review.pull)
      : chatTurnKey(chat.sender.id, chat.scope);
    const turn = new ActiveTurn(review !== undefined, review?.itemId ?? "");
    const admitted = review === undefined && (await this.admit(request, key, turn));
    if (admitted === undefined) return undefined;
    if (!admitted && !(await this.queueBehind(key, turn, chat))) return undefined;
    let run: TurnRun;
    try {
      run = await this.runOf(request);
    } catch (error) {
      this.ctx.turns.drop(key, turn); // (a turn that never started must not hold the chat)
      throw error;
    }
    const task = this.guarded(request, run, key, turn);
    this.running.add(task);
    void task.finally(() => this.running.delete(task));
    return { done: task };
  }

  /** True when admitted as the chat's first turn; false when the chat has one (queue behind it); undefined: refused. */
  private async admit(request: StartTurn, key: TurnKey, turn: ActiveTurn): Promise<boolean | undefined> {
    if (this.ctx.turns.has(key)) return false;
    const { chat } = request;
    return this.ctx.admission.lock.run(chat.sender.id, async () => {
      if (this.ctx.turns.has(key)) return false;
      if (await this.ctx.admission.overLimit(chat, request.messageId, "claw_turn", "", request.credential))
        return undefined;
      this.ctx.turns.claim(key, turn);
      return true;
    });
  }

  /**
   * Registers `turn` behind the chat's running one; false (the person is told why) when it may not go. It is sent only
   * once Claw runs the turn in front: then Claw names that turn as the one it waits behind.
   */
  private async queueBehind(key: TurnKey, turn: ActiveTurn, chat: Chat): Promise<boolean> {
    const queued = this.ctx.turns.enqueue(key, turn);
    const said = routingText.in(chat.lang());
    if (queued === "still_working" || queued === "one_waiting") {
      await chat.say(queued === "still_working" ? said.stillWorking : said.oneWaiting);
      return false;
    }
    if (queued.front === turn) return true;
    if (await queued.front.running.wait(SUBMIT_WAIT_SECONDS * 1000, this.ctx.deps.clock)) return true;
    this.ctx.turns.drop(key, turn);
    await chat.say(routingText.in(chat.lang()).stillWorking);
    return false;
  }

  private async sessionOf(request: StartTurn): Promise<string | null> {
    const { chat, review } = request;
    const { store, config } = this.ctx.deps;
    if (review !== undefined) return review.itemSessionId;
    const sessionId = store.sessions.getSession(chat.sender.id, chat.scope);
    if (sessionId === null) return null;
    if (Boolean(store.sessions.getSessionPlugin(chat.sender.id, chat.scope)) !== Boolean(config.pluginId)) {
      // made before the plugin setting changed, it cannot gain a plugin: this message starts a new one
      await chat.say("Starting a new session so I can use the Primus platform tools.");
      return null;
    }
    // a group's session made before group sessions were created shared would show the requester's memory to the group
    if (chat.scope && !store.sessions.getSessionShared(chat.sender.id, chat.scope)) return null;
    return sessionId;
  }

  private providerOf(request: StartTurn): TurnRun["provider"] {
    const usesExchange = request.review !== undefined || this.ctx.credentials.onExchange; // (a review's token expires too)
    if (!this.ctx.deps.exchange.enabled || !usesExchange) return undefined;
    return () => this.ctx.credentials.fresh(request.chat.sender.id, request.credential);
  }

  private ownThumbs(request: StartTurn): boolean {
    return isMobile(request.clientPlatform) && request.review === undefined && this.ctx.deps.config.ownThumbsMobile;
  }

  /** What the run reads of the chat's session: its id, the model it has, the repository a new one is bound to. */
  private async sessionPart(request: StartTurn): Promise<Pick<TurnRun, "sessionId" | "sessionModel" | "repo">> {
    const { chat, review } = request;
    const { store } = this.ctx.deps;
    const sessionId = await this.sessionOf(request);
    const chosen = sessionId === null && !chat.scope ? store.repoHistory.getPendingRepo(chat.sender.id) : null;
    return {
      sessionId,
      sessionModel: sessionId === null || review ? "" : store.sessions.getSessionModel(chat.sender.id, chat.scope),
      repo: chosen === null ? null : { url: `${REPO_HOST}/${chosen.repo}`, branch: chosen.branch },
    };
  }

  private async runOf(request: StartTurn): Promise<TurnRun> {
    const { chat, review } = request;
    const { store, config, logger } = this.ctx.deps;
    const session = await this.sessionPart(request);
    const group = chat.scope !== "";
    logger.info("turn started from Teams client", {
      platform: request.clientPlatform || "unknown",
      chat: group ? "group" : "1:1",
    });
    return {
      ...session,
      conversation: chat.conversation,
      credential: request.credential,
      provider: this.providerOf(request),
      text: request.text,
      messageId: request.messageId,
      group,
      userId: chat.sender.id,
      ownerName: chat.sender.name,
      model: review ? review.model || config.reviewModel || config.model : config.model,
      fallbackModel: config.fallbackModel,
      showChanges: !group && review === undefined,
      quote: request.quote ?? "",
      sent: request.sent ?? "",
      files: request.files ?? [],
      lang: review?.lang ?? chat.lang(),
      ownThumbs: this.ownThumbs(request),
      notifies: this.ctx.deps.subscriptions !== undefined && store.notifySubs.getNotifySub(chat.sender.id) !== null,
      review: review?.fields,
    };
  }

  private hooks(request: StartTurn, run: TurnRun, turn: ActiveTurn, turnId: string): TurnHooks {
    const { review, chat } = request;
    const store = this.ctx.deps.store;
    return {
      onSession: (sessionId, sessionModel) => {
        if (review) review.onSession(sessionId);
        else this.recordSession(chat, sessionId, run, sessionModel);
      },
      onRunning: () => {
        turn.running.set();
      },
      onTurn: (sessionId, what, messageId) => {
        if (what === "started") store.turns.turnStarted(sessionId, { prompt: run.text, messageId, turnId });
        else if (what === "delivered") store.turns.turnDelivered(sessionId, { messageId, turnId });
        else store.turns.turnNotDelivered(sessionId, turnId);
      },
      stopRequested: () => turn.stopRequested,
      toolDenied: () => turn.toolDenied,
      stopConfirmed: () => turn.stopConfirmed,
      reportView: () => this.ctx.deps.reportView(chat.sender.id, chat.scope),
    };
  }

  private async guarded(request: StartTurn, run: TurnRun, key: TurnKey, turn: ActiveTurn): Promise<void> {
    const turnId = this.ctx.deps.random.hexId(); // (names this turn's record: only this turn's end updates it)
    try {
      const outcome = await this.ctx.deps.turns.run(run, this.hooks(request, run, turn, turnId));
      if (request.review) await request.review.after(outcome);
    } catch (error) {
      const ref = this.ctx.deps.random.hexId().slice(0, 8);
      this.ctx.deps.logger.error("turn failed", { ref, error: errorName(error) });
      await this.tell(request, `Something went wrong on my side (ref ${ref}). Please try again.`);
    } finally {
      this.ctx.turns.drop(key, turn);
    }
  }

  private async tell(request: StartTurn, text: string): Promise<void> {
    try {
      await request.chat.say(text);
      const report = this.ctx.deps.reportView(request.chat.sender.id, request.chat.scope);
      if (report !== undefined) await request.chat.send(report);
    } catch (error) {
      this.ctx.deps.logger.warn("a failed turn could not be said", { error: errorName(error) });
    }
  }

  /**
   * The turn has a session: it is the chat's session, and a 1:1 chat remembers it for /sessions, with what a session
   * this turn created was started with and the repository it is bound to (which uses up the `/repo` choice).
   */
  private recordSession(chat: Chat, sessionId: string, run: TurnRun, sessionModel: string): void {
    const { store, config } = this.ctx.deps;
    const userId = chat.sender.id;
    store.sessions.setSession(
      userId,
      { sessionId, pluginId: config.pluginId, model: sessionModel, shared: chat.scope !== "" },
      chat.scope,
    );
    if (chat.scope) return; // (a group chat has no /sessions and no /repo)
    const created = run.sessionId !== sessionId;
    if (created && run.sessionId) store.repoHistory.forgetSession(userId, run.sessionId);
    const url = run.repo?.url ?? "";
    const bound = created && run.repo ? (url.startsWith(`${REPO_HOST}/`) ? url.slice(REPO_HOST.length + 1) : url) : "";
    store.repoHistory.noteSession(userId, sessionId, {
      title: created ? cpHead(squashSpaces(run.text), 50) : "",
      repo: bound,
      branch: bound && run.repo ? run.repo.branch : "",
    });
    if (created && run.repo) store.repoHistory.clearPendingRepo(userId);
  }
}
