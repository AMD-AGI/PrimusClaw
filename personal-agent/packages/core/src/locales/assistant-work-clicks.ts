// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * What a press on a work card or the board says (teams_agent/assistant.py). The Python worker said these in both languages at once
 * (or in English) whatever the person's language; they are kept so, byte for byte, in both catalogs.
 */
import { defineCatalog } from "./catalog.js";

const fixed = {
  retried: (p: { label: string }) =>
    `已重新开始 ${p.label}，有结果或需要你时我会告诉你。 / Started ${p.label} again; I will tell you when there is news.`,
  tooMany: (p: { label: string }) =>
    `${p.label} 没有重新开始：你进行中的任务已经到上限了，先停掉或接受一个再重试。 / Not started again: ` +
    "you have as many tasks running as you may. Stop or accept one, then retry.",
  notRetryable: (p: { label: string }) =>
    `${p.label} 现在不能重试（只有失败或已停止的任务可以）。 / It cannot be retried now (only a task that failed or was stopped can).`,
  noRetry: "这个版本的 PrimusClaw 还不能重试任务。 / This PrimusClaw cannot retry a task yet.",
  /** A Retry drawn while the stop was recent, pressed after RETRY_STOPPED_SECONDS. */
  stoppedLongAgo: (p: { label: string }) =>
    `${p.label} 停止已超过一小时，看板上的重试已失效；要再做一次，直接告诉我。 / ${p.label} was stopped more than an hour ago, ` +
    "so its Retry has expired; tell me if you want it done again.",
  watching: (p: { pull: string; label: string; short: string }) =>
    `已开启：${p.pull} 上的新评论会自动交给 ${p.label} 处理，并以你的身份直接回复，不再逐条等你批准。可随时关闭：点卡片上的「关闭自动处理」，` +
    `或对我说“别再自动回复 ${p.short} 了”。 / On: new comments on ${p.pull} go to ${p.label}, which answers them as you right away, ` +
    "without asking each time. Turn it off at any time: press Turn off auto-reply, or tell me to stop.",
  watchingAlready: (p: { pull: string; short: string }) =>
    `${p.pull} 的评论自动回复本来就开着：新评论会以你的身份直接回复。可随时关闭：点卡片上的「关闭自动处理」，或对我说“别再自动回复 ${p.short} 了”。` +
    ` / Auto-reply on ${p.pull} was on already. Turn it off at any time: press Turn off auto-reply, or tell me to stop.`,
  unwatched: (p: { label: string; pull: string }) =>
    `已关闭：${p.label} 不再处理 ${p.pull} 上的新评论，也不会再以你的身份回复。 / Off: ${p.label} no longer handles new comments on ${p.pull} ` +
    "and answers nothing more as you.",
  unwatchedAlready: (p: { label: string }) =>
    `${p.label} 现在没有在自动处理 PR 评论，不用关闭。 / ${p.label} is not handling PR comments now; nothing to turn off.`,
  noPull: (p: { label: string }) =>
    `${p.label} 还没有交出 PR，等它的结果里有 PR 再点。 / ${p.label} has not reported a pull request yet.`,
  watchNeedsSignIn:
    "自动回复需要你本人登录确认，这个聊天还没有通过身份服务连接你的账号。 / Answering on GitHub for you needs you signed in " +
    "yourself, and this chat is not connected through the identity service.",
  watchRefused409: (p: { label: string }) =>
    `${p.label} 已经结束，或你同时关注的 PR 已经到上限了。 / The task has ended, or you watch as many pull requests as you may.`,
  watchRefused404:
    "这个版本的 PrimusClaw 还不能自动处理 PR 评论。 / This PrimusClaw cannot follow a pull request's comments yet.",
  watchRefused403:
    "PrimusClaw 要你本人登录确认才允许以你的身份回复。 / PrimusClaw allows answers on GitHub for you only from you, signed in.",
  rejected: "PrimusClaw rejected your linked key (it may have expired or been deleted). Send /unlink, then link again.",
  notFound: "I could not find that task any more. Send /board to see your tasks.",
  notStopped: "The task is closed, but I could not stop its work just now.",
  couldNot: (p: { status: number }) => `PrimusClaw could not do that (error ${String(p.status)}).`,
  reviewEnded: (p: { how: string }) =>
    `这个 review 已经结束了${p.how}，不用再停。 / This review has already ended; there is nothing to stop.`,
  alreadyMerged: (p: { label: string }) =>
    `${p.label} 已经合入了，停不了；我不会自动撤回。 / It is merged already; I do not undo it.`,
  mergeInProgress: (p: { label: string }) =>
    `${p.label} 正在合入，已经停不下来了；合入结果会照常告诉你。 / It is being merged and can no longer be stopped; you will hear how the merge ends.`,
  stoppedReview: (p: { label: string }) => `已停止 ${p.label}。 / Stopped.`,
  stoppedTitle: "已停止 / Stopped",
  done: (p: { verb: string; label: string; version: number | null }) =>
    `${p.verb} ${p.label}${p.version === null ? "." : ` (version ${String(p.version)}).`}`,
  updated: (p: { version: number }) =>
    `The result was updated to version ${String(p.version)} after the card you pressed.`,
  updatedCard: (p: { note: string; version: number }) =>
    `${p.note} The card below is for version ${String(p.version)}.`,
  lookAgain: (p: { note: string }) => `${p.note} Please look at it again.`,
  alreadyClosed: (p: { label: string; outcome: string }) => `${p.label} is already ${p.outcome}.`,
  waitingVersion: (p: { label: string; version: number }) =>
    `${p.label} has a result waiting (version ${String(p.version)}).`,
  waitingForYou: (p: { label: string; question: string }) =>
    `${p.label} is waiting for you${p.question ? `: ${p.question}` : "."}`,
  workedOn: (p: { label: string }) =>
    `${p.label} is being worked on again. I will tell you when there is a new result.`,
  acceptedAll: (p: { n: number; labels: string }) => `已接受 ${String(p.n)} 项：${p.labels}。`,
  acceptedNone: "没有接受任何一项。",
  leftOver: (p: { n: number }) => ` 另有 ${String(p.n)} 项没有接受（结果已更新或已处理），发 /board 看最新状态。`,
};

export const workClickText = defineCatalog({ en: fixed, zh: fixed });
