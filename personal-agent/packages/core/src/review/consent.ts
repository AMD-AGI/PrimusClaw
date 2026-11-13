// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/** What a person agrees to with `/github bind`, and how `/github status` says what the bot reads their GitHub with. */

import type { GithubConnection } from "../claw/model.js";
import { CONSENT_EN, CONSENT_READS, CONSENT_ZH } from "../locales/review-github.js";
import type { DeviceCode } from "../ports/github.js";

export const MAX_DEVICE_WAIT_SECONDS = 15 * 60;

/** The minutes a code is good for, as the person is told it. */
export function codeMinutes(code: DeviceCode): number {
  return Math.max(1, Math.floor(Math.min(code.expiresIn, MAX_DEVICE_WAIT_SECONDS) / 60));
}

function fill(template: string, code: DeviceCode, bot: string): string {
  return template
    .replaceAll("{uri}", code.verificationUri)
    .replaceAll("{code}", code.userCode)
    .replaceAll("{minutes}", String(codeMinutes(code)))
    .replaceAll("{bot}", bot);
}

/**
 * What `/github bind` asks the person to agree to, Chinese then English. `reads`: Claw reads GitHub with the binding too
 * (or could not say whether it does: then the wider use is what they are told), so the consent says that. `bot`: the bot's
 * name in this deployment.
 */
export function consentText(code: DeviceCode, reads: boolean, bot: string): string {
  let zh = CONSENT_ZH;
  let en = CONSENT_EN;
  if (reads) {
    for (const [old, now] of CONSENT_READS) {
      zh = zh.replaceAll(old, now);
      en = en.replaceAll(old, now);
    }
  }
  return `${fill(zh, code, bot)}\n\n---\n\n${fill(en, code, bot)}`;
}

/** The line of `/github status` that says whether the bot ("I") reads the person's GitHub with this binding, as Claw says it. */
export function readsLine(connection: GithubConnection | null, known: boolean): string {
  if (connection === null) {
    return known
      ? "用途：只用于代审，我不用它读你的 GitHub / Use: reviews only; I do not read your GitHub with it"
      : "我是否用它读 GitHub：暂时问不到 PrimusClaw / Whether I read your GitHub with it: PrimusClaw could not be asked just now";
  }
  if (connection.readsWith === "binding") {
    return (
      "我用这个令牌读你的 GitHub：你问 PR、CI、issue 时以你的身份只读查询，会写入的操作每次先问你 / I read your GitHub " +
      "with this token: when you ask about your pull requests, CI or issues it reads them as you; anything that would write " +
      "waits for your approval each time"
    );
  }
  if (connection.readsWith === "env") {
    return (
      "我读 GitHub 用的是你在 PrimusClaw 设置里保存的 GH_TOKEN，它优先于这里的绑定 / I read your GitHub with the " +
      "GH_TOKEN in your PrimusClaw settings, which comes before this binding"
    );
  }
  if (connection.bindingReads) {
    return (
      "我没法用它读你的 GitHub：这个授权用不了了（过期或被撤销），发 `/github bind` 重新连接 / I cannot read your GitHub with it " +
      "(expired or revoked): send `/github bind` to connect it again"
    );
  }
  return "用途：只用于代审，我现在还不用它读你的 GitHub / Use: reviews only; I do not read your GitHub with it yet";
}
