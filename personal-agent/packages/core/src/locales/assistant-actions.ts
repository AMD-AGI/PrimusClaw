// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * What a press on Run / Cancel under a command the assistant put to the person, or on a held write's card, says
 * (teams_agent/agent.py `_action_click`, `_confirm_click`, `confirm_outcome`). The button texts the Python worker said in both
 * languages at once are kept so, byte for byte, in both catalogs; the rest is said in the person's language.
 */
import { defineCatalog } from "./catalog.js";
import type { Lang } from "./lang.js";

/** What upgrades a machine's claw-connector and restarts it on the new version (connector_setup.UPGRADE_COMMAND). */
export const CONNECTOR_UPGRADE_COMMAND =
  "npm install -g @primusclaw/connector@latest && claw-connector stop && claw-connector service install";

const upgrade: Readonly<Record<Lang, string>> = {
  zh: `在那台机器上运行 \`${CONNECTOR_UPGRADE_COMMAND}\` 升级并重启它。`,
  en: `On that machine, run \`${CONNECTOR_UPGRADE_COMMAND}\` to upgrade it and restart it.`,
};

type Words = Readonly<Record<string, Readonly<Record<Lang, string>>>>;

/** Why Claw did not do a held write the person let through, by its error word. */
export const CONFIRM_FAILED: Words = {
  trigger_limit_reached: {
    zh: "定时任务已经达到上限，先取消一个再来。",
    en: "You have as many scheduled tasks as allowed; cancel one first.",
  },
  no_credentials: {
    zh: "PrimusClaw 还没有你的密钥，之后没法以你的身份运行。先发我一条消息再试。",
    en: "PrimusClaw has no key of yours to run it with later. Send me a message first, then try again.",
  },
  not_found: { zh: "这个定时任务已经不在了。", en: "That scheduled task is no longer there." },
  invalid_arguments: {
    zh: "时间已经不成立了（比如截止时间已过），什么都没做。请重新跟我说一次。",
    en: "The schedule no longer holds (its end has passed, say); nothing was done. Ask me again.",
  },
};

/** Why Claw did not post a comment the person let through, by its error word. */
export const COMMENT_FAILED: Words = {
  no_github_token: {
    zh: "你还没有连接 GitHub，评论没有发出。先给我发 /github bind 连接一次，再让我发。",
    en: "Your GitHub is not connected, so the comment was not posted. Send me /github bind once, then ask again.",
  },
  github_binding_expired: {
    zh: "你的 GitHub 连接已过期，评论没有发出。发 /github bind 重新连接后再试。",
    en: "Your GitHub connection has expired, so the comment was not posted. Send /github bind, then try again.",
  },
  github_403: {
    zh: "GitHub 拒绝了：你的账号没有在这个仓库评论的权限。",
    en: "GitHub refused: your account may not comment in that repository.",
  },
  github_404: {
    zh: "GitHub 找不到这个 PR 或 issue（或你的账号看不到它）。",
    en: "GitHub cannot find that pull request or issue (or your account cannot see it).",
  },
};

/** Why Claw did not send an instruction the person let through, by its error word. */
export const DEVENV_SEND_FAILED: Words = {
  connector_offline: {
    zh: "那台机器现在离线，什么都没发。机器上的 claw-connector 恢复后再跟我说一次。",
    en: "That machine is offline now; nothing was sent. Ask me again once its claw-connector is back.",
  },
  busy: {
    zh: "那个会话正在做别的事，什么都没发。等它做完再跟我说一次。",
    en: "That session is working on something else; nothing was sent. Ask me again when it is done.",
  },
  session_closed: {
    zh: "那个会话已经关了，什么都没发。请再跟我说一次。",
    en: "That session has closed; nothing was sent. Ask me again.",
  },
  session_limit_reached: {
    zh: "开着的会话已经到上限，先关掉一个再来。",
    en: "You have as many open sessions as allowed; close one first.",
  },
  rate_limited: {
    zh: "一分钟内发得太多了，什么都没发。过一分钟再试。",
    en: "Too many instructions in the last minute; nothing was sent. Try again in a minute.",
  },
  no_machine: {
    zh: "那台机器已经不在你的开发环境里了，什么都没发。",
    en: "That machine is no longer one of your development environments; nothing was sent.",
  },
  connector_outdated: {
    zh: "那台机器上的连接器版本太旧，不能开新会话，什么都没发。" + upgrade.zh + "然后再跟我说一次。",
    en:
      "That machine's connector is too old for a new session; nothing was sent. " + upgrade.en + " Then ask me again.",
  },
  machine_reconnected: {
    zh: "这台机器在这张卡之后重新连接过，卡上的会话已经不在了，什么都没发。请再跟我说一次。",
    en:
      "That machine connected again since this card was made and the session on it is gone; nothing was sent. " +
      "Ask me again.",
  },
};

/** Run / Cancel under a command the assistant put to the person, and a held write's card that cannot be answered. */
const buttons = {
  actionGone: "这个按钮已失效。 / That button is no longer valid.",
  actionUsed: "这个按钮已经按过了。 / That button was already pressed.",
  confirmGone:
    "这张卡已失效，什么都没做。需要的话请再跟我说一次。 / That card is no longer valid; nothing was done. Ask me again if you want it.",
  confirmUsed: "这张卡已经按过了。 / That card was already answered.",
  notRun: (p: { text: string }) => `没有执行 ${p.text}。 / ${p.text} was not run.`,
  actionInvalid: (p: { text: string }) =>
    `这个按钮已失效，没有执行。需要的话请直接发 ${p.text}。 / ` +
    `That button is no longer valid, so nothing was run. Send ${p.text} if you want it.`,
  ran: (p: { text: string }) => `已执行 ${p.text}。 / Ran ${p.text}.`,
  couldNotRun: (p: { text: string }) => `没能执行 ${p.text}。 / ${p.text} could not be run.`,
};

export const assistantActionText = defineCatalog({
  en: {
    ...buttons,
    noExchange:
      "This card is answered with your sign-in, and the identity service is not on here, so I cannot answer it for you. " +
      "It lapses in a day.",
    notBound:
      "This chat is not connected to your Primus account through the identity service, so I cannot answer for you. " +
      "Connect, then press it again.",
    exchangeFailed: "I could not reach the Primus platform; nothing was done. Press it again in a moment.",
    clawSilent: "PrimusClaw did not answer; nothing was done. Press it again.",
    nothingDone: "Nothing was done.",
    commentPosted: (p: { link: string }) => (p.link ? `Comment posted: [see it](${p.link})` : "Comment posted."),
    commentDenied: "OK, not posted.",
    commentNotPosted: (p: { why: string }) => `The comment could not be posted (${p.why}).`,
    triggerCancelled: "Cancelled; it will not run again.",
    scheduled: (p: { name: string; schedule: string; tz: string; next: string }) =>
      `Scheduled "${p.name}": ${p.schedule} (${p.tz}), next run ${p.next}. Each result comes here.`,
    alreadyAnswered: "That card was already answered.",
    notCreated: "OK, not created.",
    notCancelled: "OK, not cancelled.",
    expired: "That card has expired; nothing was done. Ask me again if you want it.",
    notDone: (p: { why: string }) => `It could not be done (${p.why}).`,
    sent: (p: { agent: string; machine: string; seq: string }) =>
      `Sent to ${p.agent} on ${p.machine}${p.seq ? ` as #${p.seq}` : ""}. ` +
      "I will tell you when it is done or needs your approval.",
    notSent: "OK, not sent.",
    sendExpired: "That card has expired; nothing was sent. Ask me again if you want it.",
    notSentWhy: (p: { why: string }) => `It could not be sent (${p.why}).`,
  },
  zh: {
    ...buttons,
    noExchange: "这张卡要用你的登录身份确认，但这里没有开启身份服务，所以没法替你点。它一天后自动失效。",
    notBound: "这个聊天还没通过身份服务连到你的 Primus 账号，没法替你确认。连接后再按一次。",
    exchangeFailed: "没连上 Primus 平台，什么都没做，请过一会儿再按一次。",
    clawSilent: "PrimusClaw 没有回应，什么都没做，请再点一次。",
    nothingDone: "什么都没做。",
    commentPosted: (p) => (p.link ? `评论已发出：[查看评论](${p.link})` : "评论已发出。"),
    commentDenied: "好的，没有发。",
    commentNotPosted: (p) => `评论没能发出（${p.why}）。`,
    triggerCancelled: "已取消这个定时任务，它不会再运行。",
    scheduled: (p) => `已创建定时任务「${p.name}」：${p.schedule}（${p.tz}），下次 ${p.next}。每次结果会发到这里。`,
    alreadyAnswered: "这张卡已经处理过了。",
    notCreated: "好的，没有创建。",
    notCancelled: "好的，没有取消。",
    expired: "这张卡已过期，什么都没做。需要的话请再跟我说一次。",
    notDone: (p) => `没能完成（${p.why}）。`,
    sent: (p) => `已发给 ${p.machine} 上的 ${p.agent}${p.seq ? `（#${p.seq}）` : ""}。做完或需要你批准时我会告诉你。`,
    notSent: "好的，没有发送。",
    sendExpired: "这张卡已过期，什么都没发。需要的话请再跟我说一次。",
    notSentWhy: (p) => `没能发送（${p.why}）。`,
  },
});
