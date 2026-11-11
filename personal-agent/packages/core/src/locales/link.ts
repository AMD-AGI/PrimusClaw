// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import { defineCatalog } from "./catalog.js";

/** Connecting a chat to an account: the `/link` steps, the identity binding, `/link` and `/unlink` outcomes. */
export const linkText = defineCatalog({
  en: {
    linkSteps: (p: { lead: string; bot: string; page: string; notice: string }) =>
      `${p.lead}To use ${p.bot}, connect your PrimusClaw account first. Open this page, sign in, and select Connect ` +
      `Microsoft Teams:\n\n${p.page}\n\n` +
      "You will get a short code; send `/link CODE` here (valid for 10 minutes, works once).\n\n" +
      p.notice,
    platformDown: "I could not reach the Primus platform to check your connection. Please try again in a minute.",
    notConfirmedYet: "I do not see your confirmation yet. ",
    notConfirmedLine:
      "I do not see your confirmation yet. Open the link in the card above and confirm, then press the button again.",
    platformUnreachable: "I could not reach the Primus platform. Please try again in a minute.",
    pressConfirmAgain: " Press Confirm again then.",
    connectTitle: (p: { bot: string }) => `Connect ${p.bot}`,
    connected: "Connected. ",
    runningFromGroup: "I am running your request from the group chat now; the answer will be posted there.",
    getStarted: "Send me a message to get started, or /help for commands.",
    linkedAs: (p: { who: string }) => `Connected${p.who}. If this is not you, send /unlink now.\n\n`,
    tooManyWrong: (p: { minutes: number }) =>
      `Too many wrong codes. Wait ${String(p.minutes)} minute${p.minutes !== 1 ? "s" : ""} and try again.`,
    linkingPaused: "Linking is paused for a few minutes because of too many wrong codes. Please try again later.",
    badCode: "That code is not valid or has expired. Get a new one on the console page.",
    identityRefused: "That needs you in person: confirm your identity once on this card, then ask again.",
  },
  zh: {
    linkSteps: (p) =>
      `${p.lead}要使用 ${p.bot}，请先连上你的 PrimusClaw 账号。打开这个页面，登录后选择 Connect Microsoft Teams：\n\n` +
      `${p.page}\n\n你会拿到一个短码；在这里发 \`/link CODE\`（CODE 换成短码，10 分钟内有效，只能用一次）。`,
    platformDown: "I could not reach the Primus platform to check your connection. Please try again in a minute.",
    notConfirmedYet: "我还没看到你的确认。",
    notConfirmedLine: "我还没看到你的确认。打开上面卡片里的链接确认，然后再按一次按钮。",
    platformUnreachable: "I could not reach the Primus platform. Please try again in a minute.",
    pressConfirmAgain: " Press Confirm again then.",
    connectTitle: (p) => `Connect ${p.bot}`,
    connected: "Connected. ",
    runningFromGroup: "我现在在群聊里运行你的请求，答案会发在那里。",
    getStarted: "给我发条消息就开始，或者发 /help 看我能做什么。",
    linkedAs: (p) => `已连接${p.who}。如果不是你，现在发 /unlink。\n\n`,
    tooManyWrong: (p) =>
      `Too many wrong codes. Wait ${String(p.minutes)} minute${p.minutes !== 1 ? "s" : ""} and try again.`,
    linkingPaused: "Linking is paused for a few minutes because of too many wrong codes. Please try again later.",
    badCode: "That code is not valid or has expired. Get a new one on the console page.",
    identityRefused: "这一步需要你本人：在这张卡片上确认一次身份，然后再说一遍就行。",
  },
});

/** The name the linked key has in SaFE (the console creates it under this name). */
export const LINK_KEY_NAME = "PrimusClaw Teams";

/** `/unlink`. */
export const unlinkText = defineCatalog({
  en: {
    bindingOnly:
      "This chat acts as you through a SaFE identity binding, which only you can remove: " +
      "delete it in SaFE under identity bindings. Until then I keep working for you.",
    deleted: "The API key was deleted.",
    notDeleted: `I could not delete the API key named "${LINK_KEY_NAME}"; please delete it in SaFE under API keys.`,
    stillBound:
      " This chat is still connected through a SaFE identity binding, which only you can remove: " +
      "delete it in SaFE under identity bindings.",
    unlinked: (p: { tail: string }) => `Unlinked. ${p.tail}`,
  },
  zh: {
    bindingOnly:
      "这个聊天通过 SaFE 身份绑定以你的身份工作，只有你能删除这个绑定：在 SaFE 的身份绑定里删除。删除之前我会继续为你工作。",
    deleted: "API key 已删除。",
    notDeleted: `我没能删除 API key "${LINK_KEY_NAME}"; 请在 SaFE 的 API keys 里删除。`,
    stillBound: "这个聊天仍通过 SaFE 身份绑定连着，只有你能删除它：在 SaFE 的身份绑定里删除。",
    unlinked: (p) => `已断开。${p.tail}`,
  },
});
