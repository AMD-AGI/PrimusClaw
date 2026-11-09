// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import { defineCatalog } from "./catalog.js";

/**
 * The fixed sentences of remote agents in the chat (`remote/`): the refusals, the replies to a command or a tap that cannot do
 * what it asks, and the lines of an attached chat. Each exists in both languages; English is what a chat not answered in
 * Chinese reads.
 */
export const remoteAgentText = defineCatalog({
  en: {
    notEnabled: "Remote agents are not turned on for this PrimusClaw yet.",
    offline:
      "That machine is offline, so nothing was sent. On that machine, run `claw-connector status` to see why, then `claw-connector service install` to start it again. Then send the message again.",
    outdated:
      "That machine's connector is too old for a new session, so nothing was started. On that machine, run `npm install -g @primusclaw/connector@latest && claw-connector stop && claw-connector service install` to upgrade it and restart it. Then try again.",
    stillWorking:
      "The agent is still working on your previous message, so this one was not sent. Send it again once it has answered.",
    stopFirst: "A task is still running. Send /stop first.",
    notAttached:
      "You are not attached to a remote session. Start one with `/agent new AGENT PATH`, or `/agent attach N`.",
    approvalInactive: "That approval request is no longer active.",
    approvalAnswered: "That approval was already answered or has run out.",
    unreachable: "I could not reach PrimusClaw. Please try again in a moment.",
    unreachableTail:
      "I could not read where the agent stands just now, so nothing was sent (it would have been mixed with what the agent said before). Please send your message again in a moment.",
    attachedBelow: "Attached. The session is in the message below.",
    agentAtWork:
      "The agent is working right now. I will tell you what it says when it pauses. Send /stop to interrupt it.",
    sessionGone: "That remote session is no longer available. Start a new one with `/agent new AGENT PATH`.",
    sessionLimit:
      "You already have the maximum number of active remote sessions. Close one with `/agent close N` first.",
    sessionEnded: "That session has ended. Start a new one with `/agent new AGENT PATH`.",
    agentNotFound: "I could not find that agent on that machine. Send /agents to see yours.",
    notFound: "I could not find that (it may have been removed). Send /agents or /agent sessions to look again.",
    rateLimited: "PrimusClaw is limiting remote agent requests for you right now. Wait a minute and try again.",
    keyRejected:
      "PrimusClaw rejected your linked key (it may have expired or been deleted). Send /unlink, then link again.",
    whichSession: "I could not tell which session you mean. Send `/agent sessions`, then `/agent attach N`.",
    whichSessionOrAgent: "I could not tell which session or agent you mean. Send `/agent sessions` to pick one.",
    backToPrimusclaw: "Your messages go to PrimusClaw again.",
    tapInactive: "That button is not active any more.",
    tapInvalid: "That button is no longer valid.",
    cardExpired: "That card has expired. Send the command again, or use /agents.",
    tapInvalidAgents: "That button is no longer valid. Send /agents for a new card.",
    typeFolder: "Type the folder on the machine first, for example /home/me/repo.",
    folderGone: "That folder is not one of the agent's folders any more. Pick one from the list.",
    badSubfolder: "A subfolder is a path inside the folder, like src/app: not starting with / or ~, and no .. in it.",
    conversationGone: "That conversation is not on the agent's list any more.",
    confirmExpired: "That confirmation has expired. Tap Take over… again to see what it does.",
    stillInTerminal: "That conversation is still open in a terminal. Exit it there first, then tap Take over again.",
    cannotTellTerminal: "I cannot tell whether that conversation is open in a terminal, so I did not take it over.",
    agentGone: "That agent is not available any more.",
    notInTerminal: "That conversation is no longer open in a terminal: tap Take over to continue it here.",
    sessionUnavailable: "That session is not available any more.",
    approvalRanOut: "That approval has run out and was refused.",
    sessionNotFound: "I could not find that session any more.",
    machineGone: "That session's machine is no longer connected. Start a new session on another machine.",
    cannotTakeOver:
      "That machine's connector cannot take over a conversation that is open in a terminal. Exit it there first, or update the connector.",
    modesUnknown: "I do not know the agent's modes yet; they are known once the session has started.",
    nothingRunning: "Nothing is running.",
    stopping: "Stopping the agent.",
    stopQueuedOffline:
      "That machine is offline. The stop is queued and the agent stops when it is back; I stopped watching. What it says after that reaches you here.",
    stoppedWatching:
      "I stopped watching the agent; it may still be finishing, and what it says from now on reaches you here as messages of its own. Send a message to talk to it, or `/agent detach` to leave it.",
    stopped: "Stopped.",
    notAttachedDetach: "You are not attached to a remote session.",
    attachHow:
      "Use `/agent attach N` with a number from `/agent sessions`, or name the agent: `/agent attach MACHINE/AGENT`.",
    lostTrack:
      "I lost track of your previous task. I am showing how it ends now; send your message again when it has finished.",
    noAnswerableOption:
      "The agent asked for permission but offered no answer I can pass on, so nothing can be approved here. Send /stop to cancel it.",
    notReported: "The agent has not reported in yet. You can send your message anyway, or `/agent detach`.",
    reconnecting: (p: { name: string }) =>
      `${p.name} lost its connection a moment ago and is most likely reconnecting by itself (this happens for a few ` +
      "seconds when PrimusClaw is updated). Try again in a minute; there is no need to restart its connector.",
    offlineNamed: (p: { name: string }) => `${p.name} is offline. Start its connector again, then try again.`,
    machinesNamedAlike: (p: { ref: string }) =>
      `More than one machine is called \`${p.ref}\`. Send /agents and use the buttons.`,
    noAgentReported: (p: { name: string }) =>
      `${p.name} has not reported an agent yet. Send /agents to see what is there.`,
    noAgentCalled: (p: { ref: string }) => `I could not find an agent called \`${p.ref}\`. Send /agents to see yours.`,
    agentOnMachines: (p: { names: string }) => `More than one machine has that agent. Name one: ${p.names}.`,
    notAccepted: (p: { code: string }) => `PrimusClaw did not accept that (${p.code}).`,
    notAcceptedRef: (p: { ref: string }) => `PrimusClaw did not accept that (ref ${p.ref}).`,
    couldNotTake: (p: { status: number }) => `PrimusClaw could not take that (error ${String(p.status)}).`,
    /** A session that ended while the chat was idle, when its end cannot be described (said in English, as the worker did). */
    endedWhileIdle: (p: { reason: string }) =>
      (p.reason ? `The session ended: ${p.reason}.` : "The session ended.") +
      " Your messages go to PrimusClaw again. Start a new session with `/agent new AGENT PATH`.",
    noMachineYet: "You have no machine connected yet.",
    changedElsewhere: "(Switched: see the status card below)",
    listBelow: "(Updated: see the card below)",
    endedFollowTail: " Your messages go to PrimusClaw again. Start a new session with `/agent new AGENT PATH`.",
    endedTail: " Start a new one with `/agent new AGENT PATH`.",
    approvalInPersonal: (p: { who: string }) =>
      `${p.who} is waiting for your approval. I sent the card to our 1:1 chat, so the group does not see what it asks.`,
    ranOutRefused: (p: { tool: string }) =>
      `${p.tool}: this request ran out and was refused. Ask the agent to run it again if you still want it.`,
    expiredTitle: "Expired",
    decisionNotAccepted: (p: { status: number }) =>
      `PrimusClaw did not accept the answer (error ${String(p.status)}). Press a button again in a moment.`,
    pressAgain: " Press a button again.",
    turnFailed: (p: { ref: string }) => `The agent's turn failed (ref ${p.ref}).`,
    turnEnded: (p: { reason: string }) => `The turn ended (${p.reason})`,
    lostConnection:
      "I lost the connection to PrimusClaw while the agent was working. It may still be running: send a message to see where it stands, or /stop.",
    watchFailed: (p: { ref: string }) =>
      `Something went wrong on my side while watching the agent (ref ${p.ref}). Send a message to see where it stands.`,
    noModeSays: (p: { which: string }) =>
      ` The agent does not say which of its modes ${p.which}, so I left its mode as it is.`,
    doNotAsk: "do not ask",
    ask: "ask",
    limitAsks: (p: { refused: string }) => ` ${p.refused} It runs in a mode that asks for approval.`,
    switchFailed: " I could not switch its mode just now. Tap Mode to try again.",
    switchUnconfirmed: " I asked it to switch its mode, but it has not confirmed yet. Tap Mode to see where it stands.",
    switchedTo: (p: { mode: string }) => ` Switched to \`${p.mode}\`.`,
    watchingHead: (p: { label: string; host: string }) =>
      `${p.label} on ${p.host} is open in a terminal: watching it read-only.`,
    readyMode: (p: { mode: string }) => ` Mode: \`${p.mode}\`.`,
    readyUnattended: (p: { note: string }) => ` ⚠️ ${p.note}.`,
    ready: (p: { label: string; host: string; mode: string; unattended: string; switched: string }) =>
      `${p.label} is ready on ${p.host}.${p.mode}${p.unattended}${p.switched} Send your first message.`,
    notReportedLead: "The agent has not reported in yet. You can send your message anyway.",
    modeNow: (p: { mode: string }) => `Mode is now \`${p.mode}\`.`,
    modeUnconfirmed: (p: { mode: string }) =>
      `I asked the agent to switch to \`${p.mode}\`; it has not confirmed yet. \`/agent mode\` shows what it is.`,
    startsUnattendedRefused: (p: { refused: string }) =>
      `${p.refused} This agent starts in a mode that does not ask for approval, so a new session of it counts as one; no session was started.`,
    workingNow: "It is working right now; I will tell you what it says when it pauses.",
    agentsOnHost: (p: { host: string; names: string }) => `${p.host} has more than one agent. Name one: ${p.names}.`,
    whichConversation: "I could not tell which conversation you mean. Send `/agent sessions` to pick one.",
    notAModeId: "That is not a mode id. Send `/agent mode` to see the ones the agent offers.",
    notOffered: (p: { mode: string; have: string }) => `The agent does not offer \`${p.mode}\`. It offers: ${p.have}.`,
    closedNumber: (p: { number: number; where: string }) => `Closed session ${String(p.number)}${p.where}.`,
    closedSession: (p: { where: string }) => `Closed the session${p.where}.`,
    closedIn: (p: { folder: string }) => ` in ${p.folder}`,
    closedBack: " Your messages go to PrimusClaw again.",
    newUsage:
      "Use `/agent new AGENT PATH`, for example `/agent new codex /home/me/repo`, or pick a folder here and tap New session.",
    modeIs: (p: { mode: string }) => `Mode: \`${p.mode}\`. `,
    modesOffered: (p: { have: string }) => `The agent offers ${p.have}. Change it with \`/agent mode ID\`.`,
    whichMachine: (p: { names: string }) => `Which machine? Use \`/agent off NAME\` with one of ${p.names}.`,
    whichMachineNone: "Which machine? Use `/agent off NAME`. You have no machine connected.",
    notAttachedCard: "You are not attached to a remote session.",
    otherSessionCard: "That card is for another session. This chat is attached to a different one: use its buttons.",
    pairHead: "To connect a new machine:",
    pairAbove: " the command is in the message above; run it on that machine.",
    emptySend: "Write in the box first, then press Send.",
    noOutputYet: "There is no output yet.",
    fullOutputHead: (p: { i: number; n: number; label: string; host: string }) =>
      `Full output ${String(p.i)}/${String(p.n)} · ${p.label} @ ${p.host}`,
    askingSwitch: (p: { mode: string }) => `Asking the agent to switch to ${p.mode}. I will say when it has.`,
    offlineTap: (p: { host: string }) => `${p.host} is offline. Start its connector again, then try again.`,
    stopReadOnly: "This is a read-only watch: the terminal is using it, so stop it there.",
  },
  zh: {
    notEnabled: "这个 PrimusClaw 还没有打开远程 agent。",
    offline:
      "那台机器离线了，什么都没有发出去。在那台机器上运行 `claw-connector status` 看原因，再运行 `claw-connector service install` 重新启动它。然后再发一次。",
    outdated:
      "那台机器的连接器太旧，开不了新会话，什么都没有启动。在那台机器上运行 `npm install -g @primusclaw/connector@latest && claw-connector stop && claw-connector service install` 升级并重启它。然后再试一次。",
    stillWorking: "agent 还在处理你上一条消息，这条没有发给它。等它回答完再发。",
    stopFirst: "还有任务在运行。先发 /stop。",
    notAttached: "你还没有接入远程会话。用 `/agent new AGENT PATH` 开一个，或者发 `/agent attach N`。",
    approvalInactive: "这个审批请求已经失效了。",
    approvalAnswered: "这个审批已经答复过，或者已经过期了。",
    unreachable: "我连不上 PrimusClaw。请稍后再试。",
    unreachableTail:
      "我刚才读不到 agent 进行到哪一步了，所以什么都没有发出去（不然会和 agent 之前说的混在一起）。请稍后再发一次。",
    attachedBelow: "已接入。会话在下面的消息里。",
    agentAtWork: "agent 正在工作。它停下来时我会告诉你它说了什么。发 /stop 打断它。",
    sessionGone: "那个远程会话已经不在了。用 `/agent new AGENT PATH` 开一个新的。",
    sessionLimit: "你的活跃远程会话已经到上限了。先用 `/agent close N` 关掉一个。",
    sessionEnded: "那个会话已经结束了。用 `/agent new AGENT PATH` 开一个新的。",
    agentNotFound: "那台机器上找不到这个 agent。发 /agents 看看你有哪些。",
    notFound: "找不到它（可能已经被删除了）。发 /agents 或 /agent sessions 再看一下。",
    rateLimited: "PrimusClaw 正在限制你的远程 agent 请求。等一分钟再试。",
    keyRejected: "PrimusClaw 拒绝了你关联的 key（可能已过期或被删除）。发 /unlink，然后重新关联。",
    whichSession: "我分不清你说的是哪个会话。发 `/agent sessions`，再发 `/agent attach N`。",
    whichSessionOrAgent: "我分不清你说的是哪个会话或 agent。发 `/agent sessions` 选一个。",
    backToPrimusclaw: "你的消息会重新发给 PrimusClaw。",
    tapInactive: "这个按钮已经失效了。",
    tapInvalid: "这个按钮已经不能用了。",
    cardExpired: "这张卡片已经过期了。重新发一次命令，或者用 /agents。",
    tapInvalidAgents: "这个按钮已经不能用了。发 /agents 拿一张新卡片。",
    typeFolder: "先填机器上的目录，例如 /home/me/repo。",
    folderGone: "这个目录已经不在 agent 的目录列表里了。从列表里选一个。",
    badSubfolder: "子目录是这个目录里面的路径，比如 src/app：不能以 / 或 ~ 开头，也不能包含 ..。",
    conversationGone: "这个对话已经不在 agent 的列表里了。",
    confirmExpired: "这个确认已经过期了。再点一次「接管…」看看它会做什么。",
    stillInTerminal: "这个对话还在终端里开着。先在终端里退出它，再点一次「接管」。",
    cannotTellTerminal: "我看不出这个对话是不是在终端里开着，所以没有接管。",
    agentGone: "这个 agent 已经不在了。",
    notInTerminal: "这个对话已经不在终端里开着了：点「接管」在这里接着聊。",
    sessionUnavailable: "这个会话已经不在了。",
    approvalRanOut: "这个审批已经过期，已自动拒绝。",
    sessionNotFound: "我找不到那个会话了。",
    machineGone: "那个会话所在的机器已经断开了。在另一台机器上开一个新会话。",
    cannotTakeOver: "那台机器的连接器接管不了终端里开着的会话。先在终端里退出它，或者升级连接器。",
    modesUnknown: "我还不知道这个 agent 有哪些模式；会话启动后就知道了。",
    nothingRunning: "现在没有在运行的任务。",
    stopping: "正在停止 agent。",
    stopQueuedOffline:
      "那台机器离线了。停止指令已排队，机器回来后 agent 就会停下；我先不跟了，之后它说的话会发到这里。",
    stoppedWatching:
      "我不再等这一轮了；agent 可能还在收尾，之后它说的话会作为单独的消息发到这里。发消息继续跟它说，或发 `/agent detach` 离开。",
    stopped: "已停止。",
    notAttachedDetach: "你现在没有接入远程会话。",
    attachHow:
      "发 `/agent attach N`（N 是 `/agent sessions` 里的编号），或者写出 agent：`/agent attach 机器名/agent`。",
    lostTrack: "我没跟上你上一个任务。现在把它的结果显示出来；它结束后请把你的消息再发一次。",
    noAnswerableOption: "agent 请求批准，但没有给出可以转达的选项，所以这里批不了。发 /stop 取消它。",
    notReported: "agent 还没有报到。可以直接发消息，或者发 `/agent detach`。",
    reconnecting: (p) =>
      `${p.name} 刚刚断开了连接，多半正在自己重连（PrimusClaw 更新时会断开几秒）。过一分钟再试；不用重启它的连接器。`,
    offlineNamed: (p) => `${p.name} 离线了。重新启动它的连接器，然后再试一次。`,
    machinesNamedAlike: (p) => `有不止一台机器叫 \`${p.ref}\`。发 /agents 用按钮选。`,
    noAgentReported: (p) => `${p.name} 还没有报告任何 agent。发 /agents 看看有什么。`,
    noAgentCalled: (p) => `我找不到叫 \`${p.ref}\` 的 agent。发 /agents 看看你有哪些。`,
    agentOnMachines: (p) => `不止一台机器有这个 agent。指定一个：${p.names}。`,
    notAccepted: (p) => `PrimusClaw 没有接受这个请求（${p.code}）。`,
    notAcceptedRef: (p) => `PrimusClaw 没有接受这个请求（ref ${p.ref}）。`,
    couldNotTake: (p) => `PrimusClaw 处理不了这个请求（错误 ${String(p.status)}）。`,
    endedWhileIdle: (p) =>
      (p.reason ? `会话已结束：${p.reason}。` : "会话已结束。") +
      "你的消息会重新发给 PrimusClaw。用 `/agent new AGENT PATH` 开新会话。",
    noMachineYet: "你还没有连接任何机器。",
    changedElsewhere: "（已切换，见下方的新状态卡）",
    listBelow: "（已更新，见下方的新卡片）",
    endedFollowTail: " 你的消息会重新发给 PrimusClaw。用 `/agent new AGENT PATH` 开新会话。",
    endedTail: " 用 `/agent new AGENT PATH` 开新会话。",
    approvalInPersonal: (p) => `${p.who} 在等你批准。审批卡发到了你和我的 1:1 聊天里，群里看不到它要做什么。`,
    ranOutRefused: (p) => `${p.tool}：这个请求已经过期，已自动拒绝。还需要的话，让 agent 再执行一次。`,
    expiredTitle: "已过期",
    // (said in English, as the worker did)
    decisionNotAccepted: (p) =>
      `PrimusClaw did not accept the answer (error ${String(p.status)}). Press a button again in a moment.`,
    pressAgain: " 再按一次按钮。",
    turnFailed: (p) => `agent 这一轮失败了（参考号 ${p.ref}）。`,
    turnEnded: (p) => `这一轮结束了（${p.reason}）`,
    // (said in English, as the worker did)
    lostConnection:
      "I lost the connection to PrimusClaw while the agent was working. It may still be running: send a message to see where it stands, or /stop.",
    watchFailed: (p) => `我这边跟进 agent 时出错了（参考号 ${p.ref}）。发一条消息看看它进行到哪了。`,
    // (the worker said these in English whatever the chat's language)
    noModeSays: (p) => ` The agent does not say which of its modes ${p.which}, so I left its mode as it is.`,
    doNotAsk: "do not ask",
    ask: "ask",
    limitAsks: (p) => ` ${p.refused} It runs in a mode that asks for approval.`,
    switchFailed: " I could not switch its mode just now. Tap Mode to try again.",
    switchUnconfirmed: " I asked it to switch its mode, but it has not confirmed yet. Tap Mode to see where it stands.",
    switchedTo: (p) => ` Switched to \`${p.mode}\`.`,
    watchingHead: (p) => `${p.label}（${p.host}）正在终端里打开着：只读旁观。`,
    readyMode: (p) => `模式：\`${p.mode}\`。`,
    readyUnattended: (p) => `${p.note}。`,
    ready: (p) => `${p.label} 已在 ${p.host} 上就绪。${p.mode}${p.unattended}${p.switched}直接发消息就行。`,
    notReportedLead: "agent 还没有报到。可以直接发消息，它会在启动后收到。",
    modeNow: (p) => `模式已切换为 \`${p.mode}\`。`,
    modeUnconfirmed: (p) => `已请 agent 切换到 \`${p.mode}\`，它还没有确认。发 \`/agent mode\` 看当前模式。`,
    startsUnattendedRefused: (p) =>
      `${p.refused} This agent starts in a mode that does not ask for approval, so a new session of it counts as one; no session was started.`,
    workingNow: "它现在正在干活，停下来时我把它说的话发给你。",
    agentsOnHost: (p) => `${p.host} 上有不止一个 agent。指定一个：${p.names}。`,
    // (said in English, as the worker did)
    whichConversation: "I could not tell which conversation you mean. Send `/agent sessions` to pick one.",
    // (said in English, as the worker did)
    notAModeId: "That is not a mode id. Send `/agent mode` to see the ones the agent offers.",
    notOffered: (p) => `The agent does not offer \`${p.mode}\`. It offers: ${p.have}.`,
    closedNumber: (p) => `已关闭会话 ${String(p.number)}${p.where}。`,
    closedSession: (p) => `已关闭会话${p.where}。`,
    closedIn: (p) => `（${p.folder}）`,
    closedBack: "你的消息会重新发给 PrimusClaw。",
    // (said in English, as the worker did)
    newUsage:
      "Use `/agent new AGENT PATH`, for example `/agent new codex /home/me/repo`, or pick a folder here and tap New session.",
    modeIs: (p) => `Mode: \`${p.mode}\`. `,
    modesOffered: (p) => `The agent offers ${p.have}. Change it with \`/agent mode ID\`.`,
    whichMachine: (p) => `Which machine? Use \`/agent off NAME\` with one of ${p.names}.`,
    whichMachineNone: "Which machine? Use `/agent off NAME`. You have no machine connected.",
    notAttachedCard: "你还没有接入远程会话。",
    otherSessionCard: "这张卡片属于另一个会话。这个聊天接入的是别的会话：用那个会话的按钮。",
    pairHead: "连接新机器：",
    pairAbove: "命令在上面的消息里，在那台机器上运行它。",
    emptySend: "先在输入框里写好，再按发送。",
    noOutputYet: "还没有输出。",
    fullOutputHead: (p) => `完整输出 ${String(p.i)}/${String(p.n)} · ${p.label} @ ${p.host}`,
    askingSwitch: (p) => `正在让 agent 切换到 ${p.mode}，切好了我会说。`,
    offlineTap: (p) => `${p.host} 离线了。先重新运行它的连接器，再试一次。`,
    stopReadOnly: "这是只读旁观：终端里正在用，要停止请在终端里操作。",
  },
});

/** The sentences that take no parameters: what `saidIn` says. */
export type RemoteSentence = {
  [K in keyof ReturnType<typeof remoteAgentText.in>]: ReturnType<typeof remoteAgentText.in>[K] extends string
    ? K
    : never;
}[keyof ReturnType<typeof remoteAgentText.in>];

/**
 * The sentences the Python worker said in English whatever the chat's language: their Chinese entry is the English text, kept so
 * (a port that changes what a person reads is a change of its own).
 */
export const SAID_IN_ENGLISH: ReadonlySet<string> = new Set([
  "decisionNotAccepted",
  "lostConnection",
  "noModeSays",
  "doNotAsk",
  "ask",
  "limitAsks",
  "switchFailed",
  "switchUnconfirmed",
  "switchedTo",
  "notAModeId",
  "notOffered",
  "newUsage",
  "modeIs",
  "modesOffered",
  "whichMachine",
  "whichMachineNone",
  "whichConversation",
  "startsUnattendedRefused",
]);
