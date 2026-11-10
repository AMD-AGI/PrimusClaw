// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The review delegation (TEAMS_GITHUB_REVIEW_ENABLED), as the Python worker's `main.run` builds `GithubReview` and
 * `Agent.__init__` attaches it: the identity service's GitHub credentials, the device flow `/github` connects with, the
 * public pull request reader, the request reader on the platform's model gateway (TEAMS_REVIEW_INTENT_MODEL), and the chat
 * it runs in (its turns start on the router, its onboarding and connect cards are the router's). What it gives back: the
 * router's GitHub part, its handlers, the handoff the assistant can send back, the follows it takes up again at start, the
 * open review cards it sweeps, and the stopped items it hears of.
 */
import {
  GithubReview,
  itemLabel,
  pickLang,
  redactText,
  ReviewHandoffAction,
  routedReviewTurns,
  type ConversationRef,
  type Guardrails,
  type JsonObject,
  type PostWorkCard,
  type PublicErrors,
  type ReviewDeps,
  type ReviewHost,
  type Router,
  type SecurityEventName,
  type SubscriptionKeeper,
} from "@primusclaw/personal-agent";
import {
  GatewayIntentReader,
  GithubApi,
  GithubDeviceFlow,
  IdentityCredentialClient,
  PublicPullReader,
} from "@primusclaw/personal-agent-runtime";

import { restoreConversationRef } from "../activity/reference.js";
import type { AssistantParts } from "./features-assistant.js";
import type { AssemblyBase } from "./features-base.js";

/** How often open review cards are checked for an item that is over (Python `CARD_SWEEP_SECONDS`, core `CARD_SWEEP_MS`). */
export const REVIEW_CARD_SWEEP_MS = 120_000;

export interface ReviewInputs {
  readonly guard: Pick<Guardrails, "take" | "giveBack">;
  readonly errors: PublicErrors;
  /** The router, once it is built (the service starts its turns there). */
  readonly router: () => Router;
  readonly subs: SubscriptionKeeper | undefined;
}

/**
 * A work item's card in the reviewer's chat when a review waits for them (Python `_tell_reviewer_waiting`: `work_card`,
 * then the card is placed so it is ended with its item).
 */
export function workCardPoster(base: Pick<AssemblyBase, "store">): PostWorkCard {
  const cards = base.store.assistantCards;
  return async (conversation, owner, item, text) => {
    const cardId = cards.addAssistantCard(owner, item.itemId, item.resultVersion, item.canAccept);
    const watching = cards.autoReply(owner, item.itemId) !== null;
    // (Python `work_card(item, text, card_id)`: no language given, so that of what is said or the item's title)
    const model = { item, text, cardId, note: "", watch: false, watching, lang: pickLang(text, item.title) };
    const messageId = await conversation.post({
      body: { type: "view", view: { name: "workCard", model }, fallbackText: "" },
    });
    if (messageId)
      cards.placeAssistantCard(cardId, {
        activityId: messageId,
        reference: conversation.ref.wire as JsonObject,
        render: { kind: "work", title: itemLabel(item), lang: "zh" },
      });
  };
}

export interface ReviewParts {
  readonly service: GithubReview;
  readonly handoff: ReviewHandoffAction;
}

/** The channel's fields a followed review keeps to open the reviewer's chat again (Python: service_url, tenant, bot_id). */
function followWire(asked: ConversationRef): Readonly<Record<string, string>> {
  const wire = asked.wire as JsonObject;
  const bot = wire["bot"];
  const botId = typeof bot === "object" && bot !== null && !Array.isArray(bot) ? (bot as JsonObject)["id"] : undefined;
  const serviceUrl = wire["serviceUrl"];
  return {
    service_url: typeof serviceUrl === "string" ? serviceUrl : "",
    tenant: asked.tenantId,
    bot_id: typeof botId === "string" ? botId : "",
  };
}

/** The chat the service runs in: the router's turns, onboarding, link steps and binding card (Python `Host`). */
function reviewHost(base: AssemblyBase, inputs: ReviewInputs, afterTurn: () => GithubReview): ReviewHost {
  const { router, subs } = inputs;
  const chatOf = (sender: Parameters<Router["chat"]>[0], conversation: Parameters<Router["chat"]>[1], scope = "") =>
    router().chat(sender, conversation, scope);
  const host: ReviewHost = {
    startTurn: routedReviewTurns(
      (request) => router().startTurn(request),
      (request) => chatOf(request.sender, request.conversation, request.scope),
      base.store,
      (review, finalAnswer, outcome, asked) => afterTurn().afterTurn(review, finalAnswer, outcome, asked),
    ),
    onboard: (message, sender, conversation, scope) =>
      router().onboarding.member(message, chatOf(sender, conversation, scope), {
        text: message.text,
        quote: "",
        sent: "",
        keep: false,
        identity: true,
      }),
    askLink: (person, conversation, lead) => router().ctx.credentials.askToLink(chatOf(person, conversation), lead),
    connectIdentity: (person, conversation, lead) =>
      router().ctx.credentials.connectIdentity(chatOf(person, conversation), lead),
    admitReviews: (message, sender, count, modelKey) =>
      router().admitReviews(
        chatOf(sender, base.surface.conversation(message.conversation)),
        message.id,
        count,
        modelKey,
      ),
  };
  return subs === undefined ? host : { ...host, reviewerReach: (userId) => subs.reachable(userId) };
}

function reviewDeps(base: AssemblyBase, inputs: ReviewInputs, host: ReviewHost): ReviewDeps {
  const { settings, teams, clock, logger, securityLog } = base;
  const review = settings.githubReview;
  const fetch = (url: string, init?: RequestInit) => base.fetch(url, init);
  return {
    store: base.store,
    claw: base.claw,
    credentials: new IdentityCredentialClient({
      baseUrl: review.credentialUrl,
      clientId: settings.exchange.clientId,
      clientSecret: settings.exchange.clientSecret,
      issuer: settings.exchange.issuer,
      fetch,
    }),
    device: new GithubDeviceFlow({ clientId: review.clientId, clock, fetch }),
    pulls: new PublicPullReader(new GithubApi({ fetch }), logger),
    intent: review.intentModel
      ? new GatewayIntentReader({
          baseUrl: `${settings.safeApiUrl}/llm-proxy/v1`,
          model: review.intentModel,
          logger,
          fetch,
        })
      : undefined,
    surface: base.surface,
    exchange: base.exchange,
    clock,
    logger,
    errors: inputs.errors,
    mask: (text) => redactText(text).text,
    guard: inputs.guard,
    audit: (event, fields) => {
      securityLog.event(event as SecurityEventName, fields);
    },
    host,
    followWire,
    restoreRef: (stored) => restoreConversationRef(stored),
    owners: review.owners,
    installUrl: teams.installHintUrl,
    defaultModel: settings.models.review,
  };
}

/** The review service and the handoff the assistant sends back; undefined with TEAMS_GITHUB_REVIEW_ENABLED off. */
export function reviewParts(
  base: AssemblyBase,
  inputs: ReviewInputs,
  assistant: Pick<AssistantParts, "receipts" | "chat">,
): ReviewParts | undefined {
  if (!base.settings.githubReview.enabled) return undefined;
  const late: { service?: GithubReview } = {};
  const self = (): GithubReview => {
    if (late.service === undefined) throw new Error("the review service was used before it was built");
    return late.service;
  };
  const deps = reviewDeps(base, inputs, reviewHost(base, inputs, self));
  const service = new GithubReview(deps, base.random, workCardPoster(base));
  late.service = service;
  const handoff = new ReviewHandoffAction(deps, {
    review: service,
    receipts: assistant.receipts,
    understands: (userId) => assistant.chat.understands(userId),
    reachable: (userId) => assistant.chat.reachable(userId),
  });
  base.logger.info("github review: on", {
    owners: settings(base).owners.join(","),
    requests: settings(base).intentModel ? "model then rules" : "rules",
  });
  return { service, handoff };
}

function settings(base: AssemblyBase) {
  return base.settings.githubReview;
}
