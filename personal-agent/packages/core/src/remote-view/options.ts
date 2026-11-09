// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The options an agent offers on a permission request (`[{optionId, name, kind}]`, ACP's), and what each button says. The ids are
 * the agent's own and pass through untouched; the click is checked against the stored options, never against the card.
 */
import { neutral } from "./inert.js";
import type { Lang } from "../locales/lang.js";
import { BUTTON_TITLE_MAX, OPTION_BUTTONS_MAX, OPTION_ID_MAX } from "./limits.js";
import { length } from "./py-text.js";
import { objOrNull, str } from "./reported.js";
import { remoteText } from "../locales/remote.js";

const CONTROL = /[\u0000-\u001f\u007f]/;
const OPTIONS_READ_MAX = 12;

export interface PermissionOption {
  readonly optionId: string;
  readonly name: string;
  readonly kind: string;
}

/** The order the buttons come in: allow once, allow always, then the rejections and anything else. */
const KIND_RANK: Readonly<Record<string, number>> = {
  allow_once: 0,
  allow_always: 1,
  reject_once: 2,
  reject_always: 3,
};
/** The words of each kind, for an option the agent gave no name. */
type Words = ReturnType<typeof remoteText.in>;
type KindWord = "allowOnce" | "allowAlways" | "rejectOnce" | "rejectAlways";
type VerdictWord = "allowedOnce" | "allowedAlways" | "rejectedOnce" | "rejectedAlways";

const KIND_WORDS: Readonly<Record<string, KindWord>> = {
  allow_once: "allowOnce",
  allow_always: "allowAlways",
  reject_once: "rejectOnce",
  reject_always: "rejectAlways",
};
/** What each kind came to, once chosen. */
const KIND_VERDICT: Readonly<Record<string, VerdictWord>> = {
  allow_once: "allowedOnce",
  allow_always: "allowedAlways",
  reject_once: "rejectedOnce",
  reject_always: "rejectedAlways",
};

function usableId(id: unknown, seen: ReadonlySet<string>): id is string {
  return typeof id === "string" && id !== "" && length(id) <= OPTION_ID_MAX && !seen.has(id) && !CONTROL.test(id);
}

/** The options an agent offered, as strings and nothing else: an entry without a usable `optionId` is dropped, a repeated id is
 * kept once, at most twelve. */
export function parseOptions(raw: unknown): PermissionOption[] {
  const options: PermissionOption[] = [];
  const seen = new Set<string>();
  for (const entry of Array.isArray(raw) ? raw : []) {
    const item = objOrNull(entry);
    if (!item || !usableId(item["optionId"], seen)) continue;
    const optionId = item["optionId"];
    seen.add(optionId);
    options.push({ optionId, name: str(item["name"]), kind: str(item["kind"]) });
  }
  return options.slice(0, OPTIONS_READ_MAX);
}

/** What a button says: the agent's own name for the option, clipped; an option that persists (`allow_always`) always says so,
 * whatever the agent called it. With no name the kind's plain words, else the id. */
export function buttonTitle(option: PermissionOption, lang: Lang = "en"): string {
  let name = neutral(option.name, BUTTON_TITLE_MAX);
  if (
    option.kind === "allow_always" &&
    !name.toLowerCase().includes("always") &&
    !(lang === "zh" && name.includes("始终"))
  ) {
    name = neutral(
      name ? remoteText.in(lang).alwaysOption({ name }) : remoteText.in(lang).allowAlways,
      BUTTON_TITLE_MAX,
    );
  }
  const plain = KIND_WORDS[option.kind];
  const words: Words = remoteText.in(lang);
  return name || (plain ? words[plain] : "") || neutral(option.optionId, BUTTON_TITLE_MAX);
}

/** The options a card shows, in the fixed order, at most OPTION_BUTTONS_MAX. */
export function shownOptions(options: readonly PermissionOption[]): PermissionOption[] {
  return [...options].sort((a, b) => (KIND_RANK[a.kind] ?? 4) - (KIND_RANK[b.kind] ?? 4)).slice(0, OPTION_BUTTONS_MAX);
}

/** The one primary button is allow once; a rejection is a plain one. */
export function isPrimary(option: PermissionOption): boolean {
  return option.kind === "allow_once";
}

/** Whether choosing one of `options` changes what the agent may do from now on (an always option). */
export function offersAlways(options: readonly PermissionOption[]): boolean {
  return options.some((o) => o.kind === "allow_always");
}

/** What an option came to, once chosen ("Allowed once"), or its button's words for a kind with no verdict of its own. */
export function decidedVerdict(option: PermissionOption, lang: Lang = "en"): string {
  const key = KIND_VERDICT[option.kind];
  return key ? remoteText.in(lang)[key] : buttonTitle(option, lang);
}
