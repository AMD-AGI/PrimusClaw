// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The cards of a remote agent's permission request: the one an attached chat gets (`permissionRequest`), the push of an agent
 * that waits on the user for an instruction the assistant sent (`remote.ask`), and what either becomes once answered. The card is
 * not trusted: the click is checked against the stored options, never against the card.
 */
import type { Lang } from "../locales/lang.js";
import { remoteText } from "../locales/remote.js";
import type { DecisionButton } from "./actions.js";
import { defang, lit, neutral } from "./inert.js";
import {
  type PermissionOption,
  buttonTitle,
  decidedVerdict,
  isPrimary,
  offersAlways,
  shownOptions,
} from "./options.js";
import { orEmpty } from "./py-text.js";
import type { Reported } from "./reported.js";
import { clock } from "./time.js";

/** The buttons of a permission card: one per offered option, in the fixed order, each carrying the option's own id. */
export function optionButtons(
  options: readonly PermissionOption[],
  sessionId: string,
  actionId: string,
  lang: Lang = "en",
): DecisionButton[] {
  return shownOptions(options).map((option) => ({
    title: buttonTitle(option, lang),
    sessionId,
    actionId,
    optionId: option.optionId,
    primary: isPrimary(option),
  }));
}

/** When a request runs out, and what an always option changes: the notes under a permission card. */
function expiryNotes(options: readonly PermissionOption[], expiresAt: number, zone: string, lang: Lang): string[] {
  const words = remoteText.in(lang);
  const notes = [words.validUntil({ until: clock(expiresAt, zone), zone })];
  if (offersAlways(options)) notes.push(words.alwaysChanges);
  return notes;
}

export interface PermissionView {
  readonly lang: Lang;
  /** What the agent wants to do (its own title, inert). */
  readonly action: string;
  /** Its input, kept whole but unable to make a link or a tag. */
  readonly input: unknown;
  /** Whose agent asks, and of what kind the request is. */
  readonly asking: string;
  readonly notes: readonly string[];
  readonly buttons: readonly DecisionButton[];
}

/** The card for one `permissionRequest`. `who`: whose agent it is; `zone`: the user's time zone (an IANA name). */
export function permissionView(
  request: Reported,
  options: readonly PermissionOption[],
  sessionId: string,
  who: string,
  expiresAt: number,
  zone: string,
  lang: Lang = "en",
): PermissionView {
  const words = remoteText.in(lang);
  const kind = neutral(request["kind"], 20);
  const asker = neutral(who, 100);
  return {
    lang,
    action: neutral(request["tool"] || words.anAction, 200),
    input: defang(request["input"]),
    asking: kind ? words.asksPermissionKind({ who: asker, kind }) : words.asksPermission({ who: asker }),
    notes: expiryNotes(options, expiresAt, zone, lang),
    buttons: optionButtons(options, sessionId, orEmpty(request["actionId"]), lang),
  };
}

export interface RemoteAskView {
  readonly lang: Lang;
  readonly title: string;
  /** The tool, inert, in bold. */
  readonly tool: string;
  /** Whose agent waits, and for which errand. */
  readonly waits: string;
  readonly notes: readonly string[];
  readonly buttons: readonly DecisionButton[];
}

export interface RemoteAsk {
  /** The ask as Claw relayed it (`assistant.say` `remote.ask`): its `action_id` and `tool`. */
  readonly ask: Reported;
  readonly options: readonly PermissionOption[];
  readonly sessionId: string;
  readonly machine: string;
  readonly agent: string;
  /** Which errand: `#seq title`. */
  readonly about: string;
  readonly expiresAt: number;
  readonly zone: string;
}

/** The push for an agent on the user's machine that waits on them (an instruction the assistant sent). */
export function remoteAskView(input: RemoteAsk, lang: Lang = "en"): RemoteAskView {
  const words = remoteText.in(lang);
  const who = words.agentOnHost({ agent: lit(input.agent, 40), host: lit(input.machine, 60) });
  return {
    lang,
    title: words.needsApproval,
    tool: `**${lit(input.ask["tool"] || words.anAction, 200)}**`,
    waits: words.waitsForYou({ who, about: lit(input.about, 120) }),
    notes: expiryNotes(input.options, input.expiresAt, input.zone, lang),
    buttons: optionButtons(input.options, input.sessionId, orEmpty(input.ask["action_id"]), lang),
  };
}

export interface DecidedView {
  readonly lang: Lang;
  readonly title: string;
  readonly allowed: boolean;
}

/** What a permission card becomes once the user chose `option` at `when`. */
export function decidedView(option: PermissionOption, when: number, zone: string, lang: Lang = "en"): DecidedView {
  return {
    lang,
    title: remoteText.in(lang).decidedByYou({ verdict: decidedVerdict(option, lang), at: clock(when, zone) }),
    allowed: option.kind.startsWith("allow"),
  };
}
