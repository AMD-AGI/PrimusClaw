// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/** What the cards of a question a terminal asks (a connector's approval hooks) and `/approvals` say. */
import { defineCatalog } from "./catalog.js";

export const terminalApprovalText = defineCatalog({
  en: {
    title: "A terminal is waiting for you",
    who: (p: { agent: string; host: string; project: string }) =>
      p.project ? `${p.agent} in a terminal on ${p.host} (${p.project})` : `${p.agent} in a terminal on ${p.host}`,
    asksRun: "wants to run:",
    asksEdit: (p: { path: string }) => `wants to change ${p.path}:`,
    asksPlan: "has a plan and asks whether to start:",
    asksQuestion: "asks you:",
    asksTool: (p: { tool: string }) => `wants to use ${p.tool}:`,
    oldText: "Replaces:",
    newText: "With:",
    alwaysOption: (p: { name: string }) => `"Always allow (this session)" means: ${p.name}`,
    firstAnswerWins: "The terminal is asking too: the first answer, here or there, counts.",
    afterCard:
      "The terminal asks only after this card is answered or its wait is over: decline it here, or hand it back to the terminal and approve it there.",
    onInput:
      "To answer at the terminal instead, type anything there: the question goes back to it and this card is withdrawn.",
    tooLong: "Too long to show in full here: it can only be turned down from the phone; approve it at the terminal.",
    tooLongAfterCard:
      "Too long to show in full here: it can only be declined from the phone; the terminal asks once this card's wait is over.",
    tooLongOnInput:
      "Too long to show in full here: it can only be turned down from the phone; to approve it, type anything at the terminal and answer it there.",
    questionOf: (p: { n: number; of: number }) => `Question ${String(p.n)} of ${String(p.of)}`,
    optionYes: "Yes",
    optionSession: "Always allow (this session)",
    optionNo: "No",
    optionNoStop: "No, and stop",
    optionPlanApprove: "Approve (ask before edits)",
    optionPlanKeep: "Keep planning",
    optionToTerminal: "Ask me at the terminal",
    answeredInTerminal: "Answered in the terminal",
    noLongerWaiting: "No longer waiting for an answer",
    answeredInTerminalLine: "This request was answered in the terminal.",
    noLongerWaitingLine: "This request is no longer waiting for an answer.",
    approvalsOn:
      "Approvals from terminals are on: when Claude Code in a terminal of yours asks (run, edit, plan, a question), I put it to you here.",
    approvalsOff: "Approvals from terminals are off: questions stay in the terminal.",
    approvalsTurnedOn: "Turned on: questions your terminals ask come here too. `/approvals off` stops it.",
    approvalsTurnedOff: "Turned off: questions stay in the terminal. `/approvals on` brings them back.",
    approvalsUsage:
      "Use `/approvals on`, `/approvals off`, or `/approvals` to see which it is; `/approvals mute #12` (or `unmute #12`) for one terminal conversation, by the number its message names.",
    muted: (p: { item: string; where: string }) =>
      `Muted #${p.item}${p.where ? ` (${p.where})` : ""}: what that conversation asks, waits for or finishes stays in its terminal. \`/approvals unmute #${p.item}\` brings it back.`,
    unmuted: (p: { item: string; where: string }) =>
      `Unmuted #${p.item}${p.where ? ` (${p.where})` : ""}: that conversation's questions and ends come here again.`,
    muteNotFound: (p: { item: string }) => `I have no item #${p.item} of yours.`,
    muteNotTerminal: (p: { item: string }) =>
      `#${p.item} is not a conversation open in one of your terminals, so there is nothing to mute.`,
    endDone: "finished",
    endError: (p: { error: string }) => `stopped with an error (${p.error})`,
    endIdle: "terminal idle",
    endFull: "Show all",
    endRest: "The rest is in the terminal.",
    endAttach: "Attach",
    endMute: "Mute this conversation",
    approvalsUnavailable: "I could not reach the setting just now. Try again in a moment.",
  },
  zh: {
    title: "终端在等你回答",
    who: (p) => (p.project ? `${p.host} 终端里的 ${p.agent}（${p.project}）` : `${p.host} 终端里的 ${p.agent}`),
    asksRun: "想运行：",
    asksEdit: (p) => `想修改 ${p.path}：`,
    asksPlan: "写好了计划，问你要不要开始：",
    asksQuestion: "问你：",
    asksTool: (p) => `想使用 ${p.tool}：`,
    oldText: "原内容：",
    newText: "改为：",
    alwaysOption: (p) => `“本会话始终允许”即：${p.name}`,
    firstAnswerWins: "终端里也在等你回答，先答的算数。",
    afterCard: "终端要等这张卡片答完或等待时间到了才会问：在这里拒绝，或交回终端、到终端里批准。",
    onInput: "想改在终端里回答，就在终端里随便输入点什么：问题回到终端，这张卡片随之撤回。",
    tooLong: "内容过长，这里显示不全：手机上只能拒绝，请到终端批准。",
    tooLongAfterCard: "内容过长，这里显示不全：手机上只能拒绝；这张卡片的等待时间一过，终端就会问你。",
    tooLongOnInput: "内容过长，这里显示不全：手机上只能拒绝；要批准，在终端里随便输入点什么，到终端里回答。",
    questionOf: (p) => `第 ${String(p.n)} 题，共 ${String(p.of)} 题`,
    optionYes: "允许",
    optionSession: "本会话始终允许",
    optionNo: "拒绝",
    optionNoStop: "拒绝并停止",
    optionPlanApprove: "批准（编辑前逐个询问）",
    optionPlanKeep: "继续规划",
    optionToTerminal: "交回终端",
    answeredInTerminal: "已在终端里回答",
    noLongerWaiting: "不再等待回答",
    answeredInTerminalLine: "这个请求已在终端里回答。",
    noLongerWaitingLine: "这个请求不再等待回答。",
    approvalsOn: "终端审批推送已开启：你终端里的 Claude Code 要你确认（运行、修改、计划、提问）时，我会推到这里。",
    approvalsOff: "终端审批推送已关闭：这些问题只在终端里问。",
    approvalsTurnedOn: "已开启：终端里的问题也会推到这里。发 `/approvals off` 关闭。",
    approvalsTurnedOff: "已关闭：问题只在终端里问。发 `/approvals on` 重新开启。",
    approvalsUsage:
      "用 `/approvals on` 或 `/approvals off`；只发 `/approvals` 看当前状态；对单个终端会话用 `/approvals mute #12`（或 `unmute #12`），编号见推送消息里的 #N。",
    muted: (p) =>
      `已静音 #${p.item}${p.where ? `（${p.where}）` : ""}：这个会话的提问、等待和完成都只留在终端里。发 \`/approvals unmute #${p.item}\` 恢复。`,
    unmuted: (p) => `已恢复 #${p.item}${p.where ? `（${p.where}）` : ""}：这个会话的提问和完成会重新推到这里。`,
    muteNotFound: (p) => `你没有编号为 #${p.item} 的事项。`,
    muteNotTerminal: (p) => `#${p.item} 不是你终端里打开的会话，没有可静音的。`,
    endDone: "做完了",
    endError: (p) => `出错停下（${p.error}）`,
    endIdle: "终端空闲",
    endFull: "全文",
    endRest: "全文见终端。",
    endAttach: "接入会话",
    endMute: "静音此会话",
    approvalsUnavailable: "暂时读不到这个设置，请稍后再试。",
  },
});
