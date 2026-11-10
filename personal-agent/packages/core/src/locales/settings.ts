// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import { defineCatalog } from "./catalog.js";

/** `/timezone`, `/quiet`, `/pause` and `/resume`. */
export const settingsText = defineCatalog({
  en: {
    zoneIs: (p: { zone: string }) =>
      `Your time zone is ${p.zone}. Change it with \`/timezone Area/City\`, e.g. \`/timezone America/Los_Angeles\`.`,
    zoneUnknown: (p: { name: string }) =>
      `I do not know the time zone "${p.name}". Use an IANA name such as \`Asia/Shanghai\` or \`America/Los_Angeles\`.`,
    zoneSet: (p: { zone: string }) => `Time zone set to ${p.zone}.`,
    quietState: (p: { start: string; end: string; zone: string }) => `Quiet hours are ${p.start}-${p.end} (${p.zone}).`,
    quietOffState: "Quiet hours are off.",
    quietShow: (p: { state: string }) =>
      `${p.state} During quiet hours notices are held for one summary and approvals are not ` +
      "pushed. Change them with `/quiet 22:00-08:00` or `/quiet off`.",
    quietOff:
      "Quiet hours are off. Notices and approvals reach you at any time. Use `/pause` to hold everything for a while.",
    quietUsage: "Use a 24-hour window such as `/quiet 22:00-08:00`, or `/quiet off`.",
    quietSet: (p: { start: string; end: string; zone: string }) =>
      `Quiet hours set to ${p.start}-${p.end} (${p.zone}). Notices are held ` +
      "and sent as one summary afterwards; approvals are not pushed, and one that runs " +
      "out is refused. Change the time zone with `/timezone`.",
    pauseForever: "until you send /resume",
    pauseUntil: (p: { weekday: string; clock: string; month: string; day: string; zone: string }) =>
      `until ${p.weekday} ${p.clock} (${p.zone})`,
    pauseUsage:
      "Use a duration such as `/pause 2h`, `/pause 30m` or `/pause 1d` (at most 30 days), " +
      "or `/pause` alone to pause until `/resume`.",
    paused: (p: { until: string }) =>
      `Paused ${p.until}. Nothing is pushed meanwhile, and approvals are not shown: one that runs ` +
      "out is refused. Notices are kept and sent as one summary afterwards.",
    resumed: "Resumed.",
    notPaused: "You were not paused.",
    stillQuiet: (p: { start: string; end: string }) =>
      ` Quiet hours (${p.start}-${p.end}) still apply; held notices arrive when they end.`,
  },
  zh: {
    zoneIs: (p) => `你的时区是 ${p.zone}。用 \`/timezone 区域/城市\` 修改，例如 \`/timezone Asia/Shanghai\`。`,
    zoneUnknown: (p) =>
      `我不认识时区「${p.name}」。请用 IANA 名字，例如 \`Asia/Shanghai\` 或 \`America/Los_Angeles\`。`,
    zoneSet: (p) => `时区已设为 ${p.zone}。`,
    quietState: (p) => `免打扰时段是 ${p.start}-${p.end}（${p.zone}）。`,
    quietOffState: "免打扰已关闭。",
    quietShow: (p) =>
      `${p.state}免打扰期间通知先攒着、结束后一起发，审批不推送。用 \`/quiet 22:00-08:00\` 或 \`/quiet off\` 修改。`,
    quietOff: "免打扰已关闭。通知和审批随时会发给你。想暂时都别发，用 `/pause`。",
    quietUsage: "请用 24 小时制时段，例如 `/quiet 22:00-08:00`，或 `/quiet off`。",
    quietSet: (p) =>
      `免打扰时段设为 ${p.start}-${p.end}（${p.zone}）。期间通知先攒着、结束后一起发；` +
      "审批不推送，过期的会被拒绝。用 `/timezone` 改时区。",
    pauseForever: "直到你发 /resume",
    pauseUntil: (p) => `到 ${p.month}-${p.day} ${p.clock}（${p.zone}）`,
    pauseUsage:
      "请给一个时长，例如 `/pause 2h`、`/pause 30m` 或 `/pause 1d`（最多 30 天），或只发 `/pause` 暂停到 `/resume`。",
    paused: (p) => `已暂停，${p.until}。期间什么都不推送，审批也不显示：过期的会被拒绝。通知会留着，之后一起发。`,
    resumed: "已恢复。",
    notPaused: "你没有暂停。",
    stillQuiet: (p) => `免打扰时段（${p.start}-${p.end}）仍然有效；攒着的通知在它结束时发给你。`,
  },
});
