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
      "Use `/approvals` to see whether approvals from terminals are on, how often summaries come and which conversations are muted; `/approvals on` or `/approvals off` to change the first; `/approvals mute #12` (or `unmute #12`) for one terminal conversation, by the number its message names; `/approvals summary 60` (minutes, 15 to 1440, or `off`) for how often a conversation that keeps working on its own is summed up.",
    mutedNone: "No conversation is muted. `/approvals mute #12` mutes one, by the number its message names.",
    mutedHeader: (p: { count: string }) =>
      `Muted conversations (${p.count}): what they ask, wait for or finish stays in their terminals. \`/approvals unmute #12\` brings one back.`,
    mutedLine: (p: { who: string; since: string }) => (p.since ? `${p.who} (muted since ${p.since})` : p.who),
    mutedUnnamed: "a conversation",
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
    endEarlierAsked: (p: { text: string; count: number }) =>
      p.text
        ? `An earlier turn asked: ${p.text}${p.count > 1 ? ` (${String(p.count)} earlier turns asked; see the terminal)` : ""}`
        : p.count > 1
          ? `${String(p.count)} earlier turns asked you something; see the terminal.`
          : "An earlier turn asked you something; see the terminal.",
    endEarlierFailed: (p: { text: string; count: number }) =>
      p.text
        ? `An earlier turn stopped with an error: ${p.text}${p.count > 1 ? ` (${String(p.count)} earlier turns did; see the terminal)` : ""}`
        : p.count > 1
          ? `${String(p.count)} earlier turns stopped with an error; see the terminal.`
          : "An earlier turn stopped with an error; see the terminal.",
    endLatest: (p: { text: string }) => `Latest turn: ${p.text}`,
    approvalsUnavailable: "I could not reach the setting just now. Try again in a moment.",
    summaryEvery: (p: { minutes: string }) =>
      `A terminal conversation that keeps working on its own (turns another session or a schedule started) is summed up at most once every ${p.minutes} minutes; the end of a turn you started, or one that asks you something, comes at once. \`/approvals summary <minutes>|off\` changes it.`,
    summaryNever:
      "Summaries are off: only the end of a turn you started, or one that asks you something, comes here. `/approvals summary 60` turns them back on.",
    summarySet: (p: { minutes: string }) =>
      `Done: a conversation that keeps working on its own is summed up at most once every ${p.minutes} minutes.`,
    summaryOff:
      "Done: no more summaries; the end of a turn you started, or one that asks you something, still comes here.",
    summaryUsage:
      "Use `/approvals summary <minutes>` with 15 to 1440 minutes, `/approvals summary off`, or `/approvals summary` to see it.",
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
      "只发 `/approvals` 看当前状态（终端审批推送是否开启、汇总间隔、已静音的会话）；用 `/approvals on` 或 `/approvals off` 开关推送；对单个终端会话用 `/approvals mute #12`（或 `unmute #12`），编号见推送消息里的 #N；`/approvals summary 60`（分钟，15 到 1440，或 `off`）设置持续工作的会话多久汇总一次。",
    mutedNone: "没有已静音的会话。发 `/approvals mute #12` 静音某个会话，编号见推送消息里的 #N。",
    mutedHeader: (p) =>
      `已静音的会话（${p.count} 个）：它们的提问、等待和完成只留在终端里。发 \`/approvals unmute #12\` 恢复其中一个。`,
    mutedLine: (p) => (p.since ? `${p.who}（${p.since} 起静音）` : p.who),
    mutedUnnamed: "一个会话",
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
    endEarlierAsked: (p) =>
      p.text
        ? `早先一轮在问你：${p.text}${p.count > 1 ? `（早先共 ${String(p.count)} 轮在问你，详见终端）` : ""}`
        : `早先有 ${String(p.count)} 轮在问你，详见终端。`,
    endEarlierFailed: (p) =>
      p.text
        ? `早先一轮出错停下：${p.text}${p.count > 1 ? `（早先共 ${String(p.count)} 轮出错，详见终端）` : ""}`
        : `早先有 ${String(p.count)} 轮出错停下，详见终端。`,
    endLatest: (p) => `最新一轮：${p.text}`,
    approvalsUnavailable: "暂时读不到这个设置，请稍后再试。",
    summaryEvery: (p) =>
      `其他会话或定时任务驱动、持续在跑的终端会话，最多每 ${p.minutes} 分钟汇总一次；你自己发起的回合、或在问你的回合，结束时立即推送。发 \`/approvals summary <分钟>|off\` 修改。`,
    summaryNever: "汇总已关闭：只推送你自己发起的回合、或在问你的回合。发 `/approvals summary 60` 重新开启。",
    summarySet: (p) => `已设置：持续工作的终端会话最多每 ${p.minutes} 分钟汇总一次。`,
    summaryOff: "已关闭汇总；你自己发起的回合、或在问你的回合，结束时仍会推送。",
    summaryUsage:
      "用 `/approvals summary <分钟>`（15 到 1440），`/approvals summary off` 关闭，只发 `/approvals summary` 查看当前设置。",
  },
});
