// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The features behind the router, built and wired as the Python worker's `main.build_agent`, `Agent.__init__` and
 * `main.build_worker_app` wire them: the router with every feature it hands messages to, what carries Claw's events into the
 * chat (`/claw-events`), the background loops of `main.run`, what runs once at start, and what the release gate's test entry
 * reads. The review service is not wired yet: a configuration that turns it on stops the start (`refuseMissing`).
 */
import type {
  ClawPort,
  ClawSessionsPort,
  JsonObject,
  RouteHandlers,
  RouterDeps,
  UserRef,
  VoteRoute,
} from "@primusclaw/personal-agent";
import {
  BOT_NAME,
  chatTurnKey,
  Guardrails,
  noIntegrations,
  PublicErrorLog,
  Router,
  reviewStop,
  UPGRADE_RETRY_SECONDS,
  noModelRefusalPolicy,
} from "@primusclaw/personal-agent";

import type { GateSubscriptions } from "../gate/routes.js";
import { StartupError } from "./outbound.js";
import { assistantParts, type AssistantParts } from "./features-assistant.js";
import type { AssemblyBase, RouterHooks } from "./features-base.js";
import { proactiveHold, proactiveParts, followReach, refOf, type ProactiveParts } from "./features-proactive.js";
import { remoteAgents } from "./features-remote.js";
import { featureSwitches, type FeatureSwitches } from "./features-switches.js";
import { channelContextBuilder, messageText, noteFactory, routerLimits, whoamiConnections } from "./features-text.js";
import { approvalClicks, stopCards, turnRunner } from "./features-turns.js";
import { w8Parts, type W8Parts } from "./features-w8.js";

export type { AssemblyBase } from "./features-base.js";

/** The background loops' period (Python `main.SWEEP_SECONDS`). */
export const SWEEP_MS = 60_000;
/** Claw's event type that asks the chat to carry out a command (Python `claw.ASSISTANT_ACTION`). */
export const ASSISTANT_ACTION = "assistant.action";

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

/** The route the Python worker serves for TEAMS_ON_BEHALF_USERS (link_api.py); a deployment's plugin adds it here. */
export const ON_BEHALF_PATH = "/primus-claw-agent/on-behalf";

/**
 * A setting that turns on something this worker would not do stops the start: production runs it, so a worker that
 * quietly ran without it would be a different worker.
 * - TEAMS_GITHUB_REVIEW_ENABLED: the review service comes next.
 * - CLAWY_FALLBACK_MODEL with no model refusal policy: the fallback would never be used.
 * - TEAMS_ON_BEHALF_USERS with no plugin serving the on-behalf route: the route would not exist.
 */
function refuseMissing(base: AssemblyBase): void {
  const { settings, plugins } = base;
  if (settings.githubReview.enabled)
    throw new StartupError(
      "TEAMS_GITHUB_REVIEW_ENABLED is set, but this worker does not run the review service yet: unset it or run the Python worker",
    );
  if (settings.models.fallback !== "" && plugins.modelRefusalPolicy === noModelRefusalPolicy)
    throw new StartupError(
      "CLAWY_FALLBACK_MODEL is set, but no plugin says when a model refused (modelRefusalPolicy): the fallback would never be used",
    );
  if (settings.onBehalfUsers.size > 0 && !plugins.routeExtensions.some((route) => route.path === ON_BEHALF_PATH))
    throw new StartupError(
      `TEAMS_ON_BEHALF_USERS is set, but no plugin serves ${ON_BEHALF_PATH}: unset it or run with the plugin that does`,
    );
}

/** The router's hooks, bound once the router is built. */
function lateHooks(get: () => Router): RouterHooks {
  return {
    legacyTurn: (userId) => get().hasPersonalTurn(userId),
    itemStopped: (itemId) => {
      get().ctx.itemStopped(itemId);
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
  };
}

interface Built {
  readonly switches: FeatureSwitches;
  readonly assistant: AssistantParts;
  readonly proactive: ProactiveParts;
  readonly remote: ReturnType<typeof remoteAgents>;
  readonly w8: W8Parts;
  readonly handlers: RouteHandlers & { readonly groupInterceptors: RouteHandlers["groupInterceptors"][number][] };
}

function routerDeps(base: AssemblyBase, built: Built, errors: PublicErrorLog): RouterDeps {
  const { settings, store, clock, plugins, securityLog, teams } = base;
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
      ownThumbsMobile: teams.style.ownThumbsMobile,
    },
    surface: base.surface,
    channel: { refOf: (stored) => refOf(stored) },
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
    turns: turnRunner(base, { style: teams.style, errors, integrations: noIntegrations }),
    stopCards: stopCards(base),
    proactive: proactiveHold(proactive),
    observing: w8.observer,
    github: undefined, // (GITHUB_REVIEW off)
    reviewStop: (text) => reviewStop(text),
    handoffs: [], // (`review_for_other` only with the review service)
    channelContext: channelContextBuilder(store),
    messageText,
    connectionsText: whoamiConnections(noIntegrations),
    reportView: (userId, scope) => w8.reportView(userId, scope),
    note: noteFactory,
    subscriptions:
      subs === undefined ? undefined : { ensure: (u) => subs.ensure(u), remove: (u, key) => subs.remove(u, key) },
    handlers: built.handlers,
    integrations: noIntegrations,
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
  return timers;
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
    const conversation = surface.conversation(refOf(reference));
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
  const { settings, clock, securityLog, teams } = base;
  const late: { router?: Router } = {};
  const get = (): Router => {
    if (late.router === undefined) throw new Error("a feature called the router before it was built");
    return late.router;
  };
  const hooks = lateHooks(get);
  const errors = new PublicErrorLog(base.logger, base.random);
  const guard = new Guardrails(clock, (event, fields) => securityLog.event(event, fields), settings.sensitiveLimits);
  const assistant = assistantParts(base, {
    style: teams.style,
    integrations: noIntegrations,
    notifyUrl: switches.notifyUrl,
    hooks,
  });
  const proactive = proactiveParts(base, teams.style, assistant, errors);
  const reach = followReach(proactive, base);
  const remote = remoteAgents(base, { switches, guard, reach, errors, directChat: assistant.directChat, hooks });
  const w8 = w8Parts(base, { briefEnabled: switches.brief, assistantOn: (userId) => assistant.chat.on(userId) });
  // (in a group, Python reads `/observe` first, then the feedback answer, then the review-stop words, then review requests)
  const groupInterceptors: RouteHandlers["groupInterceptors"][number][] = [
    w8.observer.interceptor,
    w8.flow.interceptor,
  ];
  const handlers = {
    personalInterceptors: [w8.flow.interceptor],
    groupInterceptors,
    commands: [w8.brief],
    clicks: [
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
  const parts: Built = { switches, assistant, proactive, remote, w8, handlers };
  const router = new Router(routerDeps(base, parts, errors));
  late.router = router;
  // (after feedback: the review-stop words; review requests would follow, with the review service)
  groupInterceptors.push(router.group.reviewStopInterceptor());
  return {
    router,
    deliverEvent: deliverer(base, parts, get),
    timers: featureTimers(base, parts),
    start: () => {
      remote.resume(); // (chats attached to a remote agent are followed again from where they were)
      return Promise.resolve();
    },
    gate: gateOf(parts, base, made),
  };
}
