// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import { errorName } from "../errors.js";
import { chosenLang } from "../language/chosen.js";
import type { Lang } from "../locales/lang.js";
import type { Logger } from "../ports/logger.js";
import type { InboundFile } from "../ports/surface.js";
import { REPO_HOST } from "../commands/repo.js";
import { routingText } from "../locales/routing.js";
import { cpHead, squashSpaces } from "../text/py-text.js";
import type { Chat } from "./chat.js";
import type { RouterContext } from "./context.js";
import { answerWaitingQuestion } from "./question-reply.js";
import { ActiveTurn, chatTurnKey, QUEUED_TURNS_MAX, reviewTurnKey, type TurnKey } from "./turn-registry.js";
import type { ReviewRunFields, TurnHooks, TurnOutcome, TurnRun } from "./turn-runner.js";

const MOBILE_PLATFORMS = ["ios", "ipados", "android"];

/** Teams on a phone or a tablet: its own Stop under a reply is greyed out, and its own thumbs never reach the worker. */
export function isMobile(clientPlatform: string): boolean {
  return MOBILE_PLATFORMS.includes(clientPlatform.toLowerCase());
}

/**
 * The path a message from Teams took: to the person's assistant, to a plain Claw session of their own (the old path, neither
 * the assistant's nor a work item's), or to a review's turn. Logged so the worker's lines can be counted per path.
 */
export type TurnRoute = "assistant" | "legacy" | "review";

/**
 * The line for a turn started from Teams: where it came from and which path it took, never its words or any id. One line
 * per turn: a message to the assistant or to a plain session is one turn, and a review request for several pull requests
 * starts one review turn (and one line) for each.
 */
export function logTurnStarted(logger: Logger, clientPlatform: string, group: boolean, route: TurnRoute): void {
  logger.info("turn started from Teams client", {
    platform: clientPlatform || "unknown",
    chat: group ? "group" : "1:1",
    route,
  });
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
  /**
   * The person typed it in the chat (not a button, not a review): while the agent waits on a question card in this chat's
   * session, it is the answer to that question and starts no turn.
   */
  readonly typed?: boolean;
}

/**
 * Starting and following a turn (the Python `Agent._start_turn`, `_queue_behind`, `_guarded`, `_record_session`,
 * `_record_turn`): a new task is admitted under the person's task limit; a message sent while the chat's turn runs is
 * queued behind it (up to `QUEUED_TURNS_MAX`, in order, each told its place) and goes to Claw once every turn in front of it
 * is over, so `/stop` can still give it up; a review has a session of its own and is neither queued nor queued behind.
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
    if (await this.answersQuestion(request)) return undefined;
    const key = review
      ? reviewTurnKey(chat.sender.id, chat.scope, review.itemId, review.pull)
      : chatTurnKey(chat.sender.id, chat.scope);
    const turn = new ActiveTurn(review !== undefined, review?.itemId ?? "");
    const admitted = review === undefined && (await this.admit(request, key, turn));
    if (admitted === undefined) return undefined;
    if (!admitted) {
      const queued = await this.queueBehind(key, turn, chat);
      if (queued === "refused") return undefined;
      if (queued === "waiting") return this.track(this.afterFront(request, key, turn));
    }
    return this.launch(request, key, turn);
  }

  /** A typed message the waiting question card of the chat's session took as its answer (`question-reply.ts`). */
  private async answersQuestion(request: StartTurn): Promise<boolean> {
    if (!request.typed || request.review !== undefined || (request.files?.length ?? 0) > 0) return false;
    const provider = this.providerOf(request);
    return answerWaitingQuestion(this.ctx, {
      chat: request.chat,
      text: request.text,
      credential: provider ?? (() => Promise.resolve(request.credential)),
    });
  }

  private track(task: Promise<void>): RunningTurn {
    this.running.add(task);
    void task.finally(() => this.running.delete(task));
    return { done: task };
  }

  /** The turn goes to Claw now; its end is `done`. */
  private async launch(request: StartTurn, key: TurnKey, turn: ActiveTurn): Promise<RunningTurn> {
    turn.launched = true;
    let run: TurnRun;
    try {
      run = await this.runOf(request);
    } catch (error) {
      this.ctx.turns.drop(key, turn); // (a turn that never started must not hold the chat)
      throw error;
    }
    return this.track(this.guarded(request, run, key, turn));
  }

  /**
   * A queued turn: it goes once every turn in front of it is over, or stopped (Claw took its interrupt: Claw is free for the next
   * message, whether or not that turn ever reports its end); the caller does not wait for it. Not at all when it was given up
   * meanwhile (`/stop`, said there).
   */
  private async afterFront(request: StartTurn, key: TurnKey, turn: ActiveTurn): Promise<void> {
    for (;;) {
      if (turn.over) return;
      const turns = this.ctx.turns.of(key);
      const at = turns.indexOf(turn);
      if (at < 0) return;
      const blocking = turns.slice(0, at).find((front) => !front.stopped.isSet);
      if (blocking === undefined) break;
      await Promise.race([blocking.ended.whenSet(), blocking.stopped.whenSet(), turn.ended.whenSet()]);
    }
    let started: RunningTurn;
    try {
      started = await this.launch(request, key, turn);
    } catch (error) {
      const ref = this.ctx.deps.random.hexId().slice(0, 8);
      this.ctx.deps.logger.error("a queued turn could not start", { ref, error: errorName(error) });
      await this.tell(request, `Something went wrong on my side (ref ${ref}). Please try again.`);
      return;
    }
    await started.done;
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
   * Registers `turn` behind the chat's running one: "front" when the chat has none after all (it runs now), "waiting" when it
   * is queued (the person is told its place), "refused" (and told why) when it may not wait.
   */
  private async queueBehind(key: TurnKey, turn: ActiveTurn, chat: Chat): Promise<"front" | "waiting" | "refused"> {
    const queued = this.ctx.turns.enqueue(key, turn);
    const said = routingText.in(chat.lang());
    if (queued === "still_working" || queued === "queue_full") {
      await chat.say(queued === "still_working" ? said.stillWorking : said.queueFull({ n: QUEUED_TURNS_MAX }));
      return "refused";
    }
    if (queued.front === turn) return "front";
    // (behind turns that are all stopped it goes at once: nothing to tell)
    const stoppedInFront = this.ctx.turns.of(key).every((front) => front === turn || front.stopped.isSet);
    if (stoppedInFront) return "waiting";
    try {
      await chat.say(said.queuedBehind({ n: queued.waiting }));
    } catch (error) {
      this.ctx.turns.drop(key, turn); // (not told it is queued: it does not run unannounced)
      throw error;
    }
    return "waiting";
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
    logTurnStarted(logger, request.clientPlatform, group, review ? "review" : "legacy");
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
      ...this.replyLang(request),
      ownThumbs: this.ownThumbs(request),
      notifies: this.ctx.deps.subscriptions !== undefined && store.notifySubs.getNotifySub(chat.sender.id) !== null,
      review: review?.fields,
    };
  }

  /** The language the sender chose to be answered in, for a chat turn (a review's answer follows its request's language). */
  private replyLang(request: StartTurn): { replyLang?: Lang } {
    if (request.review !== undefined) return {};
    const lang = chosenLang(this.ctx.deps.store.prefs.getPrefs(request.chat.sender.id));
    return lang === undefined ? {} : { replyLang: lang };
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
