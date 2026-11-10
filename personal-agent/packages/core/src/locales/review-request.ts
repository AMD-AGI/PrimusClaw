// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * What a group is told about a request to review and merge before anything starts. The worker says these in Chinese
 * whatever the request's language (the request form itself is Chinese: "请 XX 帮我 review 合入 <PR>").
 */
import { BOT_NAME } from "../branding.js";

export const HOW_TO_ASK = `@${BOT_NAME} 请 XX 帮我 review 合入 <PR>`;

export const reviewRequestText = {
  /** The whole reply to a request that names nobody. */
  askWho: `请指定由谁来 review 合入，例如 ${HOW_TO_ASK}`,
  onePersonPerMessage: (p: { names: string }) =>
    `一条消息只能请同一位 reviewer（这次有 ${p.names}），所以一个也没有开始。请分开发送。`,
  laterLineNamesOthers: (p: { names: string }) =>
    `一条消息里只能请同一位 reviewer（这次还写了 ${p.names}），所以一个也没有开始。请分开发送。`,
  mentionsSeveral: (p: { names: string }) =>
    `一条消息只能请同一位 reviewer（这次提到了 ${p.names}），所以一个也没有开始。请分开发送。`,
  nameNotInMessage: (p: { name: string }) =>
    `我没在你的消息里找到「${p.name}」这个人。请写出 reviewer 的名字，例如 ${HOW_TO_ASK}`,
  unsureWho: `我不确定你请的是谁，所以没有开始 review。请写出 reviewer 的名字，例如 ${HOW_TO_ASK}`,
  unsureWhoFullName: `我不确定你请的是谁，所以没有开始 review。请写出 reviewer 的全名，例如 ${HOW_TO_ASK}`,
  noPullRecognised: `我没认出要 review 合入哪个 PR，请附上 PR 链接或 owner/repo#编号，例如 ${HOW_TO_ASK}`,
  unsureModel: "我不确定你要用哪个模型，请写成 model: <模型名>，或不指定模型。",
} as const;
