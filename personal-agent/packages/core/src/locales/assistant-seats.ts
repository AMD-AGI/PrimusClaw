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
