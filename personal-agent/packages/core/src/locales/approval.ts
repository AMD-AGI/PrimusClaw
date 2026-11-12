// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/** The words of approval and question cards (teams_agent/approval_view.py `_TEXT`, render.py question_card). */
import { defineCatalog } from "./catalog.js";

export const approvalText = defineCatalog({
  en: {
    title: "Approval needed",
    titleGroup: "Approval needed",
    action: "Action",
    reason: "Reason",
    model: "Summary written by the model. Check it against the details below.",
    said: "The agent said",
    more: (p: { n: number }) => `+${String(p.n)} more field(s) in Details`,
    details: "Details",
    rule: (p: { label: string }) => `Held by a rule: ${p.label}`,
    only: (p: { who: string }) =>
      `Only ${p.who} can approve or deny this. The details are in their PrimusClaw session.`,
    asker: "the person who asked",
    fallbackTool: "an action",
    sep: ": ",
    allow: "Approve",
    deny: "Deny",
    questionTitle: "The agent has a question",
    questionOr: "Or answer in your own words",
    questionYours: "Your answer",
    questionOnly: (p: { who: string }) => `Only ${p.who} can answer.`,
    questionAsker: "the person who asked",
    send: "Send answer",
    /** Under a question card's questions: a client that does not show the card can still answer. */
    questionReply: "You can also just reply in the chat with your choice.",
    /** A question card once a message typed in the chat answered it. */
    questionReplied: (p: { answer: string }) => `Answered: ${p.answer}`,
    questionRepliedAt: (p: { at: string }) => `Replied in the chat, ${p.at}`,
  },
  zh: {
    title: "需要你批准",
    titleGroup: "需要批准",
    action: "操作",
    reason: "理由",
    model: "以上摘要由模型生成，请对照下面的参数核对。",
    said: "助手说",
    more: (p) => `另有 ${String(p.n)} 项参数，见详情`,
    details: "详情",
    rule: (p) => `触发规则：${p.label}`,
    only: (p) => `只有${p.who}可以批准或拒绝，详情在其 PrimusClaw 会话里。`,
    asker: "发起人",
    fallbackTool: "一项操作",
    sep: "：",
    allow: "批准",
    deny: "拒绝",
    questionTitle: "需要你回答",
    questionOr: "或者直接写你的回答",
    questionYours: "你的回答",
    questionOnly: (p) => `只有${p.who}可以回答。`,
    questionAsker: "发起人",
    send: "发送回答",
    questionReply: "也可以直接在聊天里回复选项。",
    questionReplied: (p) => `已回答：${p.answer}`,
    questionRepliedAt: (p) => `在聊天里回复，${p.at}`,
  },
});
