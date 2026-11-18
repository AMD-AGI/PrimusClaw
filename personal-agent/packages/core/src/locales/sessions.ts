// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import { defineCatalog } from "./catalog.js";

/** `/new`, `/stop`, `/repo`, `/sessions` and the Create PR button. */
export const sessionText = defineCatalog({
  en: {
    newWhileAttached:
      "You are working with an agent on your own machine. `/agent new AGENT PATH` starts another " +
      "session there, and `/agent detach` sends your messages to PrimusClaw again; then `/new` " +
      "starts a fresh PrimusClaw session.",
    stopFailed: (p: { status: number }) => `PrimusClaw could not stop the task (error ${String(p.status)}).`,
    busyStopped: "PrimusClaw is still busy on this session (I have no reply open for it). I sent it a stop.",
    noRepoYet: (p: { usage: string }) => `You have not picked a repository yet. ${p.usage}`,
    tapRepo: "Tap a repository to start a new session in it, or send `/repo owner/name [branch]`.",
    notARepo: (p: { usage: string }) => `I could not read that as a repository. ${p.usage}`,
    repoStopFirst: "A task is still running. Send /stop first, then /repo.",
    repoReady: (p: { repo: string; branch: string }) =>
      `Your next message starts a new session in **${p.repo}** (` +
      (p.branch ? `branch ${p.branch}` : "the default branch") +
      "). PrimusClaw checks the repository out when the task starts, so the first answer takes a little longer. " +
      "`/new` leaves the repository.",
    repoButtonGone: "That button is no longer valid.",
    repoClickStopFirst: "A task is still running. Send /stop first, then tap the repository again.",
    createPrOther:
      "That button belongs to another session. Use /sessions to go back to it, or just ask me to open a pull request.",
    createPrStale:
      "That session cannot be continued any more (it was started before a setting changed), so I cannot open the " +
      "pull request from it. Open it from the console, or tell me what to do in a new message.",
    createPrBusy: "I am still working on your previous message. Send /stop first, then tap Create PR again.",
    showGone: "That button is no longer valid.",
    showBusy: "I am still working on your previous message. Send /stop first, then press the button again.",
    showRefused: "I could not open that session. It may have been deleted, or it is not yours.",
    showFailed: (p: { status: number }) =>
      `PrimusClaw could not show that session (error ${String(p.status)}). Please press the button again in a moment.`,
    showUnreachable: "I could not reach PrimusClaw. Please press the button again in a moment.",
    showNoAnswer: "That session has no finished answer yet. Press the button again when the run has finished.",
    showLead: "Here is the answer. Your next message continues this session.",
    showDone: "The answer is in the chat below. Your next message continues that session.",
    createPrAsking: "Asking the agent to open a pull request. If it needs to push, you will get an approval request.",
  },
  zh: {
    newWhileAttached:
      "You are working with an agent on your own machine. `/agent new AGENT PATH` starts another " +
      "session there, and `/agent detach` sends your messages to PrimusClaw again; then `/new` " +
      "starts a fresh PrimusClaw session.",
    stopFailed: (p) => `PrimusClaw 没能停下这个任务（错误 ${String(p.status)}）。`,
    busyStopped: "PrimusClaw 还在这个会话上忙（我这边没有等着它的回复）。我已经让它停下。",
    noRepoYet: (p) => `你还没有选过仓库。${p.usage}`,
    tapRepo: "点一个仓库，在它里面开始新会话；或者发送 `/repo owner/name [branch]`。",
    notARepo: (p) => `我没法把它当成仓库来读。${p.usage}`,
    repoStopFirst: "还有任务在运行。先发 /stop，再发 /repo。",
    repoReady: (p) =>
      `你的下一条消息会在 **${p.repo}**（` +
      (p.branch ? `分支 ${p.branch}` : "默认分支") +
      "）里开始一个新会话。PrimusClaw 在任务开始时检出仓库，所以第一次回答会慢一点。`/new` 离开这个仓库。",
    repoButtonGone: "这个按钮已经失效了。",
    repoClickStopFirst: "还有任务在运行。先发 /stop，再点一次这个仓库。",
    createPrOther:
      "That button belongs to another session. Use /sessions to go back to it, or just ask me to open a pull request.",
    createPrStale:
      "That session cannot be continued any more (it was started before a setting changed), so I cannot open the " +
      "pull request from it. Open it from the console, or tell me what to do in a new message.",
    createPrBusy: "I am still working on your previous message. Send /stop first, then tap Create PR again.",
    showGone: "That button is no longer valid.",
    showBusy: "I am still working on your previous message. Send /stop first, then press the button again.",
    showRefused: "I could not open that session. It may have been deleted, or it is not yours.",
    showFailed: (p: { status: number }) =>
      `PrimusClaw could not show that session (error ${String(p.status)}). Please press the button again in a moment.`,
    showUnreachable: "I could not reach PrimusClaw. Please press the button again in a moment.",
    showNoAnswer: "That session has no finished answer yet. Press the button again when the run has finished.",
    showLead: "Here is the answer. Your next message continues this session.",
    showDone: "The answer is in the chat below. Your next message continues that session.",
    createPrAsking: "Asking the agent to open a pull request. If it needs to push, you will get an approval request.",
  },
});

/** What the Create PR button asks the agent: an ordinary message, so whatever holds a push or a PR for approval holds it. */
export const CREATE_PR_TEXT =
  "Open a pull request for the changes in this session. If they are not on a branch of their own yet, create " +
  "one, commit the changes to it with a clear message, push it, then run `gh pr create` with a short title and a " +
  "description of what changed, and tell me the PR link.";
