// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import { defineCatalog } from "./catalog.js";

/** What a person is told when a per-person limit refused a message or a task (`limits/`). */
export const limitsText = defineCatalog({
  en: {
    /** `s`: "s" when more than one message was dropped (or ""); `wait`: `waitWords`. */
    rateLimited: (p: { s: string; wait: string }) =>
      `You are sending messages faster than I can take them, so I did not pass on your last message${p.s}. Wait ` +
      `${p.wait} and send it again. If a task is running and you want it to end, send /stop (it always works).`,
    /** `what`: what was not started, with its leading space (or ""). */
    concurrencyLimited: (p: { running: number; what: string }) =>
      `You already have ${String(p.running)} tasks running, which is the most I run at the same time for one person, so I ` +
      `did not start this one${p.what}. Send it again when one of them has finished, or send /stop in that chat to ` +
      "end it.",
    seconds: (p: { n: number }) => `${String(p.n)} second${p.n !== 1 ? "s" : ""}`,
    minutes: (p: { n: number }) => `${String(p.n)} minutes`,
  },
  zh: {
    rateLimited: (p) =>
      `你发消息太快了，我没有转交你刚才的消息。请等${p.wait}再发一次。要结束正在运行的任务，发 /stop（它总是有效）。`,
    concurrencyLimited: (p) =>
      `你已经有 ${String(p.running)} 个任务在运行，这是我同时为一个人运行的上限，所以这一个${p.what}没有开始。等其中一个完成后再发，` +
      "或者在那个聊天里发 /stop 结束它。",
    seconds: (p) => ` ${String(p.n)} 秒`,
    minutes: (p) => ` ${String(p.n)} 分钟`,
  },
});
