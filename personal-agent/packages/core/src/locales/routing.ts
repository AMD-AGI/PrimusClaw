// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import { defineCatalog } from "./catalog.js";

/** The router's fixed replies (the Python `agent.py` constants and their `ZH` translations). */
export const routingText = defineCatalog({
  en: {
    notConnected:
      "This chat is not connected to a PrimusClaw account (or I could not check it just now). " +
      "Send me a message to see how to connect.",
    onlyChats: "I only work in a one-to-one chat or a group chat. Open a chat with me directly.",
    stillWorking: "I am still working on your previous message. Send /stop to interrupt it.",
    queuedBehind: (p: { n: number }) =>
      (p.n === 1
        ? "Got it. I am still working on your previous message; this one is queued and runs as soon as that is done."
        : `Got it. This one is queued as number ${String(p.n)}; they run in order once your previous message is done.`) +
      " /stop stops the running task and drops what is queued.",
    queueFull: (p: { n: number }) =>
      `${String(p.n)} messages already wait behind the running task, so this one was not queued. Send it once they have ` +
      "run, or /stop to stop the running task and drop the queue.",
    queueDropped: (p: { n: number }) =>
      p.n === 1
        ? " The message queued behind it was dropped too."
        : ` The ${String(p.n)} messages queued behind it were dropped too.`,
    unlinkAsk:
      "`unlink` would disconnect this chat from your PrimusClaw account and delete the API key it uses. If you mean it, " +
      "send `/unlink`; otherwise nothing has changed.",
    nothingRunning: "Nothing is running.",
    noSessions: "There are no earlier sessions in this chat yet. Send me a message to start one.",
    sessionsUnreachable: "I could not check your sessions just now. Please try again in a minute.",
    sessionsLead: "Your last sessions. Show here puts one back as this chat's session, with everything it remembers.",
    stopping: "Stopping the running task.",
    stopFirst: "A task is still running. Send /stop first, then /new.",
    newSession: "Started a new session. What would you like to do?",
    notFinished: "I could not finish that. Please send me a message to carry on.",
    buttonInactive: "That button is not active any more.",
    dmLead: "You mentioned me in a group chat. ",
    stopPressed: "Stop was pressed.",
    stopTurnOver: "That turn has already ended, so nothing was stopped.",
  },
  zh: {
    notConnected: "这个聊天还没有连上 PrimusClaw 账号（或者我刚才没查到）。给我发一条消息，我告诉你怎么连。",
    onlyChats: "I only work in a one-to-one chat or a group chat. Open a chat with me directly.",
    stillWorking: "我还在处理你上一条消息。发 /stop 可以打断它。",
    queuedBehind: (p) =>
      (p.n === 1
        ? "收到。我还在处理你上一条消息，这条已排在后面，上一条处理完就接着处理它。"
        : `收到。这条已排队（第 ${String(p.n)} 条），上一条处理完后按顺序处理。`) +
      "发 /stop 会停下正在运行的任务，并撤回排队的消息。",
    queueFull: (p) =>
      `正在运行的任务后面已经排了 ${String(p.n)} 条消息，这条没有排上。等前面的处理完再发，或者发 /stop 停下并清空排队。`,
    queueDropped: (p) =>
      p.n === 1 ? "排在后面的那条消息也一起撤回了。" : `排在后面的 ${String(p.n)} 条消息也一起撤回了。`,
    unlinkAsk:
      "`unlink` 会断开这个聊天和你的 PrimusClaw 账号的连接，并删除它用的 API key。确定的话发 `/unlink`；否则什么都没变。",
    nothingRunning: "现在没有在运行的任务。",
    noSessions: "这个聊天里还没有之前的会话。给我发条消息就开始一个。",
    sessionsUnreachable: "我刚才查不到你的会话。请过一分钟再试。",
    sessionsLead: "你最近的会话。点 Show here 把它放回这个聊天，它记得的都还在。",
    stopping: "正在停止运行中的任务。",
    stopFirst: "还有任务在运行。先发 /stop，再发 /new。",
    newSession: "已开始新会话。要做什么？",
    notFinished: "这件事我没能做完。给我发条消息就能接着来。",
    buttonInactive: "这个按钮已经失效了。",
    dmLead: "你在群聊里 @ 了我。",
    stopPressed: "已按下「停止」。",
    stopTurnOver: "这一轮已经结束了，没有停止任何东西。",
  },
});
