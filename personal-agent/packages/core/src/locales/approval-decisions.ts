// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * What a press on an approval or question card is answered with (teams_agent/agent.py `_decide`, `_show_expired`). The Python
 * worker said the lines after the first four in English whatever the person's language; they are kept so, byte for byte.
 */
import { defineCatalog } from "./catalog.js";

const english = {
  pressAgain: "Choose an option or write an answer, then press Send answer.",
  notBound:
    "This chat is not connected to your Primus account through the identity service, so I cannot answer for you. " +
    "Connect in a 1:1 chat with me, then press a button again.",
  exchangeFailed: "I could not reach the Primus platform to answer for you. Press a button again in a moment.",
  notSent: "Your answer was not sent.",
  refused: (p: { answering: boolean; status: number }) =>
    `PrimusClaw did not accept the ${p.answering ? "answer" : "decision"} (error ${String(p.status)}). Press a button again in a moment.`,
  unreachable: "I could not reach PrimusClaw. Please press the button again in a moment.",
  answered: "Answered. The agent goes on with it.",
  decided: (p: { allow: boolean; tool: string }) => `${p.allow ? "Approved" : "Denied"}: ${p.tool}.`,
  questionExpired: "The agent stopped waiting for that answer.",
  approvalExpired: "That approval has run out and was refused.",
  approvalNeeded: (p: { tool: string }) => `Approval needed: ${p.tool}`,
  onlyAskerAnswers: "Only the person who asked can answer this question.",
  onlyAskerDecides: "Only the person who asked can approve or deny this request.",
};

export const decisionText = defineCatalog({
  en: {
    approvalInactive: "That approval request is no longer active.",
    approvalAnswered: "That approval was already answered or has run out.",
    questionInactive: "That question is no longer open.",
    questionAnswered: "That question was already answered or the agent stopped waiting.",
    notConnected:
      "This chat is not connected to a PrimusClaw account (or I could not check it just now). " +
      "Send me a message to see how to connect.",
    ...english,
  },
  zh: {
    approvalInactive: "这个审批请求已经失效了。",
    approvalAnswered: "这个审批已经答复过，或者已经过期了。",
    questionInactive: "这个问题已经关闭了。",
    questionAnswered: "这个问题已经答复过，或者 agent 已经不再等了。",
    notConnected: "这个聊天还没有连上 PrimusClaw 账号（或者我刚才没查到）。给我发一条消息，我告诉你怎么连。",
    ...english,
  },
});
