// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The words of the assistant's cards: a work item's card, the board, a command or a write put to the person
 * (teams_agent/render.py work_card, work_buttons, board_card, board_line, asked_section, action_card, confirm_write_card,
 * work_done_card), and a choice put to the person. What the Python worker said in English whatever the language stays English in
 * both.
 */
import { defineCatalog } from "./catalog.js";

function pick(words: Readonly<Record<string, string>>, key: string, otherwise = ""): string {
  return Object.hasOwn(words, key) ? (words[key] ?? otherwise) : otherwise;
}

const english = {
  /** work_done_card: the version an accepted item was accepted at. */
  version: (p: { version: number }) => `Version ${String(p.version)}`,
  /** work_event_text: a fallback notice that carries no text of its own. */
  needsYou: (p: { label: string }) => `${p.label} needs you.`,
} as const;

export const assistantCardText = defineCatalog({
  en: {
    ...english,
    resultReady: (p: { version: number }) => `Result v${String(p.version)} is ready for you`,
    waiting: "Waiting for you",
    replyForChanges: "Reply here to ask for changes.",
    accept: (p: { version: number }) => `Accept v${String(p.version)}`,
    stop: "Stop",
    watch: "Auto-reply to PR comments",
    unwatch: "Turn off auto-reply",
    watchHint:
      "Auto-reply: once on, new comments on the PR are answered as you automatically; you can turn it off at any time.",
    watchingHint:
      "Auto-reply is on: new PR comments are answered as you. Press Turn off auto-reply, or tell me to stop, at any time.",
    acceptAll: (p: { n: number }) => `Accept all (${String(p.n)})`,
    retry: (p: { seq: number }) => `Retry #${String(p.seq)}`,
    runTitle: "Run this command?",
    run: "Run",
    cancel: "Cancel",
    confirmTitle: "Please confirm",
    confirm: "Confirm",
    deny: "Don't",
    boardTitle: "Your tasks",
    boardWaiting: (p: { n: number }) => `${String(p.n)} waiting for you`,
    boardNothing: "Nothing waits for you",
    column: (p: { state: string }) =>
      pick({ in_progress: "In progress", needs_you: "Needs you", done: "Done" }, p.state),
    badge: (p: { state: string }) =>
      pick({ in_progress: "In progress", needs_you: "Needs you", done: "Done" }, p.state),
    /** board_line: how a done item ended (its outcome as Claw says it, "closed" when none). */
    outcome: (p: { outcome: string }) => p.outcome || "closed",
    ready: (p: { version: number }) => `result v${String(p.version)} is ready`,
    asks: (p: { question: string }) => `asks: ${p.question}`,
    report: (p: { kind: string }) => pick({ failed: "failed", blocked: "blocked" }, p.kind, "needs you"),
    more: (p: { n: number }) => `${String(p.n)} more`,
    older: (p: { n: number }) => `and ${String(p.n)} older`,
    justNow: "just now",
    minutesAgo: (p: { n: number }) => `${String(p.n)} min ago`,
    hoursAgo: (p: { n: number }) => `${String(p.n)} h ago`,
    daysAgo: (p: { n: number }) => `${String(p.n)} d ago`,
    askedTitle: (p: { n: number }) => `Asked of others · ${String(p.n)}`,
    choiceTitle: "Pick one",
    choiceTitleMany: "Pick any that apply",
    choiceSend: "Send",
    choiceTyped: "You can also just reply in the chat.",
    choiceNone: "Pick an option first, then press Send.",
    choiceSent: (p: { answer: string }) => `You picked: ${p.answer}`,
    choiceGone: "This choice is no longer open. Reply in the chat instead.",
    choiceSending: (p: { answer: string }) => `Sending: ${p.answer}. If nothing comes back, reply in the chat instead.`,
    choiceFailed: "That did not go through. Press Send again.",
    /** How the options picked are joined into the person's message. */
    choiceJoin: ", ",
  },
  zh: {
    ...english,
    resultReady: (p) => `结果 v${String(p.version)} 等你确认`,
    waiting: "等你回复",
    replyForChanges: "在这里回复即可要求修改。",
    accept: (p) => `接受 v${String(p.version)}`,
    stop: "停止",
    watch: "开启 PR 评论自动回复",
    unwatch: "关闭自动处理",
    watchHint: "「开启 PR 评论自动回复」：开启后新评论会以你的身份自动回复，可随时关闭。",
    watchingHint:
      "PR 评论自动回复已开启：新评论会以你的身份自动回复。点「关闭自动处理」或对我说“别再自动回复了”随时关闭。",
    acceptAll: (p) => `全部接受（${String(p.n)}）`,
    retry: (p) => `重试 #${String(p.seq)}`,
    runTitle: "要执行这个命令吗？",
    run: "执行",
    cancel: "取消",
    confirmTitle: "需要你确认",
    confirm: "确认",
    deny: "不要",
    boardTitle: "你的事项",
    boardWaiting: (p) => `${String(p.n)} 件等你处理`,
    boardNothing: "没有等你处理的事",
    column: (p) => pick({ in_progress: "进行中", needs_you: "待你处理", done: "已完成" }, p.state),
    // (three characters: a phone's badge holds one line)
    badge: (p) => pick({ in_progress: "进行中", needs_you: "待处理", done: "已完成" }, p.state),
    outcome: (p) =>
      pick({ accepted: "已接受", dropped: "已放弃", stopped: "已停止" }, p.outcome, p.outcome || "已关闭"),
    ready: (p) => `结果 v${String(p.version)} 待接受`,
    asks: (p) => `在问：${p.question}`,
    report: (p) => pick({ failed: "失败了", blocked: "卡住了" }, p.kind, "等你处理"),
    more: (p) => `还有 ${String(p.n)} 条`,
    older: (p) => `以及更早的 ${String(p.n)} 条`,
    justNow: "刚刚",
    minutesAgo: (p) => `${String(p.n)} 分钟前`,
    hoursAgo: (p) => `${String(p.n)} 小时前`,
    daysAgo: (p) => `${String(p.n)} 天前`,
    askedTitle: (p) => `请别人做的代审 · ${String(p.n)}`,
    choiceTitle: "请选择一项",
    choiceTitleMany: "可多选",
    choiceSend: "发送",
    choiceTyped: "也可以直接在聊天里回复。",
    choiceNone: "请先选一项，再点发送。",
    choiceSent: (p) => `你选了：${p.answer}`,
    choiceGone: "这个选择已经失效，请直接在聊天里回复。",
    choiceSending: (p) => `正在发送：${p.answer}。如果一直没有回应，请直接在聊天里回复。`,
    choiceFailed: "没有发出去，请再点一次发送。",
    choiceJoin: "、",
  },
});

/** asked_line: how a review asked of someone else stands, by Claw's word (always English; asked_section translates it). */
export const ASKED_VERDICT: Readonly<Record<string, string>> = {
  approve: "approved",
  request_changes: "changes requested",
  comment: "commented",
};
export const ASKED_WAITING: Readonly<Record<string, string>> = {
  confirm_merge: "merge waits for {who}",
  confirm_review: "the approval waits for {who}",
  failed: "failed: ask again to retry",
  reviewer: "waits for {who}",
};

/** asked_section: the English words of how an asked review stands, in Chinese. */
export const ASKED_STATE_ZH: Readonly<Record<string, string>> = {
  approved: "已批准",
  "changes requested": "要求修改",
  commented: "已评论",
  stopped: "已停止",
  done: "已结束",
  merged: "已合入",
  "not merged": "未合入",
  "being reviewed": "审阅中",
  "failed: ask again to retry": "失败，重新请求即可重试",
};
