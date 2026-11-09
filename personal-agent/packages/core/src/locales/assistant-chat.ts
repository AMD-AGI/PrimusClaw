// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * What the chat says about the assistant itself (teams_agent/assistant.py, commands.py ASSISTANT_NO_*). The Python worker said
 * most of these in English (or in both languages at once) whatever the person's language; they are kept so, byte for byte.
 */
import { defineCatalog } from "./catalog.js";

const fixed = {
  unavailable: "I cannot reach your assistant just now. Please send that again in a moment.",
  rejected: "PrimusClaw rejected your linked key (it may have expired or been deleted). Send /unlink, then link again.",
  stopFailed: "I could not reach your assistant just now. Please try again in a moment.",
  stopped: "Stopped what I was doing. ",
  notBusy: "I am not busy right now. ",
  stopHint: 'To stop a task, say "stop #2" (its number from /board), or press Stop under its card.',
  noSessions:
    "I keep one conversation with you and start a separate task for each thing you ask, so there are no " +
    "sessions to start or switch. Just tell me what you need; `/board` shows your tasks.",
  noRepo:
    'Just say which repository you mean in your message, for example "in AMD-AGI/PrimusClaw, fix the failing ' +
    'test", and I will work in it.',
  notTaken: "this worker does not take files",
  clawRefused: "Claw did not take it",
  anImage: "an image",
};

export const assistantChatText = defineCatalog({
  en: {
    notUnderstood:
      "I cannot reach your assistant just now, so that message was not handled: please send it again in a moment. " +
      "Commands such as /board and /help, and the buttons on cards, still work.",
    filesOnly: "(sent files, with no message)",
    ...fixed,
  },
  zh: {
    notUnderstood:
      "暂时连不上你的助理，这条消息没有处理，请稍后再发一次。斜杠命令（如 /board、/help）和卡片上的按钮照常可用。",
    filesOnly: "（发来了文件，没有附言）",
    ...fixed,
  },
});
