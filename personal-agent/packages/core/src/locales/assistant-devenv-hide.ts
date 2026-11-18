// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/** What came of a press on a hide card (`devenv_hide`: conversations hidden from /agents), teams_agent/agent.py devenv_hide_outcome. */
import { defineCatalog } from "./catalog.js";

export const devenvHideText = defineCatalog({
  en: {
    hidden: (p: { n: number }) => `hid ${String(p.n)} conversations`,
    shownAgain: (p: { n: number }) => `showed ${String(p.n)} again`,
    disconnected: (p: { n: number }) => `disconnected ${String(p.n)} sessions`,
    /** The way back is said only when something was hidden: after showing again, or disconnecting, nothing is to bring back. */
    done: (p: { parts: readonly string[]; hidden: boolean }) =>
      `Done: ${p.parts.join(", ")}. Send /agents to see${p.hidden ? "; say “show hidden sessions” to bring them back" : ""}.`,
    nothing: "Done; nothing needed changing.",
    alreadyAnswered: "That card was already answered.",
    denied: "OK, nothing changed.",
    expired: "That card has expired; nothing changed.",
    failed: (p: { why: string }) => `It could not be done (${p.why}).`,
  },
  zh: {
    hidden: (p) => `隐藏了 ${String(p.n)} 段对话`,
    shownAgain: (p) => `恢复显示 ${String(p.n)} 段`,
    disconnected: (p) => `断开 ${String(p.n)} 个会话`,
    done: (p) => `好了：${p.parts.join("，")}。发 /agents 看看${p.hidden ? "；说“显示隐藏的会话”可以恢复" : ""}。`,
    nothing: "已处理，没有需要改的。",
    alreadyAnswered: "这张卡已经处理过了。",
    denied: "好的，什么都没改。",
    expired: "这张卡已过期，什么都没改。",
    failed: (p) => `没能完成（${p.why}）。`,
  },
});
