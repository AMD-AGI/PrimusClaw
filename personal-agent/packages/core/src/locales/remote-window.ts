// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import { defineCatalog } from "./catalog.js";

/** What the session card as the window says about where typed text goes (`remote/window/`). `bot` is the assistant's name. */
export const remoteWindowText = defineCatalog({
  en: {
    sentFromQuote: "You replied quoting the card: ",
    sentFromChat: "You sent in the chat: ",
    sentFromCard: "You sent from the card: ",
    chatBoxCard: (p: { bot: string }) =>
      `What you type in the chat box goes to ${p.bot}; to write to this session use the box on this card, or reply ` +
      "quoting this card. To send the chat box to the session instead: /agent mode chat",
    chatBoxChat: (p: { bot: string }) =>
      `What you type goes to this session; messages that start with @${p.bot}, ${p.bot}'s / commands and requests sent on ` +
      `your behalf stay with ${p.bot}. To keep the chat box for ${p.bot}: /agent mode card`,
    thisChatToo: " (this chat too, from now on)",
    modeSetCard: (p: { bot: string; now: string }) =>
      `Done: while a chat is attached, the chat box stays with ${p.bot} and the session card's box goes to the session${p.now}.`,
    modeSetChat: (p: { bot: string; now: string }) =>
      `Done: while a chat is attached, what you type goes to the session${p.now}. Messages that start with @${p.bot} still come to me.`,
  },
  zh: {
    sentFromQuote: "你引用卡片回复的：",
    sentFromChat: "你在聊天里发的：",
    sentFromCard: "你从卡片发的：",
    chatBoxCard: (p) =>
      `在聊天框里打字是跟 ${p.bot} 说；发给这个会话请用卡片上的输入框，或引用回复这张卡片。想让聊天框直接发给会话：/agent mode chat`,
    chatBoxChat: (p) =>
      `聊天框里打的字都发给这个会话；以 @${p.bot} 开头的消息、${p.bot} 的 / 命令和协调者代发的请求仍由 ${p.bot} 处理。` +
      `想让聊天框留给 ${p.bot}：/agent mode card`,
    thisChatToo: "（这个聊天现在就按这个来）",
    modeSetCard: (p) => `好的：接入会话后，聊天框留给 ${p.bot}，发给会话用会话卡片上的输入框${p.now}。`,
    modeSetChat: (p) => `好的：接入会话后，聊天框里打的字都发给会话${p.now}。以 @${p.bot} 开头的仍然给我。`,
  },
});
