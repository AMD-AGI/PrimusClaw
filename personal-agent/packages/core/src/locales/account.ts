// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import { defineCatalog } from "./catalog.js";

/** `/whoami`, `/memory`, `/lang` and the first lines of help. */
export const accountText = defineCatalog({
  en: {
    connectedTo: (p: { name: string; email: string }) =>
      `Connected to SaFE user ${p.name}` + (p.email ? ` (${p.email})` : "") + ".",
    whoamiFirst: (p: { name: string; email: string }) =>
      `This chat is connected to SaFE user ${p.name}` +
      (p.email ? ` (${p.email})` : "") +
      ". If this is not you, send /unlink.",
    whoamiUnknown:
      "This chat is connected, but SaFE could not tell me whose account it is. If you do not recognise it, send /unlink.",
    whoamiBound: (p: { name: string; email: string }) =>
      `This chat is connected to SaFE user ${p.name}` +
      (p.email ? ` (${p.email})` : "") +
      " through a SaFE identity binding. If this is not you, ask that account's owner to delete the binding in SaFE " +
      "under identity bindings; /unlink cannot remove it.",
    whoamiBoundUnknown:
      "This chat is connected through a SaFE identity binding, but SaFE could not tell me whose account it is. If you do " +
      "not recognise it, ask your SaFE administrator to have the binding deleted; /unlink cannot remove it.",
    memoryUnreadable: (p: { page: string }) =>
      `I could not read your memory settings right now. You can manage them at ${p.page}`,
    memoryUnavailable: "Memory is not available on this deployment.",
    memoryOff: (p: { page: string }) =>
      `Memory is **off**: I do not remember anything between sessions. Turn it on, or see what is stored, at ${p.page}`,
    nothingRemembered: "- (nothing remembered yet)",
    memoryOn: (p: { lines: string; page: string }) =>
      'Memory is **on** (on by default; say "turn memory off" or send `/memory off` to turn it off). ' +
      `Latest items:\n${p.lines}\n\nSee all or delete at ${p.page}`,
    memoryUsage: "Use `/memory on` to turn memory on, `/memory off` to turn it off, or `/memory` alone to see it.",
    memoryNotChanged: (p: { page: string }) =>
      `I could not change your memory setting just now. You can change it at ${p.page}`,
    memoryTurnedOn: (p: { page: string }) =>
      `Memory is **on**: from now on I remember what you ask me to and what is useful about you. See or delete it at ${p.page}`,
    memoryTurnedOff: (p: { page: string }) =>
      "Memory is **off**: I no longer remember or read anything between sessions. What was stored stays until you " +
      `delete it at ${p.page}`,
    langChosen: (p: { lang: string }) =>
      p.lang === "zh"
        ? "好的，以后用中文回复你。发 `/lang auto` 改回按你写的话自动选。"
        : "OK, I answer you in English from now on. Send `/lang auto` to have it follow what you write again.",
    langUsage: "Use `/lang zh`, `/lang en` or `/lang auto`.",
    langWhySet: "you set it",
    langWhyWritten: "from what you last wrote",
    langWhyClient: (p: { channel: string }) => `from your ${p.channel} client's language`,
    langIs: (p: { name: string; why: string }) =>
      `I answer you in ${p.name} (${p.why}). Change it with \`/lang zh\` or \`/lang en\`; \`/lang auto\` follows what you write.`,
  },
  zh: {
    connectedTo: (p) => `已连接到 SaFE 用户 ${p.name}` + (p.email ? `（${p.email}）` : "") + "。",
    whoamiFirst: (p) =>
      `这个聊天已连接到 SaFE 用户 ${p.name}` + (p.email ? `（${p.email}）` : "") + "。如果不是你，现在发 /unlink。",
    whoamiUnknown: "这个聊天已连接，但 SaFE 没告诉我是谁的账号。如果你不认识它，发 /unlink。",
    whoamiBound: (p) =>
      `这个聊天通过 SaFE 身份绑定连接到 SaFE 用户 ${p.name}` +
      (p.email ? `（${p.email}）` : "") +
      "。如果不是你，请让这个账号的主人在 SaFE 的身份绑定里删除这个绑定；发 /unlink 删不掉它。",
    whoamiBoundUnknown:
      "这个聊天通过 SaFE 身份绑定连接，但 SaFE 没告诉我是谁的账号。如果你不认识它，请找 SaFE 管理员删除这个绑定；发 /unlink 删不掉它。",
    memoryUnreadable: (p) => `我现在读不到你的记忆设置。可以在这里管理：${p.page}`,
    memoryUnavailable: "这个部署没有记忆功能。",
    memoryOff: (p) => `记忆是**关**的：会话之间我什么都不记。打开它或查看存了什么：${p.page}`,
    nothingRemembered: "- （还没有记住什么）",
    memoryOn: (p) =>
      `记忆是**开**的（默认开启，说“关闭记忆”或发 \`/memory off\` 可关）。最近的条目：\n${p.lines}\n\n查看全部或删除：${p.page}`,
    memoryUsage: "用 `/memory on` 打开记忆、`/memory off` 关闭，只发 `/memory` 看现在的状态。",
    memoryNotChanged: (p) => `我现在没能改你的记忆设置。可以在这里改：${p.page}`,
    memoryTurnedOn: (p) => `记忆已**打开**：之后的会话里我会记住你让我记的、以及对你有用的事。查看或删除：${p.page}`,
    memoryTurnedOff: (p) =>
      `记忆已**关闭**：会话之间我不再记住或读取任何东西；已经存的条目还在，可以在这里删除：${p.page}`,
    langChosen: (p) =>
      p.lang === "zh"
        ? "好的，以后用中文回复你。发 `/lang auto` 改回按你写的话自动选。"
        : "OK, I answer you in English from now on. Send `/lang auto` to have it follow what you write again.",
    langUsage: "用 `/lang zh`、`/lang en` 或 `/lang auto`。",
    langWhySet: "你设定的",
    langWhyWritten: "按你最近写的话",
    langWhyClient: (p) => `按你的 ${p.channel} 客户端语言`,
    langIs: (p) => `我用${p.name}回复你（${p.why}）。改：\`/lang zh\`、\`/lang en\`，\`/lang auto\` 按你写的话自动选。`,
  },
});

/** The languages' names: [Chinese, English]. */
export const LANG_NAMES: Readonly<Record<"zh" | "en", readonly [string, string]>> = {
  zh: ["中文", "Chinese"],
  en: ["英文", "English"],
};

/** `/memory on|off` in the words people use for it. */
export const MEMORY_SWITCH: Readonly<Record<string, boolean>> = {
  on: true,
  开: true,
  打开: true,
  开启: true,
  enable: true,
  off: false,
  关: false,
  关闭: false,
  disable: false,
};
