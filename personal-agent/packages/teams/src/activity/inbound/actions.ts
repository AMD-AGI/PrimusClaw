// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * A press on a button of a card the bot posted (the Python worker's `_card_data`, the `*_action` readers, `card_action`,
 * `is_card_click`, `card_verb`). An Action.Execute arrives as an `adaptiveCard/action` invoke whose `value.action.data`
 * is the button's data; an Action.Submit as a message whose `value` is. Each of the bot's buttons says which it is in
 * `data.primusclaw` (its kind); a reader returns the data of one kind, unvalidated (each handler reads it through its
 * own schema).
 */
import { cpHead, pyStr } from "@primusclaw/personal-agent";
import { isFields, type Activity, type Fields } from "./schema.js";

/** The data of a card press, wherever the activity carries it; undefined when it carries none. */
export function cardDataOf(activity: Activity): Fields | undefined {
  const value = activity.value;
  if (!isFields(value)) return undefined;
  const inner = value["action"];
  const data = isFields(inner) ? inner["data"] : value;
  return isFields(data) ? data : undefined;
}

/** The kind of a card press (`data.primusclaw`), "" when the data names none. */
export function cardKindOf(activity: Activity): string {
  const kind = cardDataOf(activity)?.["primusclaw"];
  return typeof kind === "string" ? kind : "";
}

/** The data of a press on a button of kind `kind`, if the activity is one. */
export function cardData(activity: Activity, kind: string): Fields | undefined {
  const data = cardDataOf(activity);
  return data !== undefined && data["primusclaw"] === kind ? data : undefined;
}

type Reader = (activity: Activity) => Fields | undefined;

function reader(kind: string): Reader {
  return (activity) => cardData(activity, kind);
}

/** An Action.Execute invoke or an Action.Submit message of a decision card. */
export const cardAction = reader("decision");
/** A question card's Send button, with what the person chose and typed. */
export const answerAction = reader("answer");
/** A "Show here" button. */
export const showAction = reader("show");
/** A repository card's "Use this repo" button. */
export const repoAction = reader("repo");
/** The changes card's "Create PR" button. */
export const createPrAction = reader("create_pr");
/** The feedback offer's "Yes, include it" / "No" buttons. */
export const feedbackAction = reader("feedback");
/** One of the bot's own thumbs (the card under an answer on a phone). */
export const thumbAction = reader("thumb");
/** The Send / Skip button under the comment question a thumbs-down on a phone opens. */
export const thumbNoteAction = reader("thumb_note");
/** The "Report a problem" button under a message that went wrong. */
export const reportAction = reader("report");
/** The "Connect" button of a group onboarding card. */
export const onboardAction = reader("onboard");
/** One option button of a remote agent's permission card. */
export const remoteDecisionAction = reader("remote_decision");
/** The Disconnect / Keep it buttons of a remote agent's disconnect card. */
export const remoteOffAction = reader("remote_off");
/** A button of the agents card or of the action row under a remote agent's answer. */
export const remoteAction = reader("remote");
/** Accept or Stop under a work item's card. */
export const workAction = reader("work");
/** Accept or Dismiss under a suggestion of an observed group chat. */
export const observeAction = reader("observe");
/** Run or Cancel under a command the assistant put to the person. */
export const assistantActionClick = reader("assistant_action");
/** A held write's card (allow or deny). */
export const assistantConfirmClick = reader("assistant_confirm");
/** Send on a choice the assistant put to the person, with the places of the options picked. */
export const assistantChoiceClick = reader("assistant_choice");
/** "Merge" / "Do not merge" on the card a high-risk merge sends to the reviewer. */
export const githubConfirmAction = reader("github_confirm");
/** One of the two confirmation settings of the review mode card. */
export const githubModeAction = reader("github_mode");
/** "Not now" on the card offered beside a question about the person's own GitHub. */
export const githubConnectAction = reader("github_connect");
/** The "Act as me" confirmation card. */
export const bindAction = reader("bind");

/** A click on an Action.Execute button: the invoke the ingress answers with a placeholder card. */
export function isCardClick(activity: Activity): boolean {
  return activity.type === "invoke" && activity.name === "adaptiveCard/action";
}

/** The verb of a card click, for a log line (clipped: it comes from the client). */
export function cardVerb(activity: Activity): string {
  const value = activity.value;
  const inner = isFields(value) ? value["action"] : undefined;
  const verb = isFields(inner) ? inner["verb"] : undefined;
  return cpHead(pyStr(verb) || "unknown", 40);
}
