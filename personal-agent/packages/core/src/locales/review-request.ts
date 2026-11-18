// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * What a group is told about a request to review and merge before anything starts. The worker says these in Chinese
 * whatever the request's language (the request form itself is Chinese: "请 XX 帮我 review 合入 <PR>").
 */

/** The example of a request, addressed to the bot by its name in this deployment (`bot`). */
export const howToAsk = (bot: string): string => `@${bot} 请 XX 帮我 review 合入 <PR>`;

export const reviewRequestText = {
  /** The whole reply to a request that names nobody. */
  askWho: (bot: string) => `请指定由谁来 review 合入，例如 ${howToAsk(bot)}`,
  onePersonPerMessage: (p: { names: string }) =>
    `一条消息只能请同一位 reviewer（这次有 ${p.names}），所以一个也没有开始。请分开发送。`,
  laterLineNamesOthers: (p: { names: string }) =>
    `一条消息里只能请同一位 reviewer（这次还写了 ${p.names}），所以一个也没有开始。请分开发送。`,
  mentionsSeveral: (p: { names: string }) =>
    `一条消息只能请同一位 reviewer（这次提到了 ${p.names}），所以一个也没有开始。请分开发送。`,
  nameNotInMessage: (p: { name: string; bot: string }) =>
    `我没在你的消息里找到「${p.name}」这个人。请写出 reviewer 的名字，例如 ${howToAsk(p.bot)}`,
  unsureWho: (bot: string) => `我不确定你请的是谁，所以没有开始 review。请写出 reviewer 的名字，例如 ${howToAsk(bot)}`,
  unsureWhoFullName: (bot: string) =>
    `我不确定你请的是谁，所以没有开始 review。请写出 reviewer 的全名，例如 ${howToAsk(bot)}`,
  noPullRecognised: (bot: string) =>
    `我没认出要 review 合入哪个 PR，请附上 PR 链接或 owner/repo#编号，例如 ${howToAsk(bot)}`,
  unsureModel: "我不确定你要用哪个模型，请写成 model: <模型名>，或不指定模型。",
} as const;
