// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * What a turn says: its progress view, its plan, its answer's frame and why a turn ended without one. The words are the
 * Python worker's, byte for byte (`turn.py`, `render.py`, `stream.py`).
 */

import { defineCatalog } from "./catalog.js";
import type { Lang } from "./lang.js";

/** Said in the person's language. */
export const turnText = defineCatalog({
  en: {
    /** The progress message's first line. */
    liveHeader: "Working on it...",
    preparing: "Preparing…",
    planHead: (p: { done: number; total: number }) => `**Plan: ${String(p.done)} of ${String(p.total)} done**`,
    planAllDone: (p: { total: number }) => `**Plan: all ${String(p.total)} steps done** ✅`,
    planMore: (p: { n: number; done: number; todo: number }) =>
      `...and ${String(p.n)} more (${String(p.done)} done, ${String(p.todo)} to do)`,
    /** A floating status before anything happened. */
    thinking: "Thinking…",
    /** A turn still running when its stream has to close: the answer follows as a message of its own. */
    stillWorking: "Still working on it; the result will follow as a new message.",
    interrupted: "Interrupted.",
    /** The final message of a stream whose turn ended with nothing to say (it is never empty). */
    doneShort: "Done.",
    /** What a failed turn says; the error itself, and its reference, go to the log only. */
    taskFailed: "The task ran into an error and did not finish. Reply /feedback to tell the PrimusClaw team.",
    openSession: "Open the session",
    queuedNotice:
      "PrimusClaw is still finishing earlier work on this session, so your message is queued and will " +
      "run as soon as that finishes. I will reply here when it is done.",
    stillRunning: (p: { minutes: number }) =>
      `This task is still running in PrimusClaw; I stopped following it here after ${String(p.minutes)} minutes.`,
    stillRunningNotify: " I will message you here when it finishes or needs your approval.",
    stillRunningOpen: " Open the session to follow it.",
  },
  zh: {
    liveHeader: "正在处理…",
    preparing: "准备中…",
    planHead: (p) => `**计划：已完成 ${String(p.done)}/${String(p.total)}**`,
    planAllDone: (p) => `**计划：${String(p.total)} 项已全部完成** ✅`,
    planMore: (p) => `……另有 ${String(p.n)} 项（${String(p.done)} 项已完成，${String(p.todo)} 项待办）`,
    thinking: "思考中…",
    stillWorking: "仍在处理，完成后另发结果。",
    interrupted: "已中断。",
    doneShort: "完成。",
    taskFailed: "任务出错了，没有完成。可以回复 /feedback 告诉 PrimusClaw 团队。",
    openSession: "打开会话",
    queuedNotice: "PrimusClaw 还在这个会话上完成之前的工作，你的消息已排队，它一结束就运行。完成后我在这里回复你。",
    stillRunning: (p) => `任务仍在 PrimusClaw 中运行；我已在 ${String(p.minutes)} 分钟后停止在这里跟踪它。`,
    stillRunningNotify: " 完成或需要你批准时，我会在这里通知你。",
    stillRunningOpen: " 请打开会话查看进展。",
  },
});

/** Suggested replies under a finished answer in a 1:1 chat: (what the button says, what it sends). */
export const SUGGESTED_REPLIES: Readonly<Record<Lang, ReadonlyArray<readonly [string, string]>>> = {
  en: [
    ["Continue", "Continue"],
    ["Tell me more", "Tell me more"],
    ["New session", "/new"],
  ],
  zh: [
    ["继续", "继续"],
    ["详细说说", "详细说说"],
    ["开个新会话", "/new"],
  ],
};

/** Said in English in every chat (the Python worker has them in English only). */
export const turnEnglish = {
  /** The one line the progress message is edited down to where it cannot be deleted. */
  doneLine: "Done — answer below",
  noTextOutput: "Done. There was no text output.",
  shortened: "... (shortened)",
  openFullAnswer: "Open the full answer",
  onlyTheAsker: " (only the person who asked can open it)",
  wholeCutNote: "\n\n… (the rest did not fit in three messages)",
  couldNotLoad: (name: string, count: number) => `Could not load ${name}${count > 1 ? ` (x${String(count)})` : ""}`,
  stopped: "Stopped.",
  lostConnection: "I lost the connection to PrimusClaw before the task finished.",
  openSessionLink: "Open the session",
  keyRejected:
    "PrimusClaw rejected your linked key (it may have expired or been deleted). Send /unlink, then link again.",
  clawBusy: "PrimusClaw is busy right now. Please try again in a minute.",
  clawRequestFailed: (status: number, ref: string) =>
    `PrimusClaw could not take that request (error ${String(status)}, ref ${ref}).`,
  nothingStarted: "Nothing was started.",
  /** Both languages in one line: the group of a review is told, whatever its language. */
  reviewRefused:
    "没能开始 review：请求人的 PrimusClaw 凭据没有被接受，我已私信请求人说明。 / The review did not start: PrimusClaw did not accept the asker's credentials; I told them in their own chat.",
  filesNotPassed: (list: string) => `I could not pass on ${list}.`,
  anImage: "an image",
  aFile: "a file",
  filesNotTaken: "this worker does not take files",
  clawDidNotTake: "Claw did not take it",
  deliveryLine: (name: string, size: string, caption: string, url: string) =>
    `File **${name}** (${size})${caption}: [Download](${url}) (only the person who asked can open it)`,
} as const;
