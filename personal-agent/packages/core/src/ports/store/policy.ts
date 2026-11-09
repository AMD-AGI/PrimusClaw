// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The store's retention and limit policy. The values are the Python worker's (`teams_agent/store.py`) one for one: a
 * row kept for a different time by the two would make a switch between them change what a person sees.
 */

const MINUTE = 60;
const HOUR = 3600;
const DAY = 24 * HOUR;

/** How long a `/link` code minted by the console can be redeemed. */
export const LINK_CODE_TTL_SECONDS = 10 * MINUTE;
export const CODE_LENGTH = 8;
/** The alphabet a link code is drawn from: no 0/O/1/I. */
export const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
/** Wrong codes per user in the window (TEAMS_LINK_MAX_FAILURES_PER_USER). */
export const MAX_FAILED_ATTEMPTS = 5;
/** Wrong codes of all users together in the window (TEAMS_LINK_MAX_FAILURES_GLOBAL). */
export const MAX_FAILED_ATTEMPTS_GLOBAL = 100;
/** TEAMS_LINK_ATTEMPT_WINDOW_SECONDS. */
export const ATTEMPT_WINDOW_SECONDS = 10 * MINUTE;
/** An action is carried out for an assistant message this young, at most. */
export const ASSISTANT_MESSAGE_KEEP_SECONDS = DAY;
/** A held write's card: Claw keeps the confirmation for a day; a press after that is told so. */
export const CONFIRM_CARD_KEEP_SECONDS = DAY + 10 * MINUTE;
export const PROCESSED_TTL_SECONDS = 7 * DAY;
/** A Claw event being sent is claimed this long; past it the claim is taken to have died with its process. */
export const EVENT_CLAIM_LEASE_SECONDS = 2 * MINUTE;
/** "What went wrong?" waits this long for the user's next message. */
export const FEEDBACK_ASK_TTL_SECONDS = 10 * MINUTE;
/** The "include my last question and answer" buttons work this long. */
export const FEEDBACK_OFFER_TTL_SECONDS = 30 * MINUTE;
/** An offer row is kept this long. */
export const FEEDBACK_OFFER_KEEP_SECONDS = 7 * DAY;
/** The "Report a problem" button under a failed message works this long. */
export const FEEDBACK_PROMPT_TTL_SECONDS = 7 * DAY;
/** Same user + same session within this long: a comment on the same issue. */
export const FEEDBACK_DEDUPE_SECONDS = 10 * MINUTE;
/** Delivered reports are kept this long (undelivered ones are never dropped). */
export const FEEDBACK_KEEP_SECONDS = 30 * DAY;
/** One onboarding card per person per group chat, and one proactive DM per person, in this long. */
export const ONBOARDING_INTERVAL_SECONDS = DAY;
/** A group request from someone who is not linked yet waits this long for them to link. */
export const PENDING_REQUEST_TTL_SECONDS = 15 * MINUTE;
/** A message a turn answered drops its run's card this long. */
export const ANSWERED_MESSAGE_KEEP_SECONDS = 7 * DAY;
/** A remote permission row is kept this long after it ran out (stale-click message). */
export const REMOTE_PERMISSION_KEEP_SECONDS = 7 * DAY;
/** A card for a work item answers its buttons this long; after that /board shows the item again. */
export const ASSISTANT_CARD_KEEP_SECONDS = 30 * DAY;

export const DEFAULT_TIMEZONE = "Asia/Shanghai";
export const DEFAULT_QUIET: readonly [string, string] = ["22:00", "08:00"];
/** 9999-12-31: "until /resume". */
export const PAUSE_FOREVER = 253402300799.0;
export const MAX_HELD_PER_USER = 100;
export const HELD_TTL_SECONDS = 7 * DAY;
/** How long an approval row is kept after it expired, for the stale-click message. */
export const APPROVAL_TTL_SECONDS = 7 * DAY;
/** How long a review session is remembered as one that acts as a user. */
export const ACTING_SESSION_KEEP_SECONDS = 30 * DAY;
/** The repositories /repo remembers per user (and lists). */
export const RECENT_REPOS = 5;
/** "My next message is for this repository" is forgotten after this. */
export const PENDING_REPO_TTL_SECONDS = DAY;
/** The sessions /sessions lists. */
export const SESSION_LIST = 5;
/** The sessions a chat remembers per user: more than are listed, so a deletion in Claw leaves some. */
export const SESSION_HISTORY_KEEP = 20;
/** The session cards of one remote attachment remembered for quote replies. */
export const WINDOW_CARDS_KEPT = 8;
