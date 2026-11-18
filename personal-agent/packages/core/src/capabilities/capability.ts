// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/** The shape of one entry of the capability registry (`registry.ts`). */

export type CategoryKey = "chat" | "review" | "settings" | "remote" | "notify" | "feedback";

export interface Category {
  readonly key: CategoryKey;
  readonly zh: string;
  readonly en: string;
}

/** In the order help shows them. */
export const CATEGORIES: readonly Category[] = [
  { key: "chat", zh: "对话与任务", en: "Chat and tasks" },
  { key: "review", zh: "代你审 PR 和合入", en: "Reviews and merges for you" },
  { key: "settings", zh: "你自己的设置", en: "Your settings" },
  { key: "remote", zh: "远程 agent", en: "Remote agents" },
  { key: "notify", zh: "通知与免打扰", en: "Notifications and quiet hours" },
  { key: "feedback", zh: "反馈", en: "Feedback" },
];

/** Where help shows a capability: a 1:1 chat, a group chat, or both. */
export type Where = "dm" | "group" | "both";
/** "assistant" only with the assistant on, "session" only without it, "understanding" only for the people the assistant
 * understands every message of, "" either way. */
export type CapabilityMode = "" | "assistant" | "session" | "understanding";
/** The parts of the worker a capability needs on: shown only then. */
export type Part = "github" | "remote" | "brief" | "schedule" | "watch_job";

export interface Capability {
  readonly key: string;
  /** A CATEGORIES key; "" for help itself (the closing line, not a category). */
  readonly category: CategoryKey | "";
  /** What it is, in a few words. */
  readonly zh: string;
  readonly en: string;
  /**
   * What it is in a handful of words, for the line of a group's help that says what else a 1:1 chat with the bot does ("" : not
   * named there). Only a capability a group does not show has one.
   */
  readonly dmZh: string;
  readonly dmEn: string;
  /** One sentence a person would type for it ("" : it is done with buttons). */
  readonly sayZh: string;
  readonly sayEn: string;
  /**
   * Where the example goes: "turn", "group_review [MODEL]" (one review per pull request it names), "review_mode MODE" (the card
   * to choose it), "unlink_ask", or "<command> [ARG]" as the worker reads it.
   */
  readonly reaches: string;
  /** The code's surfaces it stands for: command:, github:, agent:, card:, setting:, route:. */
  readonly covers: readonly string[];
  readonly where: Where;
  /** Where its example is typed: "dm", or "group" (after an @mention). */
  readonly typedIn: "dm" | "group";
  readonly mode: CapabilityMode;
  /** Whose current value help shows (a key of the `values` help is given). */
  readonly setting: string;
  readonly needs: Part | "";
  /**
   * The assistant may ask the chat to do it (`channelActions`): its command, carried out as if typed. Never one that cannot be
   * undone or that loosens a safety setting (`NOT_ACTIONS`).
   */
  readonly action: boolean;
}

type Fields = Pick<Capability, "key" | "category" | "zh" | "en"> & Partial<Capability>;

export function capability(fields: Fields): Capability {
  return {
    dmZh: "",
    dmEn: "",
    sayZh: "",
    sayEn: "",
    reaches: "",
    covers: [],
    where: "dm",
    typedIn: "dm",
    mode: "",
    setting: "",
    needs: "",
    action: false,
    ...fields,
  };
}
