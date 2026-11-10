// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/** What `/github ...` and the confirmation setting say to the person in their 1:1 chat (as the Python worker says it). */

export const accountText = {
  identityUnreachable: "I could not reach the Primus identity service just now. Please try again in a minute.",
  connectFirstLead: "I need to know which Primus account you are before I can connect GitHub to it. ",
  alreadyConnected: (login: string) =>
    `GitHub is already connected as \`${login}\`. Send \`/github unbind\` first if you want to connect a different account.`,
  alreadyWaiting:
    "I am already waiting for you to approve a code. Open the page from my earlier message, or send `/github unbind` to start over.",
  noCode: "GitHub did not give me a code just now. Please try `/github bind` again in a minute.",
  chooseWithBind:
    "请在批准代码之前或同时选一项；不选就是默认的第一项。 / Choose one before or while you approve the code; if you choose none, the first (the default) applies.",
  codeExpired: "The code ran out before it was approved. Send `/github bind` to get a new one.",
  codeDenied: "GitHub says the request was denied, so nothing was connected.",
  codeUnanswered: "GitHub did not answer while I waited for your approval. Send `/github bind` to try again.",
  primusGone: "Your Primus account is not connected to me any more. Connect it, then send `/github bind` again.",
  bindRefused: {
    invalid_scope: "GitHub gave a token with more permissions than the one I asked for, so I did not keep it.",
    unsupported_token: "That is not a token I can keep. Send `/github bind` and approve the code on the page.",
    invalid_token: "GitHub no longer accepts that token. Send `/github bind` to try again.",
    provider_unavailable:
      "The identity service could not check the token with GitHub just now, so nothing was stored. Send `/github bind` to try again.",
  } as Readonly<Record<string, string>>,
  bindNotAccepted: "The identity service did not accept the connection. Send `/github bind` to try again.",
  bindFailed: "Something went wrong while connecting GitHub. Send `/github bind` to try again.",
  connectedShort: (login: string) =>
    `已连上 GitHub（\`${login}\`）。 / GitHub is connected as \`${login}\`. \`/github status\` 查看，\`/github unbind\` 解除。 / \`/github status\` shows it, \`/github unbind\` removes it.`,
  choiceNotSaved:
    "I could not save your choice just now, and the setting may still be an earlier one (fully automatic included): check `/github status` and choose again with `/github mode`. / 没能保存你的选择，当前可能仍是之前的设置（包括全自动）；请用 `/github status` 查看，并用 `/github mode` 重新选择",
  connected: (login: string, confirmation: string) =>
    `GitHub is connected as \`${login}\`. Confirmation: ${confirmation}. Say "改成全自动" or send \`/github mode\` to change it. Auto-merge is off: until you send \`/github auto-merge on\` (it authorizes me once, for every request that names you), I do nothing with your account when a colleague asks me to review something as you. \`/github status\` shows both, \`/github unbind\` removes it.`,
  choiceInactive: "That choice is no longer active.",
  chosenWhileBinding: (en: string, zh: string) =>
    `Chosen: ${en}. It applies as soon as GitHub is connected. / 已选：${zh}，连接 GitHub 后生效。`,
  connectPrimusFirst: "Connect your Primus account first, then choose again. / 请先连接 Primus 账号再选。",
  connectGithubFirst: "Connect GitHub first: send `/github bind`. / 请先发 `/github bind` 连接 GitHub。",
  nothingChanged: (notYet: string) => `Nothing changed: ${notYet}。`,
  notSaved:
    "I could not save it just now; nothing changed. Choose again in a minute. / 暂时没能保存，没有改动，请稍后再选。",
  modeNow: (en: string, zh: string) =>
    `Confirmation is now: ${en}. It applies to every review and merge with your account. / 已改为：${zh}，对用你账号做的所有审阅和合入生效。`,
  notConnectedYet:
    "GitHub is not connected yet. Send `/github bind`: you choose this on its card. / 还没有连接 GitHub，请发 `/github bind`，在那张卡片上选。",
  modeNotConnected: "GitHub is not connected. Send `/github bind` to connect it; you choose this there.",
  pressToChange: "按下你要的那一项才会修改。 / Press the one you want; nothing changes until you do.",
  alreadyThisOne: (zh: string) => `现在已经是「${zh}」了。 / It is already this one. `,
  unbound: (removed: boolean) =>
    (removed ? "The stored GitHub token was deleted from the identity service." : "No GitHub account was connected.") +
    " To end the authorization on GitHub as well: Settings > Applications > Authorized OAuth Apps > GitHub CLI > Revoke. " +
    "Doing that also signs out the `gh` on your own computer.",
  statusNotConnected: "GitHub is not connected with `/github bind`. Send `/github bind` to connect it.",
  statusLogin: (login: string, expired: boolean) =>
    `GitHub: \`${login}\`${expired ? " (expired: send `/github bind` to connect it again)" : ""}`,
  statusPermission: (scopes: string, narrow: string) => `Permission: ${scopes}${narrow ? ` (${narrow})` : ""}`,
  statusValid: (until: string) => `Valid until: ${until}`,
  statusAutoMerge: (on: boolean) =>
    `Auto-merge (colleagues may ask me to review and merge as you): ${on ? "on" : "off"}`,
  statusConfirmation: (what: string) => `Confirmation (for every review and merge with your account): ${what}`,
  statusConfirmationUnknown: "not known just now (PrimusClaw did not answer) / 暂时读不到",
  statusLastUsed: (at: string) => `Last used: ${at}`,
  autoMergeIs: (on: boolean) =>
    `Auto-merge is ${on ? "on" : "off"}. Send \`/github auto-merge on\` or \`off\` to change it.`,
  connectGithubFirstPlain: "Connect GitHub first: send `/github bind`.",
  autoMergeOn:
    "Auto-merge is on: this is your standing permission. When a colleague names you in a group chat (usually the author of the pull request), I review as you and, if nothing needs fixing and every GitHub check passes, approve and merge as you, without asking each time. I message you after each one. A change to architecture, interfaces, security, CI or dependencies still waits for your own confirmation here. `/github auto-merge off` turns it off.",
  autoMergeOff:
    "Auto-merge is off. If a colleague names you, I do nothing with your account and tell them you have not authorized me.",
} as const;
