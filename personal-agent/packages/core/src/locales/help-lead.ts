// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import { defineCatalog } from "./catalog.js";

interface Where {
  readonly label: string;
  readonly host: string;
  /** " `<folder>`" or "". */
  readonly cwd: string;
}

/** Help's first line in a chat attached to an agent's session: where the person's messages go, and how to come back. */
export const helpLeadText = defineCatalog({
  en: {
    direct: (p: Where) =>
      `This chat is attached to ${p.label} on ${p.host}${p.cwd}: what you say goes to it, and its messages start with its ` +
      'name and machine. Messages that start with @Clawy come to me, and mine start with "💬 Clawy". Say or tap ' +
      '"Back to Clawy" to come back to me.',
    card: (p: Where & { readonly line: string }) =>
      `This chat is attached to ${p.label} on ${p.host}${p.cwd}. ${p.line}`,
    chat: (p: Where) =>
      `This chat is attached to ${p.label} on ${p.host}${p.cwd}: what you say goes to it. Messages that start with @Clawy and ` +
      'requests sent on your behalf still come to me. Say "back to Clawy" to come back to me.',
  },
  zh: {
    direct: (p) =>
      `这个聊天现在连着 ${p.host} 上的 ${p.label}${p.cwd}：你说的话都发给它，它的消息第一行是它的名字和机器；` +
      "以 @Clawy 开头的消息由我回答，我的消息第一行是「💬 Clawy」。说或点「回到 Clawy」就回到我这里。",
    card: (p) => `这个聊天现在连着 ${p.host} 上的 ${p.label}${p.cwd}。${p.line}`,
    chat: (p) =>
      `这个聊天现在连着 ${p.host} 上的 ${p.label}${p.cwd}：你说的话都发给它；以 @Clawy 开头的消息和协调者代发的请求仍然由我处理。` +
      "说「回到 Clawy」就回到我这里。",
  },
});
