// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import { defineCatalog } from "./catalog.js";

/** The command usage texts. */
export const commandText = defineCatalog({
  en: {
    repoUsage:
      "Use `/repo owner/name [branch]`, for example `/repo AMD-AGI/PrimusClaw main`. " +
      "`/repo` alone lists the repositories you used last.",
    /**
     * With the assistant on there is one conversation and a task of its own for each thing asked: no session to start,
     * list or choose, and no repository to bind to a session.
     */
    assistantNoSessions:
      "I keep one conversation with you and start a separate task for each thing you ask, so there are no " +
      "sessions to start or switch. Just tell me what you need; `/board` shows your tasks.",
    assistantNoRepo:
      'Just say which repository you mean in your message, for example "in AMD-AGI/PrimusClaw, fix the failing ' +
      'test", and I will work in it.',
  },
  zh: {
    repoUsage:
      "用法：`/repo owner/name [branch]`，例如 `/repo AMD-AGI/PrimusClaw main`。只发 `/repo` 会列出你最近用过的仓库。",
    assistantNoSessions:
      "我和你只保持一个对话，你让我做的每件事都会单独开一个任务，所以没有会话需要新建或切换。直接告诉我要做什么；" +
      "`/board` 可以看你的任务。",
    assistantNoRepo:
      "在消息里直接说是哪个仓库就行，比如“在 AMD-AGI/PrimusClaw 里修好失败的测试”，我就会在那个仓库里做。",
  },
});

/** What `/agent` alone (or with no subcommand) says; the remote-agent feature shows it. English only, as in the Python worker. */
export const AGENT_USAGE =
  "Your agents on your own machines (`/agents` or `/agent` alone shows them with buttons for everything below):\n" +
  "- `/agents` lists them and says which are online\n" +
  "- `/agent new AGENT PATH` starts a session in that folder, e.g. `/agent new codex /home/me/repo`; AGENT may also be " +
  "the name of a machine\n" +
  "- `/agent sessions` lists every session on every machine; `/agent attach MACHINE/AGENT` (or N, or an id) switches the chat " +
  "to one, e.g. `/agent attach robin-dev-pod/claude`, or just say 切到 robin-dev-pod 的 claude\n" +
  "- `/agent detach` (or 回到助理) sends your messages to the assistant again; the session stays where it is\n" +
  "- `/agent mode` shows the permission modes; `/agent mode ID` changes it\n" +
  "- `/agent mode card` keeps the chat box for me and talks to the session on its card (the default); `/agent mode chat` sends " +
  "the chat box to the session\n" +
  "- `/agent close` ends the session you are attached to\n" +
  "- `/agent off` disconnects a machine\n" +
  "- `/agent pair` gives the one command line that connects a new machine (or just say 连接我的开发环境)";
