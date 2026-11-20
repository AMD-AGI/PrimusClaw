// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * What a reviewer who cannot be acted as yet is told, step by step, and what the asker is told about them: which step is
 * missing, and once all are done that the review can start. The reviewer's lines are in English and Chinese, as the
 * review service's other notices to a reviewer are; the asker's are in Chinese, as its other answers to the asker are.
 */

/** The steps that let a colleague have a review done as this person, in the order they can be done. */
export const ONBOARDING_STEPS = ["identity", "bind", "auto_merge", "link"] as const;
export type OnboardingStep = (typeof ONBOARDING_STEPS)[number];

const STEP_EN: Readonly<Record<OnboardingStep, string>> = {
  identity: "Connect your Primus account: press Confirm on the identity service card I sent you",
  bind: "Connect GitHub: send me `/github bind` here, enter the code it shows on GitHub and approve (the token is kept only in the Primus identity service)",
  auto_merge:
    "Allow reviews as you: send me `/github auto-merge on` here, so that I may use your GitHub account when a colleague asks you for a review (`/github auto-merge off` turns it off at any time)",
  link: "Link your own PrimusClaw key: send me `/link` here (a review asked of you runs on your own model quota)",
};

const STEP_ZH: Readonly<Record<OnboardingStep, string>> = {
  identity: "连接你的 Primus 账号：点我发给你的身份服务卡片上的确认",
  bind: "连接 GitHub：在这里发 `/github bind`，按提示在 GitHub 输入验证码并批准（令牌只存在 Primus 身份服务）",
  auto_merge:
    "开启代审授权：在这里发 `/github auto-merge on`，同事请你代审时我才能用你的 GitHub 账号（随时可以 `/github auto-merge off` 关闭）",
  link: "连接你自己的 PrimusClaw key：在这里发 `/link`（代审用你自己的模型额度）",
};

/** What the asker reads as the missing step. */
const STEP_SHORT: Readonly<Record<OnboardingStep, string>> = {
  identity: "连接 Primus 账号",
  bind: "发 `/github bind` 连接 GitHub",
  auto_merge: "发 `/github auto-merge on` 开启代审授权",
  link: "发 `/link` 连接自己的 PrimusClaw key",
};

/** The steps this person is shown: the three every reviewer needs, and their own key when it is missing. */
export function stepsShown(withLink: boolean): readonly OnboardingStep[] {
  return withLink ? ONBOARDING_STEPS : ONBOARDING_STEPS.slice(0, 3);
}

function checklist(steps: readonly OnboardingStep[], current: OnboardingStep, zh: boolean): string {
  const at = steps.indexOf(current);
  return steps
    .map((step, i) => {
      const mark =
        i < at ? (zh ? "（已完成）" : " (done)") : i === at ? (zh ? " ← 现在这一步" : " <- this step now") : "";
      return `${String(i + 1)}. ${(zh ? STEP_ZH : STEP_EN)[step]}${mark}`;
    })
    .join("\n");
}

export interface StepsAsked {
  /** Who asked ("" not known). */
  readonly asker: string;
  readonly group: boolean;
  readonly pulls: string;
  readonly merge: boolean;
}

export const onboardingText = {
  /** The reviewer's first message: what was asked of them, and every step with the one to do now marked. */
  first: (asked: StepsAsked, steps: readonly OnboardingStep[], current: OnboardingStep): string => {
    const n = String(steps.length);
    const verbEn = asked.merge ? "review and merge" : "review";
    const verbZh = asked.merge ? "review 合入" : "review";
    return (
      `${asked.asker || "A colleague"} asked me${asked.group ? " in a group chat" : ""} to ${verbEn} ${asked.pulls} as you; ` +
      `I have done nothing yet. To allow it there are ${n} steps, and as each is done I tell you the next:\n` +
      `${checklist(steps, current, false)}\n\n` +
      `${asked.asker || "有同事"}${asked.group ? "在群里" : ""}请我以你的名义 ${verbZh} ${asked.pulls}，我还什么都没有做。` +
      `如要允许，需要完成下面 ${n} 步，每完成一步我会告诉你下一步：\n${checklist(steps, current, true)}`
    );
  },
  /** A step (or more) was done: the next one, with every step marked. */
  next: (askers: string, steps: readonly OnboardingStep[], current: OnboardingStep): string => {
    const at = String(steps.indexOf(current) + 1);
    return (
      `Done so far, thank you. Next is step ${at} of ${String(steps.length)}, so that ${askers || "your colleague"} can have me review as you:\n` +
      `${checklist(steps, current, false)}\n\n` +
      `前面的步骤已完成。下一步是第 ${at} 步（共 ${String(steps.length)} 步），完成后 ${askers || "同事"} 就能请我以你的名义代审：\n` +
      checklist(steps, current, true)
    );
  },
  /** Every step is done. */
  allDone: (askers: string) =>
    `All steps are done. I told ${askers || "your colleague"} that a review can be asked of you now; nothing starts until they ask again.\n\n` +
    `全部完成。我已告诉 ${askers || "同事"} 现在可以请你代审了；TA 重新发起之前不会开始任何事。`,
  /** The buttons' card under a step. */
  bindPrompt: "Connect GitHub now? / 现在连接 GitHub？",
  bindButton: "Connect GitHub / 连接 GitHub",
  autoMergePrompt:
    "Allow reviews as you now? You can turn it off at any time with `/github auto-merge off`. / 现在开启代审授权？随时可以用 `/github auto-merge off` 关闭。",
  autoMergeButton: "Allow / 开启代审授权",
  declineButton: "Not now / 暂不开启",
  binding: "Connecting GitHub: the code follows. / 正在连接 GitHub，验证码见下一条。",
  allowed: "Done. / 已处理。",
  declined: "Understood: reviews as you stay off, and the colleague is told. / 好的，不开启代审授权，我会告诉同事。",
  notYours: "This button is for someone else. / 这个按钮不是给你的。",
  inactive: "This button is no longer active. / 这个按钮已失效。",
  oneToOne: "Please do this in your 1:1 chat with me. / 请在和我的 1:1 聊天里操作。",

  /** The asker, where they asked: which step the reviewer has left, and what happens next. */
  missing: (who: string, steps: readonly OnboardingStep[], current: OnboardingStep, sent: boolean, group: boolean) => {
    const at = steps.indexOf(current) + 1;
    const all = steps.map((s, i) => `${String(i + 1)}. ${STEP_SHORT[s]}`).join("；");
    const lead = `${who} 还不能被我代审：还差第 ${String(at)} 步「${STEP_SHORT[current]}」（共 ${String(steps.length)} 步：${all}），所以没有开始 review。`;
    const here = group ? "这个群里" : "这里";
    return sent
      ? `${lead}我已私信 TA 这几步；TA 每完成一步我会提示下一步，全部完成后我会在${here}告诉你，点一下就能按原请求重新发起。`
      : `${lead}我没能私信 ${who}；请 ${who} 在 1:1 里给我发任意一条消息，我会告诉 TA 剩下的步骤，全部完成后我会在${here}告诉你。`;
  },
  /** The asker, where they asked, once every step is done. */
  ready: (who: string, pulls: string, merge: boolean) =>
    `${who} 已完成授权，可以开始代审了。点下面的按钮，按原来的请求重新发起（${pulls}，${merge ? "review 合入" : "只 review"}）。`,
  readyTitle: "可以开始代审了",
  retryButton: "重新发起代审",
  retried: (pulls: string) => `已按原来的请求重新发起：${pulls}。`,
  onlyAsker: "只有发起这次代审的人可以重新发起。",
  retryGone: "这个按钮已失效（已用过或已过期），需要的话请再发一次请求。",
  /** The asker, where they asked, when the reviewer said no. */
  refused: (who: string, pulls: string) =>
    `${who} 选择暂不开启代审授权，所以 ${pulls} 的代审不会开始。需要的话请另请一位 reviewer。`,
} as const;
