// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import { defineCatalog } from "./catalog.js";

/** What a group chat is told, in the group's language (`Chat.lang`). */
export const groupText = defineCatalog({
  en: {
    githubOneToOne: "`/github` works only in a 1:1 chat. Please do this in a 1:1 chat with me.",
    oneToOneOnly: (p: { word: string }) =>
      `\`${p.word}\` works only in a 1:1 chat. Please do this in a 1:1 chat with me.`,
    agentInGroup: "In a group, `/agent` does only attach and detach. Use the rest in a 1:1 chat with me.",
    whoami: (p: { name: string; who: string }) => `${p.name || "You"} are connected${p.who}.`,
    whoamiUnknown: "You are connected, but SaFE could not tell me whose account it is.",
    targeted: (p: { bot: string }) =>
      `You sent me a private message in a group chat. I cannot answer privately in a group yet: @mention ${p.bot} ` +
      "there to ask in front of everyone, or ask me here, where only you see the answer.",
    stopUnreachable:
      "I cannot reach PrimusClaw just now, so nothing was stopped. Tell me in our 1:1 chat, or press Stop on its card.",
    stopNone: (p: { number: number }) =>
      `#${String(p.number)}: no review you asked for is going on; tell me in our 1:1 chat.`,
    stopMany: (p: { number: number }) =>
      `#${String(p.number)}: more than one repository has it; write it as owner/repo#${String(p.number)}.`,
  },
  zh: {
    githubOneToOne: "`/github` 只能在 1:1 聊天里用，请在和我的 1:1 聊天里操作。",
    oneToOneOnly: (p) => `\`${p.word}\` 只能在 1:1 聊天里用，请在和我的 1:1 聊天里操作。`,
    agentInGroup: "`/agent` 在群里只能用 attach 和 detach，其余请在 1:1 聊天里用。",
    whoami: (p) => `${p.name || "你"} 已连接到 SaFE 用户 ${p.who}。`,
    whoamiUnknown: "你已连接，但 SaFE 没告诉我是谁的账号。",
    targeted: (p) =>
      `你在群聊里给我发了一条只有我能看到的消息。我暂时还不能在群里私下回答：想让大家都看到，就在群里 @${p.bot}；` +
      "想只让你自己看到，就在这里问我。",
    stopUnreachable: "现在连不上 PrimusClaw，没能停下。请在 1:1 里跟我说，或在事项卡上点「停止」。",
    stopNone: (p) => `#${String(p.number)}：没找到你发起的、还在进行的代审，请在 1:1 里跟我说。`,
    stopMany: (p) => `#${String(p.number)}：有几个仓库都有，请写上仓库，例如 owner/repo#${String(p.number)}。`,
  },
});

/** Group onboarding of a member who has not connected (English only, as in the Python worker). */
export const onboardingText = {
  inactive: "This button is no longer active. Mention me again to get a new one.",
  notYours: (name: string) => `Only ${name || "the person it was made for"} can use this button.`,
  connected: (pending: boolean) =>
    "You are connected. " + (pending ? "Running your request now." : "Mention me again to ask something."),
  stepsSent: (bot: string) =>
    `I sent you the steps in a 1:1 chat with ${bot}. Open it to connect; I run your request here as soon as you are connected.`,
  noDm: (page: string, channel: { readonly name: string; readonly shortName: string }) =>
    `I could not message you directly. Open a 1:1 chat with me in ${channel.shortName} and send me any message there to see how to ` +
    `connect. On a desktop you can also open the page below, sign in, and select Connect ${channel.name}. Send ` +
    `me the \`/link CODE\` it gives you in that chat.\n\n${page}`,
  resuming: (name: string, bot: string) =>
    `${name || "Someone"} connected ${bot}, so I am running their earlier request now.`,
  notResumed: "I could not start your request in the group chat. Mention me there again to run it.",
} as const;
