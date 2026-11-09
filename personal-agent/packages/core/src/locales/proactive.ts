// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The words of what reaches a person unasked, and of an approval once it was answered (teams_agent/render.py event_card,
 * digest_card, approval_card, item_approval_card, item_question_card, decided_card, expired_card, answered_card). The Python
 * worker said all but a work item's request (`_ITEM_WORDS`) in English whatever the language; they are kept so, byte for byte.
 */
import { defineCatalog } from "./catalog.js";

const english = {
  runCompleted: "Run completed",
  runFailed: "Run failed",
  notice: "PrimusClaw",
  failedRef: (p: { ref: string }) => `The run ended with an error (ref ${p.ref}).`,
  showHere: "Show here",
  showHereOf: (p: { title: string }) => `Show here: ${p.title}`,
  openInClaw: "Open in Claw",
  approvalNeeded: (p: { tool: string }) => `Approval needed: ${p.tool}`,
  anAction: "an action",
  validUntil: (p: { until: string; zone: string }) => `Valid until ${p.until} (${p.zone}). After that it is refused.`,
  away: "While you were away",
  nothingNeedsYou: "Nothing needs you.",
  finished: (p: { n: number }) => `${String(p.n)} finished`,
  failed: (p: { n: number }) => `${String(p.n)} failed`,
  expiredApprovals: (p: { n: number }) => `${String(p.n)} approval${p.n !== 1 ? "s" : ""} expired and refused`,
  otherNotices: (p: { n: number }) => `${String(p.n)} other notice${p.n !== 1 ? "s" : ""}`,
  markFailed: "Failed",
  markDone: "Done",
  decided: (p: { allow: boolean; at: string }) => `${p.allow ? "Approved" : "Denied"} (you, ${p.at})`,
  answered: (p: { at: string }) => `Answered (you, ${p.at})`,
  expired: "Expired",
  questionExpired: "The agent stopped waiting for this answer. Tell it in a message if you still want to answer.",
  approvalExpired: (p: { tool: string }) =>
    `${p.tool}: this approval ran out and was refused. Ask the agent to run it again if you still want it.`,
};

export const proactiveText = defineCatalog({
  en: {
    ...english,
    details: "Details",
    task: (p: { seq: string; title: string }) => `Task #${p.seq}: ${p.title}`,
    until: (p: { until: string; zone: string }) =>
      `Waits for you until ${p.until} (${p.zone}). After that it is refused.`,
    asks: (p: { seq: string; title: string }) => `Task #${p.seq}: ${p.title} asks you`,
  },
  zh: {
    ...english,
    details: "详情",
    task: (p) => `任务 #${p.seq}：${p.title}`,
    until: (p) => `等你到 ${p.until}（${p.zone}），过时将被拒绝。`,
    asks: (p) => `任务 #${p.seq}：${p.title} 需要你回答`,
  },
});
