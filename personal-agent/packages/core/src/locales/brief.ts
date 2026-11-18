// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import { defineCatalog } from "./catalog.js";

/**
 * What `/brief` says, as the Python worker says it. Most of it was English only there; the lines it said in both
 * languages (the state, on, off, the brief that could not be read) keep their Chinese.
 */
const en = {
  unavailable:
    "The daily brief is not available yet: it needs scheduled triggers in PrimusClaw, which are not deployed here. " +
    "I will tell you when it can be turned on.",
  needsKey: "The daily brief needs your linked API key. Connect with `/link CODE` first.",
  usage: (p: { assistant: boolean }) =>
    "Use `/brief on 08:30` (24-hour time, weekdays), `/brief off`, or `/brief` for " +
    (p.assistant ? "today's brief and its schedule." : "status."),
  noTriggers: "The daily brief is not available yet: this PrimusClaw does not have scheduled triggers turned on.",
  tooMany: "You already have the maximum number of scheduled triggers. Remove one first.",
  refused: (p: { status: number }) => `PrimusClaw did not accept that (error ${String(p.status)}).`,
  isOn: (p: { schedule: string; timezone: string }) => `The daily brief is on: ${p.schedule} (${p.timezone}).`,
  isOff: "The daily brief is off. Turn it on with `/brief on 08:30`.",
  unreadable: "The brief could not be read just now (PrimusClaw did not answer); try again in a moment.",
  badTime: "Use a 24-hour time, for example `/brief on 08:30`.",
  onAssistant: (p: { clock: string; timezone: string }) =>
    `Daily brief on: weekdays at ${p.clock} (${p.timezone}), here: your items, watched pull requests, notifications, ` +
    "jobs and SaFE. Send `/brief` for one now; `/brief off` turns it off.",
  onSkill: (p: { clock: string; timezone: string }) =>
    `Daily brief on: weekdays at ${p.clock} (${p.timezone}). It runs as you and only reads. ` +
    "Turn it off with `/brief off`.",
  off: "Daily brief off.",
  wasNotOn: "The daily brief was not on.",
};

export const briefText = defineCatalog({
  en,
  zh: {
    ...en,
    unavailable: "每日简报还用不了：它需要 PrimusClaw 的定时触发器，这里还没部署。能打开时我会告诉你。",
    isOn: (p: { schedule: string; timezone: string }) => `每日简报已开：${p.schedule}（${p.timezone}）。`,
    isOff: "每日简报是关的。用 `/brief on 08:30` 打开。",
    unreadable: "现在拿不到简报（PrimusClaw 没有回应），请稍后再试。",
    onAssistant: (p: { clock: string; timezone: string }) =>
      `每日简报已开：工作日 ${p.clock}（${p.timezone}），到点发到这里：事项、盯着的 PR、通知、作业和 SaFE。` +
      "随时发 `/brief` 先看一份，`/brief off` 关掉。",
    onSkill: (p: { clock: string; timezone: string }) =>
      `每日简报已开：工作日 ${p.clock}（${p.timezone}）。它以你的身份运行，只读。用 \`/brief off\` 关掉。`,
    off: "每日简报已关。",
    wasNotOn: "每日简报本来就没开。",
  },
});
