// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The chat app a message came through, as a router turn tells it apart: its client names it in `channel_context.channel`
 * ("teams" from the Teams worker). What a router turn says about where it is (`renderRouterSelfSection`, the GitHub line of
 * `renderRouterPrompt`) and which of the plugin's rules says how its reply is written (`readToolsOfPlugin`) follow it, so a
 * channel other than Teams is neither told it is in Teams nor given Teams' formatting rule.
 *
 * Teams is the one channel with words and a rule of its own. Any other channel is said generically ("in the chat") and gets the
 * plugin's generic `chat-reply-style` rule; a channel that needs its own (a markup of its own) gets an entry in CHAT_SURFACES. A
 * message that names no channel came from a client from before it did: the Teams worker. Which message a turn reads it from is
 * `turnChannelTold`'s (`inbound.ts`): the one it answers, read beside the reply language with no query of its own.
 */

export interface ChatSurface {
  /** The channel's id as its client names it. */
  readonly channel: string;
  /** Where the person talks to the assistant, as a prompt says it after a verb ("in Teams", "in the chat"). */
  readonly where: string;
  /** The plugin's rules that say how a reply is written for this channel, by name (`readToolsOfPlugin`). */
  readonly replyRules: readonly string[];
}

/** What a client from before `channel_context.channel` was sent is: the Teams worker. */
export const DEFAULT_CHANNEL = "teams";

/** The rule that says how a reply is written for a chat app with no rule of its own (plain markdown, short lines). */
export const CHAT_REPLY_RULE = "chat-reply-style";

/** The channels with words and a rule of their own. */
export const CHAT_SURFACES: Readonly<Record<string, ChatSurface>> = {
  teams: { channel: "teams", where: "in Teams", replyRules: ["teams-reply-style"] },
};

/** The longest channel id kept; a longer or odd one is no channel. */
const CHANNEL_MAX = 32;

/** The chat surface of a channel id as a message's context carries it (anything not a channel id: the default, Teams). */
export function chatSurface(channel: unknown): ChatSurface {
  const id = typeof channel === "string" && channel.length <= CHANNEL_MAX && /^[a-z0-9][a-z0-9-]*$/.test(channel)
    ? channel : DEFAULT_CHANNEL;
  return Object.hasOwn(CHAT_SURFACES, id) ? CHAT_SURFACES[id] : { channel: id, where: "in the chat", replyRules: [CHAT_REPLY_RULE] };
}
