// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The features behind the router, built and wired as the Python worker's `main.build_agent`, `Agent.__init__` and
 * `main.build_worker_app` wire them: the router with every feature it hands messages to, what carries Claw's events into the
 * chat (`/claw-events`), the background loops of `main.run`, what runs once at start, and what the release gate's test entry
 * reads. The review service (PA_GITHUB_REVIEW_ENABLED) is built in `features-review.ts`.
 */
import type {
  ClawPort,
  ClawSessionsPort,
  GroupContext,
  JsonObject,
  GithubConfirmation,
  GithubReview,
  HeldConfirmation,
  ReviewHandoffAction,
  RouteHandlers,
  RouterDeps,
  UserRef,
  VoteRoute,
} from "@primusclaw/personal-agent";
import {
  BOT_NAME,
  chatTurnKey,
  contextInterceptor,
  Guardrails,
  PublicErrorLog,
  Router,
  reviewStop,
  REVIEW_HANDOFF,
  pendingOf,
  UPGRADE_RETRY_SECONDS,
  noModelRefusalPolicy,
  TerminalApprovalsCommand,
} from "@primusclaw/personal-agent";

import { settingSource } from "@primusclaw/personal-agent-runtime";

import { StartupError } from "./startup-error.js";
import { assistantParts, type AssistantParts } from "./features-assistant.js";
import type { AssemblyBase, RouterHooks } from "./features-base.js";
import { proactiveHold, proactiveParts, followReach, type ProactiveParts } from "./features-proactive.js";
import { remoteAgents } from "./features-remote.js";
import { REVIEW_CARD_SWEEP_MS, reviewParts, type ReviewParts } from "./features-review.js";
import { featureSwitches, type FeatureSwitches } from "./features-switches.js";
import {
  channelContextBuilder,
  messageTextFor,
  noteFactory,
  routerLimits,
  whoamiConnections,
} from "./features-text.js";
import { approvalClicks, stopCards, turnRunner } from "./features-turns.js";
import { w8Parts, type W8Parts } from "./features-w8.js";

export type { AssemblyBase, ReplyStyle, SurfaceShape } from "./features-base.js";

/** The background loops' period (Python `main.SWEEP_SECONDS`). */
export const SWEEP_MS = 60_000;
/** Claw's event type that asks the chat to carry out a command (Python `claw.ASSISTANT_ACTION`). */
export const ASSISTANT_ACTION = "assistant.action";

/** The person's notification subscription, as the assistant feature keeps it (what a surface's test entry reads). */
export interface GateSubscriptions {
  ensure(userId: string): Promise<void>;
  remove(userId: string): Promise<void>;
  /** Whether the subscription carries the assistant's event types. */
  hasAssistantTypes(userId: string): boolean;
}

export interface FeatureTimer {
  readonly name: string;
  readonly everyMs: number;
  readonly runAtStart: boolean;
  run(): Promise<void>;
}

export interface Features {
  readonly router: Router;
  /** `/claw-events`: an `assistant.action` is carried out as the person (`Agent.run_action`), anything else is shown. */
  readonly deliverEvent: (userId: string, reference: JsonObject, event: JsonObject) => Promise<string>;
  /** The loops of `main.run`: name, period, whether the first run is at start, one run. */
  readonly timers: readonly FeatureTimer[];
  /** Once the worker runs: chats attached to a remote agent are followed again (`Agent.resume_remote`). */
  start(): Promise<void>;
  /** The worker stops: the assistant's open receipts are dropped, so their close timers do not keep the process up. */
  stop(): void;
  /** The review service (PA_GITHUB_REVIEW_ENABLED; undefined off), for the gate's review scenarios and the tests. */
  readonly review: GithubReview | undefined;
  /** The recent messages of group chats (kept in memory): the inbound handler drops a chat the bot was removed from. */
  readonly groupContext: GroupContext;
  /** What the release gate's test entry reads: the subscriptions, and the Claw sessions this worker made. */
  readonly gate: {
    readonly subscriptions: GateSubscriptions | undefined;
    readonly madeSessions: () => readonly string[];
  };
}

/** `claw` with every session it creates recorded (the gate deletes them at the end of a run). */
function recordingClaw(claw: ClawPort, made: string[]): ClawPort {
  const create: ClawSessionsPort["create"] = async (key, session) => {
    const created = await claw.sessions.create(key, session);
    made.push(created.sessionId);
    return created;
  };
  const sessions = new Proxy(claw.sessions, {
    get(target, prop) {
      if (prop === "create") return create;
      const value: unknown = Reflect.get(target, prop, target);
      return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(target) : value;
    },
  });
  return new Proxy(claw, {
    get(target, prop) {
      return prop === "sessions" ? sessions : (Reflect.get(target, prop, target) as unknown);
    },
  });
}

/** The route the Python worker serves for PA_ON_BEHALF_USERS (link_api.py); a deployment's plugin adds it here. */
export const ON_BEHALF_PATH = "/primus-claw-agent/on-behalf";

/**
 * A setting that turns on something this worker would not do stops the start: production runs it, so a worker that
 * quietly ran without it would be a different worker.
 * - CLAWY_FALLBACK_MODEL with no model refusal policy: the fallback would never be used.
 * - PA_ON_BEHALF_USERS with no plugin serving the on-behalf route: the route would not exist.
 */
function refuseMissing(base: AssemblyBase): void {
  const { settings, plugins } = base;
  if (settings.models.fallback !== "" && plugins.modelRefusalPolicy === noModelRefusalPolicy)
    throw new StartupError(
      "CLAWY_FALLBACK_MODEL is set, but no plugin says when a model refused (modelRefusalPolicy): the fallback would never be used",
    );
  if (
    settings.onBehalfUsers.size > 0 &&
    !plugins.routeExtensions.some((route) => route.method === "POST" && route.path === ON_BEHALF_PATH)
  )
    throw new StartupError(
      `${settingSource(base.env, "PA_ON_BEHALF_USERS")} is set, but no plugin serves ${ON_BEHALF_PATH}: unset it or run with the plugin that does`,
    );
}

/**
 * The review service hears of every stopped item through the router (a Stop on its card, a group's "停 N"), once each:
 * Python `Agent._item_stopped` tells it and the router's turns together.
 */
function listenForStops(router: Router, service: GithubReview): void {
  router.ctx.onItemStopped((itemId) => {
    service.itemStopped(itemId);
  });
}

/** A held confirmation as the channel context reads it (the store row under Python's column names). */
function held(c: GithubConfirmation): HeldConfirmation {
  return { confirmation_id: c.confirmationId, repo: c.repo, pr: c.pr, kind: c.kind, expires_at: c.expiresAt };
}

/** The router's hooks, bound once the router is built. */
function lateHooks(get: () => Router): RouterHooks {
  return {
    legacyTurn: (userId) => get().hasPersonalTurn(userId),
    itemStopped: (itemId) => {
      get().itemStopped(itemId); // (the review service hears of it too: it listens on the router, `listenForStops`)
    },
    toolDenied: (userId, scope) => {
      const running = get().ctx.turns.of(chatTurnKey(userId, scope))[0];
      if (running !== undefined) running.toolDenied = true; // (the turn's answer then comes with Report a problem)
    },
    runCommand: (text, sender, conversation, key) => {
      const router = get();
      return router.commands.run(text, router.chat(sender, conversation), key);
    },
    background: (userId) => get().ctx.credentials.background(userId),
    typed: (message) => get().handle(message),
  };
}

interface Built {
  readonly switches: FeatureSwitches;
  readonly assistant: AssistantParts;
  readonly proactive: ProactiveParts;
  readonly remote: ReturnType<typeof remoteAgents>;
  readonly w8: W8Parts;
  readonly review: ReviewParts | undefined;
  readonly handlers: RouteHandlers & { readonly groupInterceptors: RouteHandlers["groupInterceptors"][number][] };
}

function routerDeps(base: AssemblyBase, built: Built, errors: PublicErrorLog): RouterDeps {
  const { settings, store, clock, plugins, securityLog, shape } = base;
  const { switches, assistant, proactive, remote, w8 } = built;
  const subs = assistant.subs;
  return {
    config: {
      publicBaseUrl: settings.publicBaseUrl,
      botName: BOT_NAME,
      pluginId: settings.claw.pluginId === null ? "" : String(settings.claw.pluginId),
      model: settings.models.chat,
      reviewModel: settings.models.review,
      fallbackModel: settings.models.fallback,
      exchangeForChat: settings.exchange.forChat,
      briefEnabled: switches.brief,
      schedulesEnabled: switches.schedules,
      jobWatchEnabled: switches.jobWatch,
      ownThumbsMobile: shape.style.ownThumbsMobile,
    },
    surface: base.surface,
    channel: { refOf: (stored) => shape.refOf(stored) },
    store,
    claw: base.claw,
    clock,
    random: base.random,
    logger: base.logger,
    metrics: base.metrics,
    securityEvent: (name, fields) => {
      securityLog.event(name, fields);
    },
    requestScope: base.requestScope,
    identity: plugins.identityLookup,
    keyRevoker: plugins.keyRevoker,
    exchange: base.exchange,
    limits: routerLimits(settings.userLimits, clock),
    assistant: assistant.chat,
    remote,
    turns: turnRunner(base, { style: shape.style, errors, integrations: plugins.integrations }),
    stopCards: stopCards(base),
    proactive: proactiveHold(proactive),
    observing: w8.observer,
    groupHistory: w8.groupContext,
    github: built.review?.service,
    reviewStop: (text) => reviewStop(text),
    handoffs: built.review === undefined ? [] : [REVIEW_HANDOFF], // (`review_for_other` only with the review service)
    // (Python: `pending_of(store.pending_github_confirmations(...))` with the review service, else none)
    channelContext: channelContextBuilder(store, (userId) =>
      built.review === undefined
        ? []
        : pendingOf(store.githubConfirmations.pendingGithubConfirmations(userId).map(held)),
    ),
    messageText: messageTextFor(shape.channelName),
    connectionsText: whoamiConnections(plugins.integrations),
    reportView: (userId, scope) => w8.reportView(userId, scope),
    note: noteFactory,
    subscriptions:
      subs === undefined
        ? undefined
        : { ensure: (u, credential) => subs.ensure(u, credential), remove: (u, key) => subs.remove(u, key) },
    handlers: built.handlers,
    integrations: plugins.integrations,
  };
}

function featureTimers(base: AssemblyBase, built: Built): FeatureTimer[] {
  const { store, plugins } = base;
  const { release } = built.proactive;
  const subs = built.assistant.subs;
  const timers: FeatureTimer[] = [
    {
      name: "sweep_expired", // (pending keys nobody redeemed are deleted and revoked)
      everyMs: SWEEP_MS,
      runAtStart: false,
      run: async () => {
        for (const key of store.links.takeExpiredPending()) await plugins.keyRevoker.revoke(key);
      },
    },
    {
      name: "retry_feedback", // (reports that could not be filed are filed once they can be)
      everyMs: SWEEP_MS,
      runAtStart: false,
      run: async () => {
        await built.w8.service.delivery.replayPending();
      },
    },
    { name: "release_held", everyMs: SWEEP_MS, runAtStart: false, run: () => release.releaseDue() },
    {
      name: "sweep_group_context", // (a quiet group's recent messages are dropped once they are too old)
      everyMs: SWEEP_MS,
      runAtStart: false,
      run: () => {
        built.w8.groupContext.sweep();
        return Promise.resolve();
      },
    },
    {
      name: "resend_approval_cards",
      everyMs: SWEEP_MS,
      runAtStart: true,
      run: async () => {
        await release.resendUnsentApprovals();
      },
    },
  ];
  if (subs !== undefined) {
    timers.push({
      name: "mend_subscriptions",
      everyMs: UPGRADE_RETRY_SECONDS * 1000,
      runAtStart: true,
      run: async () => {
        await subs.ensureAll();
      },
    });
  }
  const review = built.review?.service;
  if (review !== undefined) {
    timers.push({
      name: "sweep_review_cards", // (open review cards whose item is over show how it ended; first at start)
      everyMs: REVIEW_CARD_SWEEP_MS,
      runAtStart: true,
      run: () => sweepOnce(review),
    });
  }
  return timers;
}

/** One pass of `GithubReview.sweepCards` (its own loop, stopped after its first check: the timer is the loop here). */
async function sweepOnce(review: GithubReview): Promise<void> {
  const once = new AbortController();
  const swept = review.sweepCards(once.signal);
  once.abort(); // (the check already started; the sleep that follows returns at once)
  await swept;
}

function deliverer(base: AssemblyBase, built: Built, get: () => Router): Features["deliverEvent"] {
  const { store, surface } = base;
  return async (userId, reference, event) => {
    if (event["type"] !== ASSISTANT_ACTION) return built.proactive.proactive.handle(userId, reference, event);
    const sender: UserRef = {
      id: userId,
      name: store.members.memberName(userId) ?? "",
      email: "",
      channelUserId: store.members.channelIdOf(userId) ?? "",
    };
    const router = get();
    const conversation = surface.conversation(base.shape.refOf(reference));
    return built.assistant.actions.runAction(userId, event, (text) =>
      router.runCommand(text, router.chat(sender, conversation)),
    );
  };
}

function gateOf(built: Built, base: AssemblyBase, made: readonly string[]): Features["gate"] {
  const subs = built.assistant.subs;
  const subscriptions: GateSubscriptions | undefined =
    subs === undefined
      ? undefined
      : {
          ensure: (userId) => subs.ensure(userId),
          remove: (userId) => subs.remove(userId, base.store.links.getKey(userId)),
          hasAssistantTypes: (userId) => subs.hasAssistantTypes(userId),
        };
  return { subscriptions, madeSessions: () => [...made] };
}

export function buildFeatures(given: AssemblyBase): Features {
  const switches = featureSwitches(given.env);
  refuseMissing(given);
  const made: string[] = [];
  const base: AssemblyBase = { ...given, claw: recordingClaw(given.claw, made) };
  const { settings, clock, securityLog, shape } = base;
  const late: { router?: Router } = {};
  const get = (): Router => {
    if (late.router === undefined) throw new Error("a feature called the router before it was built");
    return late.router;
  };
  const hooks = lateHooks(get);
  const lateReview: { handoff?: ReviewHandoffAction | undefined } = {};
  const errors = new PublicErrorLog(base.logger, base.random);
  const guard = new Guardrails(clock, (event, fields) => securityLog.event(event, fields), settings.sensitiveLimits);
  const assistant = assistantParts(base, {
    style: shape.style,
    integrations: base.plugins.integrations,
    notifyUrl: switches.notifyUrl,
    hooks,
    reviewHandoff: (userId, event) => lateReview.handoff?.take(userId, event) ?? "dropped",
  });
  const proactive = proactiveParts(base, shape.style, assistant, errors, get);
  const reach = followReach(proactive, base);
  const remote = remoteAgents(base, { switches, guard, reach, errors, directChat: assistant.directChat, hooks });
  const w8 = w8Parts(base, { briefEnabled: switches.brief, assistantOn: (userId) => assistant.chat.on(userId) });
  const review = reviewParts(base, { guard, errors, router: get, subs: assistant.subs }, assistant);
  lateReview.handoff = review?.handoff;
  const reviewHandlers = review?.service.routeHandlers();
  // (in a group, Python reads `/observe` first, then the feedback answer, then the review-stop words, then review requests)
  const groupInterceptors: RouteHandlers["groupInterceptors"][number][] = [
    contextInterceptor(w8.groupContext),
    w8.observer.interceptor,
    w8.flow.interceptor,
  ];
  const handlers = {
    // (1:1: the review's typed answers, mode words and requests come before the feedback answer, as in Python)
    personalInterceptors: [...(reviewHandlers?.personalInterceptors ?? []), w8.flow.interceptor],
    groupInterceptors,
    commands: [
      ...w8.commands,
      ...(switches.remoteAgents ? [new TerminalApprovalsCommand(base.claw.remoteAgents)] : []),
      ...(reviewHandlers?.commands ?? []),
    ],
    clicks: [
      ...(reviewHandlers?.clicks ?? []),
      ...assistant.clicks,
      approvalClicks(base, guard, hooks),
      remote.clickHandler,
      w8.flow.clicks,
      w8.thumbs.clicks,
      w8.observer.clicks,
    ],
    votes: {
      vote: (route: VoteRoute) => {
        w8.thumbs.onVote(route, route.vote); // (the vote and a thumbs-down's report run in the background)
        return Promise.resolve();
      },
    },
  };
  const parts: Built = { switches, assistant, proactive, remote, w8, review, handlers };
  const router = new Router(routerDeps(base, parts, errors));
  late.router = router;
  // (after feedback: the review-stop words, then review requests)
  groupInterceptors.push(router.group.reviewStopInterceptor(), ...(reviewHandlers?.groupInterceptors ?? []));
  if (review !== undefined) listenForStops(router, review.service);
  return {
    router,
    deliverEvent: deliverer(base, parts, get),
    timers: featureTimers(base, parts),
    start: () => {
      remote.resume(); // (chats attached to a remote agent are followed again from where they were)
      review?.service.resume(); // (reviews someone asked of a colleague: their asker hears the outcome again)
      return Promise.resolve();
    },
    stop: () => {
      assistant.receipts.stop();
    },
    gate: gateOf(parts, base, made),
    review: review?.service,
    groupContext: w8.groupContext,
  };
}
