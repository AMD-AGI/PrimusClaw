// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import { defineCatalog } from "./catalog.js";

/**
 * The closed set of reason codes a connector (and Claw on its behalf) gives: what happened, then what to do. The fix of an
 * old-connector code and the hints after some codes are added by `remote/connector/reasons.ts`.
 *
 * Sources: connector/src (session.ts, manager.ts, attach.ts, roots.ts, connector.ts, permissions.ts, terminal-input.ts) and what
 * Claw itself writes with `data.by = "claw"` (claw/packages/api/src/remote-agents/store.ts). A code the connector gains must be
 * added here, in both languages. `{login}` is the login command of the address the worker reaches Claw at.
 */
export const connectorReasonText = defineCatalog({
  en: {
    mode_unavailable:
      'The agent on that machine does not offer the permission mode this session needs. Most often the connector runs as root and the agent has `approval = "never"`: Claude offers no bypassPermissions mode to root, so a connector older than 0.1.5 refuses the session.',
    mode_not_enforced:
      'The agent could not be put in the permission mode the connector requires (or warned it will no longer ask), so the connector closed the session to stay safe. This happens with Claude running as root (older connectors), or when Claude\'s `permissions.defaultMode` is bypassPermissions and the agent has no `approval = "never"`.',
    mode_not_confirmed:
      "The agent did not confirm the permission mode it was asked for, so the connector closed the session to stay safe. Upgrade the connector (it brings a newer agent adapter) and try again.",
    mode_mismatch:
      "The agent reported a different permission mode from the one it was asked for, so the connector closed the session to stay safe. Upgrade the connector and try again; if it persists, check Claude's settings there.",
    mode_not_allowed:
      'That mode does not ask before each step, and the agent is not allowed to run that way on that machine. To allow it, set `approval = "never"` on the agent in agents.toml and restart the connector; otherwise pick a mode that asks.',
    mode_id_required: "The mode switch named no mode. Tap Mode and pick one again.",
    set_mode_failed: "The agent could not switch its mode; it keeps the one it had.",
    adapter_gone: "The agent program on that machine has exited.",
    adapter_start_failed:
      "The connector could not start the agent program on that machine (often: no access to the npm registry, or the command is missing). Run `claw-connector status` there and look at `run.log` in its state directory.",
    adapter_unavailable: "The connector could not start the agent program for this turn.",
    adapter_protocol:
      "The agent program answered in a way the connector does not expect, most likely a version mismatch. Upgrade the connector and try again.",
    adapter_cannot_resume: "This agent cannot pick up the earlier conversation.",
    adapter_error: "The agent program failed. Look at `run.log` in the connector's state directory on that machine.",
    agent_auth_required:
      "The agent is not signed in on that machine. Run the agent there once (`claude`, for example) to sign in, then try again.",
    cwd_outside_roots:
      "That directory is outside the roots the agent may work in. Pick one inside them, or add it to `roots` in agents.toml and restart the connector.",
    cwd_not_found: "That directory does not exist on that machine.",
    cwd_not_directory: "That path is not a directory.",
    cwd_not_absolute: "The directory must be an absolute path (starting with /).",
    invalid_cwd: "That directory name is not valid.",
    cwd_mismatch: "That conversation is not in this directory. Pick it again from the list.",
    unknown_agent:
      "That machine has no such agent (agents.toml may have changed). Check agents.toml there and restart the connector after a change.",
    not_delivered:
      "The machine never got it, so nothing ran: it looked online when it was sent but had gone (a laptop closed, for one). Send it again once the machine is back.",
    delivery_unconfirmed:
      "The machine went just as this was sent and did not confirm it got it, so it may not have run. If it does once the machine is back, what it says shows up here.",
    connector_revoked:
      "That machine's connector was signed out (logout or `/agent off`), and its sessions closed with it. To go on, sign the connector in again there and start a new session.",
    machine_reconnected:
      "That machine registered again (a reinstall, lost local state or a rebuilt container), and the old session closed with its old registration.",
    unknown_session: "The connector no longer knows this session (it may have restarted).",
    too_many_sessions: "Too many sessions are open on that machine. Close one with `/agent close` first.",
    resume_not_supported: "This agent cannot continue an existing session.",
    attach_unavailable:
      "This agent cannot take over a terminal conversation. Configure an agent with the `claude-attach` preset for that.",
    resume_ref_required: "No conversation was named to take over. Pick one from the list.",
    invalid_resume_ref: "That conversation reference is not valid. Pick one from the list.",
    already_attached: "That conversation is already open from the phone. Switch to it with `/agent sessions`.",
    catalog_unavailable: "The connector could not read the list of conversations on that machine.",
    session_live:
      "That conversation is still open in a terminal on that machine. Quit it there first, then take it over.",
    recently_written:
      "A terminal wrote to that conversation moments ago and may still be using it. Try again in a minute.",
    twin_check_failed:
      "The connector could not check whether the conversation is still open in a terminal, so it did not take it over.",
    terminal_did_not_exit:
      "The terminal did not let the conversation go when asked, so it was not taken over; it is still there. Quit it in the terminal first, then take it over.",
    session_live_elsewhere:
      "That conversation is open on another machine or container sharing the Claude config directory; it cannot be ended from here, so it was not taken over. Quit it there, then try again.",
    takeover_not_permitted:
      "The terminal holding the conversation belongs to another user, so the connector may not end it; it was not taken over.",
    takeover_failed: "Ending the terminal's hold on the conversation failed, so it was not taken over.",
    // (since connector 0.1.19 a running turn never holds a message back: Claude Code queues it; only someone's half-typed text in
    // the box, or a screen scrolled back, held for 10 minutes ends it terminal_busy)
    terminal_busy:
      "Someone was typing in the terminal (or had it scrolled back) for 10 minutes, so the message was not typed in. Send it again later.",
    // (Claude Code took the message into its own queue, then someone at the terminal pulled that queue back into the box)
    terminal_input_withdrawn:
      "The message was in Claude Code's queue in the terminal, but someone there pulled the queue back into the input box (up-arrow to edit), so it was not sent as the phone's message; it is now in the terminal's input box. To send it, press Enter in the terminal, or send it again from the phone.",
    // (a terminal whose Claude Code cannot be told to hold this conversation, for 10 minutes)
    terminal_state_unknown:
      "For 10 minutes the connector could not confirm that the terminal's Claude Code still has this conversation open, so the message was not typed in. Look at the terminal, make sure it is still on this conversation, and send again.",
    terminal_gone: "The terminal's tmux pane is gone, so the message was not typed in.",
    terminal_switched:
      "That terminal has moved to another conversation (a /resume or /clear there), so the message was not typed in.",
    terminal_input_failed: "Typing the message into the terminal failed; it was not sent.",
    // (a connector after 0.1.22: the paste never showed in the box in the 20 seconds it waited)
    terminal_input_unseen:
      "The message was typed into the terminal, but the terminal did not show it for 20 seconds (Claude Code there is busy or not taking input), so nothing was sent. Send it again in a moment.",
    terminal_input_unconfirmed:
      "The message was typed into the terminal, but its transcript does not show it; it may not have gone in. Check the terminal.",
    terminal_input_unavailable:
      "After a restart the connector could not prove that terminal again, so the message was not typed in. Attach again.",
    empty_prompt: "The message was empty once its control characters were removed; nothing was typed.",
    // (a prompt to a session that only watches a terminal's conversation; also a turn_end error)
    read_only_live_session:
      "That conversation is open in a terminal on that machine and can only be watched from here, so the message was not sent. Type it in the terminal, or take the conversation over first.",
    terminal_session: "That conversation is open in a terminal, which keeps its own mode.",
    terminal_mode_not_allowed:
      "The terminal's conversation is in a permission mode that does not ask (auto, for example), which this agent's approval setting does not allow from the phone, so the message was not typed in. Switch the terminal to a mode that asks (shift+tab in Claude Code: manual or plan) and send again, or set `approval = \"never\"` for this agent in agents.toml on that machine.",
    terminal_mode_unknown:
      "The connector could not read which permission mode the terminal's conversation is in, so nothing was typed. Make sure Claude Code there is up to date and shows its mode below the input box, then send again.",
    terminal_screen_unknown:
      "The connector could not read the terminal's screen for 30 seconds (no Claude Code input box, and it did not say it was busy), so the message was not typed in. Look at the terminal, close whatever is on it, and send again.",
    terminal_command_refused:
      "A message that starts with ! or / would run a command in that terminal, so it is not typed from the phone. Rephrase it, or run the command at the terminal.",
    takeover_expired:
      "The confirmation to take that conversation over reached the machine too late; it was not taken over. Open it again and confirm again.",
    cwd_ambiguous: "More than one of this agent's roots has a folder by that name. Give its full path.",
    root_unavailable:
      "The folder's disk is not answering on that machine (a network mount that is down or not mounted yet). Try again in a minute, or check the mount there.",
    session_closed: "That session has already closed.",
    closed: "The session was closed as asked.",
    stopped:
      "The connector on that machine was stopped. Start it again there (`claw-connector run`, or the service's `sh keepalive.sh`).",
    paused: "The connector on that machine is paused. Run `claw-connector resume` there.",
    revoked: "That machine's connector was revoked. Run `{login}` there to sign in again.",
    text_required: "The message to the agent was empty.",
    action_and_option_required: "That answer named no request or option. Tap the card again.",
    too_many_queued_prompts:
      "The agent has too many messages waiting; this one was not taken. Send it again when it has caught up.",
    cancelled: "That message was dropped unrun when the agent was stopped.",
    unknown_action: "That approval request is gone.",
    option_not_offered: "That option is not one the agent offered.",
  },
  zh: {
    mode_unavailable:
      '那台机器上的 agent 不提供这个会话需要的权限模式。最常见的原因：连接器以 root 运行且该 agent 设了 `approval = "never"`，root 下的 Claude 不提供 bypassPermissions，旧版连接器（0.1.5 之前）因此拒绝开会话。',
    mode_not_enforced:
      'agent 没能切到连接器要求的权限模式（或提示它不会再逐步询问），连接器为安全起见关闭了会话。常见于 root 下的 Claude （旧版连接器），或 Claude 的 `permissions.defaultMode` 是 bypassPermissions 而该 agent 没设 `approval = "never"`。',
    mode_not_confirmed:
      "agent 没有确认它已切到要求的权限模式，连接器为安全起见关闭了会话。升级连接器（会带上较新的 agent 适配器）后再试。",
    mode_mismatch:
      "agent 报告的权限模式和要求的不一致，连接器为安全起见关闭了会话。升级连接器后再试；仍然出现的话，检查那台机器上 Claude 的设置。",
    mode_not_allowed:
      '这个模式不逐步询问权限，而该 agent 在那台机器上没有被允许这样运行。要允许，在 agents.toml 里给该 agent 设 `approval = "never"` 并重启连接器；否则请选一个会询问的模式。',
    mode_id_required: "切换模式的请求里缺少模式名。点「模式」再选一次。",
    set_mode_failed: "agent 没能切换模式，仍是原来的模式。",
    adapter_gone: "那台机器上的 agent 程序已经退出了。",
    adapter_start_failed:
      "连接器没能在那台机器上启动 agent 程序（常见原因：访问不了 npm 仓库、命令不存在）。在那台机器上运行 `claw-connector status`，并看状态目录里的 `run.log`。",
    adapter_unavailable: "连接器没能为这一轮启动 agent 程序。",
    adapter_protocol: "agent 程序的应答和连接器预期的不一致，多半是版本不匹配。升级连接器后再试。",
    adapter_cannot_resume: "这个 agent 不能接着之前的对话继续。",
    adapter_error: "agent 程序报错了。在那台机器上看连接器状态目录里的 `run.log`。",
    agent_auth_required: "那台机器上的 agent 还没登录。在那台机器上运行一次 agent（例如 `claude`）完成登录，再试。",
    cwd_outside_roots:
      "这个目录不在该 agent 允许的 roots 里。换一个 roots 里的目录，或在 agents.toml 的 `roots` 里加上它并重启连接器。",
    cwd_not_found: "那台机器上没有这个目录。",
    cwd_not_directory: "这个路径不是目录。",
    cwd_not_absolute: "目录要写成绝对路径（以 / 开头）。",
    invalid_cwd: "这个目录名无效，换一个目录再试。",
    cwd_mismatch: "所选对话不在这个目录里。从列表里重新选。",
    unknown_agent: "那台机器上没有这个 agent（agents.toml 可能改过）。在那台机器上检查 agents.toml，改后重启连接器。",
    not_delivered:
      "那台机器没收到，什么都没执行：发出时它看起来在线，但已经断开（比如笔记本合盖了）。等它重新连上后再发一次。",
    delivery_unconfirmed:
      "那台机器在这条消息发出前后断开了，没有确认收到，可能没有执行。它重新连上后如果做了，结果会出现在这里。",
    connector_revoked:
      "那台机器的连接器已被注销（logout 或 `/agent off`），它上面的会话随之关闭。要继续，在那台机器上重新登录连接器，再开新会话。",
    machine_reconnected: "那台机器重新注册过（重装、丢了本地状态或重建了容器），旧会话随旧注册关闭了。",
    unknown_session: "连接器不认识这个会话了（可能已重启或清理过）。",
    too_many_sessions: "那台机器上同时开着的会话太多了。先用 `/agent close` 关掉一个。",
    resume_not_supported: "这个 agent 不支持接着已有的会话继续。",
    attach_unavailable: "这个 agent 不支持接管终端里的对话。要接管，请用 `claude-attach` 预设配置一个 agent。",
    resume_ref_required: "没有指明要接管哪段对话。从列表里重新选。",
    invalid_resume_ref: "要接管的对话编号无效。从列表里重新选。",
    already_attached: "这段对话已经在手机上打开了。用 `/agent sessions` 切过去。",
    catalog_unavailable: "连接器暂时读不到那台机器上的对话列表。",
    session_live: "这段对话还在那台机器的终端里开着。先在终端里退出它，再接管。",
    recently_written: "终端刚写过这段对话，可能还在用。过一分钟再试。",
    twin_check_failed: "连接器没能确认这段对话是否还在终端里开着，为安全起见没有接管。",
    terminal_did_not_exit: "终端里的这段对话没有按要求退出，所以没有接管，它还在终端里。先在终端里退出它，再接管。",
    session_live_elsewhere:
      "这段对话开在另一台机器或容器里（共用同一个 Claude 配置目录），这里结束不了它，所以没有接管。在那边退出它再试。",
    takeover_not_permitted: "终端里的这段对话属于另一个系统用户，连接器无权结束它，所以没有接管。",
    takeover_failed: "结束终端里的这段对话失败了，所以没有接管。",
    terminal_busy: "终端里有人在输入（或正在回滚查看），等了 10 分钟也没空出来，这条消息没有发进去。稍后再发。",
    terminal_input_withdrawn:
      "这条消息已经排进终端里 Claude Code 的队列，但后来终端里有人把队列拉回了输入框（按了上键编辑），所以它没有作为手机消息发出，现在在终端的输入框里。要发，请在终端里回车，或从手机重发。",
    terminal_state_unknown:
      "连接器 10 分钟内都没法确认那个终端里的 Claude Code 还开着这段对话，这条消息没有发进去。看一眼终端，确认它还在这段对话里，再发一次。",
    terminal_gone: "终端那边的 tmux 窗格已经没了，这条消息没有发进去。",
    terminal_switched: "那个终端已经换到另一段对话了（在终端里 /resume 或 /clear 过），这条消息没有发进去。",
    terminal_input_failed: "往终端里输入这条消息失败了，没有发进去。",
    terminal_input_unseen:
      "这条消息输进终端后，等了 20 秒终端都没有显示它（那边的 Claude Code 正忙或没在接收输入），所以没有发出去。稍后再发一次。",
    terminal_input_unconfirmed: "消息已经输入终端，但终端的记录里没看到它，可能没发出去。去终端里看一眼。",
    terminal_input_unavailable: "连接器重启后没能再确认那个终端，这条消息没有发进去。重新 attach 一次。",
    empty_prompt: "这条消息去掉控制字符后是空的，没有发进终端。",
    read_only_live_session:
      "这段对话正开在那台机器的终端里，这边只能看、不能输入，这条消息没有发进去。在终端里输入，或先接管再发。",
    terminal_session: "这段对话开在终端里，模式由终端决定，这里改不了。",
    terminal_mode_not_allowed:
      '终端里这段对话的权限模式（例如 auto）不逐步询问，而这个 agent 的审批设置不允许从手机往这种模式里输入，这条消息没有发进去。在终端里按 shift+tab 切到会询问的模式（manual 或 plan）再发；或在那台机器的 agents.toml 里给这个 agent 设 `approval = "never"`。',
    terminal_mode_unknown:
      "连接器读不出终端里这段对话处于哪种权限模式，这条消息没有发进去。确认那边的 Claude Code 是新版、输入框下方显示着模式，再发一次。",
    terminal_screen_unknown:
      "连接器 30 秒内都认不出那个终端的画面（不是 Claude Code 的输入框，它也没说自己在忙），这条消息没有发进去。看一眼终端，关掉上面的东西再发。",
    terminal_command_refused:
      "以 ! 或 / 开头的消息会在那个终端里执行命令，所以不从手机输入。换个说法，或者在终端里自己执行。",
    takeover_expired: "接管确认到达那台机器时已经过期，没有接管。重新打开并再确认一次。",
    cwd_ambiguous: "这个 agent 有不止一个根目录里有同名文件夹。请写出完整路径。",
    root_unavailable:
      "那台机器上这个目录所在的盘没有响应（网络盘断了或还没挂上）。过一分钟再试，或在那台机器上检查挂载。",
    session_closed: "这个会话已经关了。",
    closed: "会话已按要求关闭。",
    stopped: "那台机器上的连接器停了。在那台机器上重新启动它（`claw-connector run`，或服务的 `sh keepalive.sh`）。",
    paused: "那台机器上的连接器暂停了。在那台机器上运行 `claw-connector resume`。",
    revoked: "那台机器的连接器已被注销。在那台机器上运行 `{login}` 重新登录。",
    text_required: "发给 agent 的消息是空的。",
    action_and_option_required: "这次批准缺少要回答的请求或选项。在卡片上再点一次。",
    too_many_queued_prompts: "agent 手上排队的消息太多了，这条没有收下。等它处理完再发。",
    cancelled: "这条消息还没运行就因为停止而被丢弃了。",
    unknown_action: "这个批准请求已经不在了。",
    option_not_offered: "这个选项不是 agent 提供的。",
  },
});

/** What `explain` adds after a reason's own sentence, and the sentence of a code it does not know. */
export const connectorReasonHints = defineCatalog({
  en: {
    upgrade: (p: { command: string }) =>
      `Upgrade the connector: on that machine run \`${p.command}\` (it installs the new version and restarts the connector on it).`,
    sandbox:
      'Workaround (only when the connector runs as root and the agent has `approval = "never"`): add ' +
      '`env = { IS_SANDBOX = "1" }` under that agent in agents.toml (or `IS_SANDBOX = "1"` in its existing `[agents.env]`), then ' +
      "restart the connector.",
    status: "Run `claw-connector status` on that machine and look for a warning or problem line.",
    newSession: "Start a new one with `/agent new`.",
    retry: "Try again in a moment.",
    unknown: (p: { code: string }) =>
      `The connector gave a reason I do not know (${p.code}). Run \`claw-connector status\` on that machine, or upgrade the ` +
      "connector and try again.",
    /** Between a lead and the reason after it, and the end of a lead with none. */
    leadSep: ": ",
    leadEnd: ".",
  },
  zh: {
    upgrade: (p) => `升级连接器：在那台机器上运行 \`${p.command}\`（会装上新版本并重启连接器）。`,
    sandbox:
      '临时绕过（仅当连接器以 root 运行、且该 agent 设了 `approval = "never"`）：在 agents.toml 里该 agent 下加 ' +
      '`env = { IS_SANDBOX = "1" }`（已有 `[agents.env]` 的，在其中加 `IS_SANDBOX = "1"`），再重启连接器。',
    status: "在那台机器上运行 `claw-connector status`，看有没有 warning 或 problem 行。",
    newSession: "用 `/agent new` 开一个新会话。",
    retry: "稍后再试一次。",
    unknown: (p) =>
      `连接器给出了一个我不认识的原因（${p.code}）。在那台机器上运行 \`claw-connector status\` 看看，或升级连接器后再试。`,
    leadSep: "：",
    leadEnd: "。",
  },
});
