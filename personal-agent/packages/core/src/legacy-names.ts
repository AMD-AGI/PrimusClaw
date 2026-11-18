// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Names from before the bot's default name changed (the earlier name collides with third-party products). Every other source
 * file names the bot through the deployment's configured name (`Settings.botName`) or neutral words.
 * - A `LEGACY_` name is read and never written: a suggested reply on a card sent before the rename still takes the chat back.
 * - A `PERSISTED_` name is held outside this process already (a stored field, a label and marker on filed issues, the keys a
 *   redelivered message is recognised by, the logger name log queries select on) and keeps its spelling, since renaming it
 *   would make what was kept unreadable or unmatched.
 * `test/legacy-names.test.ts` bans the earlier name everywhere in the packages' sources except in declarations of this kind.
 */

/** The bot's earlier default display name, as the "back to ..." suggested replies on cards sent before the rename say it. */
export const LEGACY_BOT_NAME = "Clawy";
/** The field of a kept terminal ask (stored as written) that says its card showed the request whole. */
export const PERSISTED_SHOWN_WHOLE = "clawy_shown_whole";
/** The label of the GitHub issues feedback is filed as (existing issues carry it). */
export const PERSISTED_FEEDBACK_LABEL = "clawy-feedback";
/** The hidden marker in a filed feedback issue's body that a report is found again by. */
export const PERSISTED_FEEDBACK_MARKER = "clawy-feedback-id";
/** The prefix of the idempotency key Claw recognises a redelivered message by (a key from before an upgrade still matches). */
export const PERSISTED_IDEMPOTENCY_PREFIX = "clawy-";
/** The logger security events are written on: log queries and alerts select them by this name. */
export const PERSISTED_SECURITY_LOGGER = "clawy.security";
