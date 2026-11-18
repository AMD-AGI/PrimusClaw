// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * How replies look in Teams: the switches of the reply style (TEAMS_* settings, read once at start). Each can be turned
 * off with one setting, and whatever a switch turns on degrades to a plain message when Teams does not take it.
 *
 * - `aiLabel` (TEAMS_AI_LABEL, on): an AI-generated answer carries Teams' "AI generated" label.
 * - `streaming` (TEAMS_STREAMING, `personal,groupChat`): the chat kinds where a turn shows Teams' floating status (direct
 *   outbound mode only; `off` turns it off).
 * - `streamText` (TEAMS_STREAM_TEXT, off): the agent's visible text is streamed into the answer's bubble.
 * - `assistantReceipt` (TEAMS_ASSISTANT_RECEIPT, on), `assistantProgress` (TEAMS_ASSISTANT_PROGRESS, on),
 *   `assistantStreamSay` (TEAMS_ASSISTANT_STREAM_SAY, on): the assistant's receipt, its live steps and streamed words.
 * - `ownThumbsMobile` (TEAMS_OWN_THUMBS_MOBILE, on), `suggestedReplies` (TEAMS_SUGGESTED_REPLIES, on), `citations`
 *   (TEAMS_CITATIONS, off).
 */

/** The Teams conversation types a stream may be used in (a channel never). */
export const STREAM_SCOPES = ["personal", "groupChat"] as const;
export type StreamScope = (typeof STREAM_SCOPES)[number];

export interface Style {
  readonly aiLabel: boolean;
  readonly streaming: ReadonlySet<string>;
  readonly streamText: boolean;
  readonly assistantReceipt: boolean;
  readonly assistantProgress: boolean;
  readonly assistantStreamSay: boolean;
  readonly ownThumbsMobile: boolean;
  readonly suggestedReplies: boolean;
  readonly citations: boolean;
}

export const DEFAULT_STYLE: Style = {
  aiLabel: true,
  streaming: new Set(STREAM_SCOPES),
  streamText: false,
  assistantReceipt: true,
  assistantProgress: true,
  assistantStreamSay: true,
  ownThumbsMobile: true,
  suggestedReplies: true,
  citations: false,
};

/** Whether Teams' floating status is on for this kind of chat ("personal", "groupChat"; a channel never). */
export function streamsIn(style: Style, conversationType: string): boolean {
  return style.streaming.has(conversationType);
}

function pythonBool(value: boolean): string {
  return value ? "True" : "False";
}

/** One line for the start-up log (names and values only), as the Python worker wrote it. */
export function describeStyle(style: Style): string {
  const scopes = STREAM_SCOPES.filter((s) => style.streaming.has(s)).join(",") || "off";
  return [
    `ai_label=${pythonBool(style.aiLabel)}`,
    `streaming=${scopes}`,
    `stream_text=${pythonBool(style.streamText)}`,
    `assistant_receipt=${pythonBool(style.assistantReceipt)}`,
    `assistant_progress=${pythonBool(style.assistantProgress)}`,
    `assistant_stream_say=${pythonBool(style.assistantStreamSay)}`,
    `own_thumbs_mobile=${pythonBool(style.ownThumbsMobile)}`,
    `suggested_replies=${pythonBool(style.suggestedReplies)}`,
    `citations=${pythonBool(style.citations)}`,
  ].join(" ");
}
