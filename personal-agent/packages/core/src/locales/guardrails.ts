// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import { defineCatalog } from "./catalog.js";

/** What a person is told (the operation names are keyed by `SensitiveOperation`) when a per-person limit of an operation that acts with their authority refused it. */
export const guardrailsText = defineCatalog({
  en: {
    pr_review: "reviews started",
    pr_merge: "merges confirmed",
    approval: "approvals",
    remote_agent: "switches to a mode that does not ask",
    hours: (p: { n: number }) => (p.n === 1 ? "hour" : `${String(p.n)} hours`),
    minutes: (p: { n: number }) => (p.n === 1 ? "minute" : `${String(p.n)} minutes`),
    seconds: (p: { n: number }) => `${String(p.n)} seconds`,
    refused: (p: { count: number; what: string; window: string; minutes: number }) =>
      `You have reached the limit of ${String(p.count)} ${p.what} per ${p.window} for one person, so this was not done. ` +
      `Try again in ${String(p.minutes)} minute${p.minutes !== 1 ? "s" : ""}; if you really need more, ask the operator to raise the limit.`,
  },
  zh: {
    pr_review: "次 review",
    pr_merge: "次合入确认",
    approval: "次审批",
    remote_agent: "次切换到免审批模式",
    hours: (p) => `${String(p.n)} 小时`,
    minutes: (p) => `${String(p.n)} 分钟`,
    seconds: (p) => `${String(p.n)} 秒`,
    refused: (p) =>
      `你在${p.window}内已经有 ${String(p.count)} ${p.what}，达到了每人的上限，所以这次没有执行。` +
      `请 ${String(p.minutes)} 分钟后再试；如果确实需要更多，请联系管理员调整上限。`,
  },
});
