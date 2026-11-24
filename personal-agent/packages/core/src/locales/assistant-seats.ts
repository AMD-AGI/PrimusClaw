// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/** What came of a press on a seat card (`seat_role`: Claw's guess of what a seat is for; `seat_set`: the person's own words). */
import { defineCatalog } from "./catalog.js";

export const seatOutcomeText = defineCatalog({
  en: {
    kept: (p: { what: string }) => (p.what ? `Kept: ${p.what}.` : "Kept."),
    alreadyAnswered: "That card was already answered.",
    retired: "OK, that seat is marked as not to be used.",
    denied: "OK, nothing changed.",
    expired: "That card has expired; nothing changed.",
    stale: "That guess was replaced (or the seat retired) since the card was made; nothing was kept.",
    gone: "That seat is no longer there; nothing was kept.",
    failed: (p: { why: string }) => `It could not be kept (${p.why}).`,
  },
  zh: {
    kept: (p) => (p.what ? `记下了：${p.what}。` : "记下了。"),
    alreadyAnswered: "这张卡已经处理过了。",
    retired: "好的，这个工位标记为不再使用。",
    denied: "好的，什么都没改。",
    expired: "这张卡已过期，什么都没改。",
    stale: "这张卡之后猜测已更新（或工位已停用），什么都没记下。",
    gone: "这个工位已经不在了，什么都没记下。",
    failed: (p) => `没能记下（${p.why}）。`,
  },
});

/**
 * A task the assistant hands to a seat (`seat_dispatch`): its card (one place, or a choice of several places) and what came of a
 * press on it, in one line.
 */
export const seatDispatchText = defineCatalog({
  en: {
    choiceTitle: "Where should this go?",
    cancel: "Cancel",
    sent: (p: { who: string; seq: string }) => (p.seq ? `Sent to ${p.who} as #${p.seq}.` : `Sent to ${p.who}.`),
    queued: (p: { who: string; why: string; seq: string; position: string; ahead: string }) =>
      `${p.who} ${p.why}: ${p.seq ? `#${p.seq}` : "it"} waits in line` +
      (p.position ? ` (number ${p.position}${p.ahead ? `, after ${p.ahead}` : ""})` : "") +
      " and goes out when it is free.",
    busy: "is busy",
    inTerminal: "is in use in your terminal",
    offline: "is offline (it waits a day at most)",
    theSeat: "the seat",
    notSent: "OK, not sent.",
    alreadyAnswered: "That card was already answered.",
    expired: "That card has expired; nothing was sent.",
    notOnCard: "That choice is not on this card; nothing was sent.",
    failed: (p: { why: string }) => `Not sent (${p.why}).`,
  },
  zh: {
    choiceTitle: "交给哪里？",
    cancel: "取消",
    sent: (p) => (p.seq ? `已交给 ${p.who}，事项 #${p.seq}。` : `已交给 ${p.who}。`),
    queued: (p) =>
      `${p.who} ${p.why}：${p.seq ? `#${p.seq} ` : ""}排队，空下来再发` +
      (p.position ? `（第 ${p.position} 位${p.ahead ? `，前面是 ${p.ahead}` : ""}）` : "") +
      "。",
    busy: "正忙",
    inTerminal: "正在你的终端里用",
    offline: "所在机器不在线（最多等 24 小时）",
    theSeat: "这个工位",
    notSent: "好的，没有发出。",
    alreadyAnswered: "这张卡已经处理过了。",
    expired: "这张卡已过期，没有发出。",
    notOnCard: "这张卡上没有这个选项，没有发出。",
    failed: (p) => `没有发出（${p.why}）。`,
  },
});

/** Why Claw did not send a task to a seat (`result.error` of a `seat_dispatch` decision), as the person reads it. */
export const SEAT_DISPATCH_FAILED: Readonly<Record<string, Readonly<Record<"en" | "zh", string>>>> = {
  seat_not_found: { en: "That seat is no longer there; nothing was sent.", zh: "这个工位已经不在了，没有发出。" },
  seat_retired: { en: "That seat is no longer used; nothing was sent.", zh: "这个工位已停用，没有发出。" },
  seat_unsupported: {
    en: "The agent at that seat cannot take tasks yet (its connector needs an update); nothing was sent.",
    zh: "这个工位上的 agent 还不能接活（connector 需要升级），没有发出。",
  },
  seat_queue_full: {
    en: "Three tasks already wait for that seat; nothing was sent. Say whether to wait, use the sandbox, or another seat.",
    zh: "这个工位前面已经排了 3 件，没有发出。可以说等一等、改交沙箱或换个工位。",
  },
  too_many_active_items: {
    en: "Too many tasks are running now; nothing was sent.",
    zh: "进行中的事项已达上限，没有发出。",
  },
  invalid_choice: { en: "That choice is not on this card; nothing was sent.", zh: "这张卡上没有这个选项，没有发出。" },
  not_enabled: { en: "Sending tasks to seats is off; nothing was sent.", zh: "派活给工位的功能已关闭，没有发出。" },
  item_closed: { en: "That task was stopped or closed; nothing was sent.", zh: "这件事已经停了或关了，没有发出。" },
  no_credentials: {
    en: "The sandbox cannot be started for you now; nothing was sent.",
    zh: "现在没法为你启动沙箱，没有发出。",
  },
};
