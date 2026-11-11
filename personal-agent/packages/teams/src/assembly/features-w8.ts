// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Feedback, observing a group and the daily brief, as the Python worker builds them (`main.run`'s `FeedbackService`,
 * `Agent.__init__`'s `Observer`, `Agent._cmd_brief`): `/feedback` and the Report a problem card, the bot's and Teams' own
 * thumbs, reports that could not be filed retried, `/observe` in a group, and `/brief`.
 */
import { createHash } from "node:crypto";

import type { JsonObject, OutMessage, UserRef } from "@primusclaw/personal-agent";
import {
  DailyBrief,
  FeedbackFlow,
  FeedbackReporting,
  FeedbackService,
  FeedbackThumbs,
  GroupContext,
  noFeedbackSink,
  Observer,
  pyStr,
  pyStrip,
  redactText,
  reportMessage,
  turn,
  withoutRule,
} from "@primusclaw/personal-agent";

import { packageVersion, workerInfoFromEnv } from "@primusclaw/personal-agent-runtime";

import { isObject } from "../cards/json.js";
import type { AssemblyBase } from "./features-base.js";
import { conversationFor } from "./features-proactive.js";

function listOf(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? (value as readonly unknown[]) : [];
}

/** The brief Claw put together, as a message (Python `render.brief_markdown`). */
export function briefMarkdown(brief: JsonObject): string {
  const zh = brief["lang"] === "zh";
  const sep = zh ? "：" : ": ";
  const out = [`**${turn.plain((zh ? "每日简报 " : "Daily brief, ") + pyStr(brief["date"]))}**`];
  const sections = listOf(brief["sections"]);
  for (const section of sections) {
    if (!isObject(section)) continue;
    out.push(`**${turn.plain(pyStr(section["title"]))}**${sep}${turn.plain(pyStr(section["summary"]))}`);
    const lines = listOf(section["lines"]);
    out.push(...lines.slice(0, 5).map((line) => `- ${turn.plain(pyStr(line))}`));
  }
  const needs = listOf(brief["needs_you"])
    .slice(0, 3)
    .map((n) => pyStr(n));
  if (needs.length) {
    out.push((zh ? "**需要你**" : "**Needs you**") + sep, ...needs.map((n) => `- ${turn.plain(n)}`));
  } else out.push(zh ? "今天没有需要你处理的事。" : "Nothing needs you today.");
  return out.join("\n\n");
}

export interface W8Parts {
  readonly service: FeedbackService;
  readonly flow: FeedbackFlow;
  readonly thumbs: FeedbackThumbs;
  readonly observer: Observer;
  /** The recent messages of group chats, in memory, as background for an @mention. */
  readonly groupContext: GroupContext;
  readonly brief: DailyBrief;
  /** The Report a problem card under a message of the person's that went wrong. */
  reportView(userId: string, scope: string): OutMessage;
}

/** The feedback service as `main.run` builds it (`FeedbackService`, with the deployment's sink when it has one). */
function feedbackService(base: AssemblyBase, mask: (text: string) => string): FeedbackService {
  const { store, claw, clock, logger, settings, plugins, env } = base;
  return new FeedbackService({
    reports: store.feedback,
    links: store.links,
    sessions: claw.sessions,
    // (no sink configured: reports are only recorded, as the Python worker's with no FEEDBACK_REPO)
    sink: plugins.feedbackSink === noFeedbackSink ? undefined : plugins.feedbackSink,
    clock,
    log: logger,
    mask,
    turnText: {
      withoutRule,
      answerOf: (turnId, events) => {
        const state = new turn.TurnState(turnId);
        for (const event of events) state.feed(event);
        return pyStrip(state.answer);
      },
    },
    wording: { botName: "Clawy", channelName: "Teams" },
    publicBaseUrl: settings.publicBaseUrl,
    worker: workerInfoFromEnv(env, {
      pluginId: settings.claw.pluginId === null ? "" : String(settings.claw.pluginId),
      version: packageVersion(new URL("../../package.json", import.meta.url)),
    }),
    logs: base.chatLog,
  });
}

export function w8Parts(
  base: AssemblyBase,
  options: { readonly briefEnabled: boolean; readonly assistantOn: (userId: string) => boolean },
): W8Parts {
  const { store, claw, clock, logger, settings, plugins } = base;
  const mask = (text: string): string => redactText(text).text;
  const service = feedbackService(base, mask);
  const credential = (sender: UserRef): Promise<string | undefined> =>
    Promise.resolve(store.links.getKey(sender.id) ?? undefined);
  const reporting = new FeedbackReporting({
    service,
    sessions: store.sessions,
    assistant: claw.assistant,
    assistantOn: options.assistantOn,
    credential,
    identity: plugins.identityLookup,
    clock,
    log: logger,
  });
  const thumbs = new FeedbackThumbs({
    reporting,
    sessions: store.sessions,
    claw: { sessions: claw.sessions, assistant: claw.assistant },
    credential,
    assistantOn: options.assistantOn,
    sha256Hex: (text) => createHash("sha256").update(text, "utf8").digest("hex"),
    mask,
    log: logger,
  });
  const observer = new Observer({
    observe: store.observe,
    links: store.links,
    assistant: claw.assistant,
    users: [...settings.observeUsers],
    conversationOf: conversationFor(base),
    pluginId: settings.claw.pluginId ?? undefined,
    log: logger,
  });
  const groupContext = new GroupContext({
    settings: settings.groupContext,
    clock,
    mask,
    off: store.groupContext,
    log: logger,
  });
  const brief = new DailyBrief({
    enabled: options.briefEnabled,
    links: store.links,
    prefs: store.prefs,
    triggers: claw.triggers,
    assistant: claw.assistant,
    assistantOn: options.assistantOn,
    briefMarkdown,
    log: logger,
  });
  return {
    service,
    flow: new FeedbackFlow({ reports: store.feedback, reporting, service, log: logger }),
    thumbs,
    observer,
    groupContext,
    brief,
    reportView: (userId, scope) => {
      const view = service.reportView(userId, scope);
      return reportMessage(view.promptId, view.group);
    },
  };
}
