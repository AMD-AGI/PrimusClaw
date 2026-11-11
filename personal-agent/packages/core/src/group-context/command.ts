// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import { BOT_NAME } from "../branding.js";
import { GROUP_CONTEXT_TEXT as T } from "../locales/group-context.js";
import type { MessageInterceptor, MessageRoute } from "../ports/routing.js";
import { textMessage } from "../ports/surface.js";
import { pySplit } from "../text/py-text.js";
import type { GroupContext } from "./buffer.js";

/** `/context on | off | status`, said to the bot in a group; with 开/关/状态 as well. */
export type ContextVerb = "on" | "off" | "status" | "usage";

// A Map, not an object literal: a word from the chat must not find `constructor` or `__proto__` on Object.prototype.
const VERBS: ReadonlyMap<string, ContextVerb> = new Map([
  ["on", "on"],
  ["开", "on"],
  ["打开", "on"],
  ["off", "off"],
  ["关", "off"],
  ["关闭", "off"],
  ["status", "status"],
  ["状态", "status"],
  ["", "status"],
]);

/** The command's verb, `usage` for a malformed one, undefined when the text is not this command. */
export function parseContext(text: string): ContextVerb | undefined {
  const words = pySplit(text);
  if (words[0]?.toLowerCase() !== "/context") return undefined;
  if (words.length > 2) return "usage";
  return VERBS.get(words[1]?.toLowerCase() ?? "") ?? "usage";
}

/**
 * `/context on|off|status` in a group, read before the account check: anybody in the chat may turn it off or on (it is
 * the chat's, not one person's), and off drops what was kept at once.
 */
export function contextInterceptor(context: GroupContext): MessageInterceptor {
  return {
    name: "group_context",
    intercept: async (route) => {
      const verb = parseContext(route.text);
      if (verb === undefined) return false;
      await route.conversation.send(textMessage(answer(context, route, verb)));
      return true;
    },
  };
}

function answer(context: GroupContext, route: MessageRoute, verb: ContextVerb): string {
  const chatId = route.conversation.ref.id;
  const bot = BOT_NAME;
  if (verb === "usage") return T.usage({ bot });
  if (!context.enabled) return T.unavailable;
  if (verb === "off") {
    context.turnOff(chatId);
    return T.turnedOff({ bot });
  }
  if (verb === "on") {
    context.turnOn(chatId);
    return T.turnedOn({ bot });
  }
  if (context.isOff(chatId)) return T.isOff({ bot });
  const count = context.count(chatId);
  return count === 0 ? T.isOnEmpty({ bot }) : T.isOn({ bot, count: String(count) });
}
