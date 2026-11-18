// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/** How much of what an agent or a connector reports is read, kept and shown. */

/** A phone screen holds this many buttons under a card. */
export const OPTION_BUTTONS_MAX = 4;
/** A permission request that names no timeout lives this long, as long as the connector keeps it. */
export const PERMISSION_DEFAULT_SECONDS = 600;
export const BUTTON_TITLE_MAX = 40;
export const TOOL_TITLE_MAX = 100;
export const THOUGHT_MAX = 200;
export const SESSIONS_SHOWN = 8;
export const ANSWER_MESSAGES_MAX = 3;
export const ANSWER_CHARS_MAX = 3000;
/** The answer is cut to about 9000 characters on its way out: no point holding more of it. */
export const SEGMENT_KEEP_CHARS = 12_000;
/** The answer is the last text; the stretches before it are narration. */
export const SEGMENTS_KEPT = 4;
/** Event ids remembered for dropping a repeat (a reconnect resumes after the last event anyway). */
export const SEEN_KEPT = 2000;
/** Steps shown as running at once (a connector that never ends its steps cannot grow the view). */
export const ACTIVE_STEPS_MAX = 40;
/** A block of the live view keeps this much of its end (the view shows the newest 2500 anyway). */
export const BLOCK_KEEP_CHARS = 3000;
export const OPTION_ID_MAX = 128;
/** Online agents that get a "New session" block on the agents card. */
export const AGENT_BLOCKS_MAX = 6;
/** Sessions the agents card lists, newest first. */
export const SESSION_CARD_MAX = 5;
/** Folders a connector reports per agent. */
export const ROOTS_MAX = 8;
export const ROOT_MAX = 300;
export const SUBFOLDER_MAX = 200;
/** Conversations of one agent the agents card offers to take over (a connector reports at most twelve). */
export const RESUMABLE_SHOWN = 5;
/** Of them, the ones no process runs (listed after those a terminal has open, in a group of their own). */
export const IDLE_SHOWN = 2;
/** What Claw accepts as a resume_ref. */
export const RESUME_REF_MAX = 128;
/** Conversations a connector reports per agent. */
export const RESUMABLE_READ_MAX = 12;
export const WAITING_FOR_MAX = 60;
export const TYPED_LINES_MAX = 40;
/** Problems one machine shows on the agents card. */
export const HEALTH_LINES_MAX = 4;
/** Problems read from one agent's report (Claw caps capabilities at 4 KiB; this bounds the rest). */
export const HEALTH_READ_MAX = 16;
/** Sessions of one agent the sessions card lists, newest first. */
export const SESSIONS_PER_AGENT = 5;
/** Conversations of one agent the sessions card offers to take over. */
export const CONVERSATIONS_PER_AGENT = 3;
