// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * How Teams shows the review delegation's views: the confirmation-setting card, the card a reviewer confirms a held write
 * on, a review item's card with Stop and its end, and the GitHub connect card. Single column, Action.Execute and OpenUrl
 * only. Byte for byte the Python worker's `render.review_mode_card`, `github_confirm_card`, `review_item_card`,
 * `ended_item_card` and `github_connect_card` (snapshots `review_mode`, `review_confirm_merge`, `review_confirm_post`,
 * `review_start`, `review_end`, `github_connect`).
 */
import {
  REVIEW_MODES,
  githubConfirmButtons,
  type EndedItemView,
  type GithubConfirmView,
  type GithubConnectView,
  type ReviewItemView,
  type ReviewModeView,
} from "@primusclaw/personal-agent";

import { clip } from "../../cards/cjk.js";
import type { CardElement } from "../../cards/json.js";
import {
  buttons,
  execute,
  facts,
  fold,
  header,
  message,
  note,
  openUrl,
  text,
  type CardMessage,
} from "../../cards/kit.js";
import { action } from "../turn/note.js";
import type { Renderers } from "../registry.js";
import { own } from "@primusclaw/personal-agent";

const MARKDOWN = /([\\`*_[\]<])/gu;

/** `text` for a card TextBlock, which reads markdown: its markup characters escaped. */
export function plain(value: string): string {
  return value.replace(MARKDOWN, "\\$1");
}

const MODE_WHAT: Readonly<Record<string, readonly [string, string]>> = {
  high_risk_confirm: [
    "审完没有问题、检查全部通过时直接批准并合入；模型判断为高风险的变更（安全、凭据、CI/发布、权限、数据迁移等）以及仓库要求确认的变更，先发卡片请你本人确认。",
    "Approved and merged when nothing needs fixing and every check passes; a change the reviewing model judges high risk (security, credentials, CI/release, permissions, data migrations, ...) or one the repository asks to confirm waits for your own click on a card.",
  ],
  fully_auto: [
    "审完没有问题、检查全部通过时直接批准并合入，不再请你确认；只有仓库自己要求确认的变更（.github/claw-review.yml 的 confirm_merge: always 等）仍会先问你。",
    "Approved and merged when nothing needs fixing and every check passes, without asking you; only a change the repository itself requires a person for (confirm_merge: always in its review config, and the like) still waits for your click.",
  ],
};
const MODE_BUTTON: Readonly<Record<string, string>> = { high_risk_confirm: "高风险再问我", fully_auto: "全自动合入" };

/** The button that adds the app for a person (none when no such link is configured). */
function addAppButton(installUrl: string, bot: string): CardElement[] {
  return installUrl ? [openUrl(`添加 ${bot}`, installUrl)] : [];
}

export function reviewModeCard(model: ReviewModeView): CardMessage {
  // (a mode that is not one of them, "constructor" included, is no mode: as Python's `in REVIEW_MODES`)
  const known = (mode: string): boolean => Object.hasOwn(REVIEW_MODES, mode);
  const first = known(model.suggested) ? model.suggested : "high_risk_confirm";
  const order = [first, ...Object.keys(REVIEW_MODES).filter((m) => m !== first)];
  const now = known(model.current) ? `当前：${MODE_BUTTON[model.current] ?? ""}` : "还没有设置，默认是第一项";
  const body: CardElement[] = [header("选择代审合入的确认方式", { tone: "accent", subtitle: now, emoji: "settings" })];
  if (model.lead) body.push(text(model.lead));
  const english: CardElement[] = [];
  for (const mode of order) {
    const [zh, en] = own(REVIEW_MODES, mode) ?? ["", ""];
    const [whatZh = "", whatEn = ""] = own(MODE_WHAT, mode) ?? [];
    const current = mode === model.current;
    body.push({
      type: "Container",
      spacing: "Medium",
      items: [
        text(zh + (current ? "（当前）" : ""), { weight: "Bolder" }),
        text(whatZh, { subtle: true, spacing: "Small" }),
      ],
    });
    english.push(text(`**${en}**${current ? " (current)" : ""}: ${whatEn}`, { size: "Small" }));
  }
  body.push(
    note(
      `这个设置对你自己让 ${model.bot} 审 PR、以及同事请你代审都生效。是否允许同事以你的名义请我审并合入，是另一个开关：\`/github auto-merge on|off\`。`,
    ),
  );
  english.push(
    text(
      `This applies when you ask ${model.bot} to review a pull request and when a colleague asks ${model.bot} to review one as you. Whether colleagues may ask at all is the other switch, \`/github auto-merge on|off\`.`,
      { size: "Small" },
    ),
  );
  body.push(...fold("review-mode-en", english, "English"));
  // (the card is Chinese: a bilingual hint keeps its Chinese half)
  if (model.hint) body.push(note(model.hint.split(" / ")[0] ?? ""));
  const choices = order.map((m) =>
    execute(own(MODE_BUTTON, m) ?? m, "primusclaw.github_mode", { primusclaw: "github_mode", mode: m }),
  );
  return message(body, buttons([...choices, ...(model.hint ? addAppButton(model.installUrl, model.bot) : [])]));
}

/** The line under a confirmation card for a person whose buttons may not work: the answer they can type instead. */
function typedConfirmHint(number: number, lang: "zh" | "en"): string {
  const n = clip(String(number), 10);
  return lang === "zh"
    ? `按钮点不了时，直接回复「确认 #${n}」或「拒绝 #${n}」即可。`
    : `If the buttons do not work, reply 确认 #${n} or 拒绝 #${n}.`;
}

interface ConfirmWords {
  readonly heading: string;
  readonly sub: string;
  readonly impact: string;
  readonly rows: [string, string][];
  readonly more: [string, string][];
}

/** The labels of the confirmation card, by language. */
const CONFIRM_LABELS = {
  zh: {
    pull: "PR",
    author: "作者",
    verdict: "结论",
    summary: "概述",
    text: "内容",
    target: "分支",
    checks: "检查",
    why: "原因",
    notRead: "没读到",
    reasonsJoin: "；",
    noReasons: "在总是需要人确认的变更清单上",
    repo: "仓库",
    model: "模型",
    defaultModel: "默认模型",
    account: "账号",
    inline: (n: number) => `，${String(n)} 条行内评论`,
  },
  en: {
    pull: "Pull request",
    author: "Author",
    verdict: "Review",
    summary: "What it does",
    text: "Text",
    target: "Target",
    checks: "Checks",
    why: "Why",
    notRead: "not read",
    reasonsJoin: "; ",
    noReasons: "It is on the list of changes that always need a person.",
    repo: "Repository",
    model: "Model",
    defaultModel: "the default",
    account: "Acts as",
    inline: (n: number) => `, ${String(n)} inline comment${n !== 1 ? "s" : ""}`,
  },
} as const;

function confirmRows(m: GithubConfirmView, account: string): Pick<ConfirmWords, "rows" | "more"> {
  const l = CONFIRM_LABELS[m.lang];
  const rows: [string, string][] = [
    [l.pull, `#${clip(String(m.number), 10)} ${clip(m.title, 120)}`],
    [l.author, clip(m.author, 60)],
  ];
  const held = m.review;
  if (held !== undefined) rows.push([l.verdict, clip(held.event, 20) + (held.comments ? l.inline(held.comments) : "")]);
  if (m.summary) rows.push([l.summary, m.summary]);
  if (held !== undefined) rows.push([l.text, clip(held.body, 200)]);
  else rows.push([l.target, m.base ? clip(m.base, 100) : l.notRead], [l.checks, clip(m.checks, 80)]);
  const reasons = m.reasons
    .slice(0, 5)
    .filter(Boolean)
    .map((r) => clip(r, 100));
  rows.push([l.why, m.reasons.some(Boolean) ? reasons.join(l.reasonsJoin) : l.noReasons]);
  const more: [string, string][] = [
    [l.repo, clip(m.repo, 100)],
    ["Head", clip(m.headSha, 12)],
    [l.model, m.model ? clip(m.model, 100) : l.defaultModel],
    [l.account, account],
  ];
  return { rows, more };
}

function confirmHeadZh(m: GithubConfirmView, account: string): Omit<ConfirmWords, "rows" | "more"> {
  const pull = `${clip(m.repo, 100)}#${clip(String(m.number), 10)}`;
  const into = m.base ? `\`${clip(m.base.replaceAll("`", ""), 100)}\`` : "";
  const asked = m.room ? `${clip(m.requester, 60)} 在 ${clip(m.room, 60)} 请求` : `${clip(m.requester, 60)} 请求`;
  if (m.review !== undefined) {
    return {
      heading: "发布 review 前需要你确认",
      sub: `${asked}，我以你的身份发布`,
      impact: `确认后：在 ${pull} 上以${account} 发布 ${clip(m.review.event, 20)} review。`,
    };
  }
  return {
    heading: "合入前需要你确认",
    sub: `${asked}，我以你的身份合入`,
    impact: `确认后：把 ${pull} 合入 ${into || "它的目标分支（没读到，请在 PR 上核对）"}，用${account}。`,
  };
}

function confirmHeadEn(m: GithubConfirmView, account: string): Omit<ConfirmWords, "rows" | "more"> {
  const pull = `${clip(m.repo, 100)}#${clip(String(m.number), 10)}`;
  const into = m.base ? `\`${clip(m.base.replaceAll("`", ""), 100)}\`` : "";
  const asker = clip(m.requester, 60) + (m.room ? ` in ${clip(m.room, 60)}` : "");
  if (m.review !== undefined) {
    return {
      heading: "This review needs your confirmation",
      sub: `Asked by ${asker}. I act as you, so the review is posted as yours`,
      impact: `If you confirm: a ${clip(m.review.event, 20)} review is posted on ${pull} with ${account}.`,
    };
  }
  return {
    heading: "This merge needs your confirmation",
    sub: `Asked by ${asker}. I act as you, so the merge is yours`,
    impact: `If you confirm: ${pull} is merged into ${into || "its base branch (not read from GitHub; check it on the pull request)"}, by ${account}.`,
  };
}

function accountOf(m: GithubConfirmView): string {
  const who = clip(m.login, 40);
  if (m.lang === "zh") return who ? `你的 GitHub 账号 @${who}` : "你的 GitHub 账号";
  return who ? `your GitHub account @${who}` : "your GitHub account";
}

export function githubConfirmCard(m: GithubConfirmView): CardMessage {
  const account = accountOf(m);
  const head = m.lang === "zh" ? confirmHeadZh(m, account) : confirmHeadEn(m, account);
  const { rows, more } = confirmRows(m, account);
  const body: CardElement[] = [
    header(head.heading, { tone: "warning", subtitle: head.sub, emoji: "needs_you" }),
    text(head.impact),
    ...facts(rows, 400),
    ...fold("confirm-more", facts(more), m.lang === "zh" ? "更多信息" : "More"),
  ];
  if (m.hint) body.push(note(typedConfirmHint(m.number, m.lang)));
  const actions = buttons(githubConfirmButtons(m.confirmationId, m.review !== undefined, m.lang).map(action));
  return message(body, [...actions, ...(m.hint ? addAppButton(m.installUrl, m.bot) : [])]);
}

/** The colour of a review card's band once the review ended, from the line that says how. */
export function endedTone(ended: string): "attention" | "good" | "default" | "accent" {
  const low = ended.toLowerCase();
  if (["失败", "出错", "fail", "error"].some((w) => low.includes(w))) return "attention";
  const merged = ["已合入", "批准", "merged", "approve"].some((w) => low.includes(w));
  if (merged && !["没有合入", "not merged"].some((w) => low.includes(w))) return "good";
  if (["停止", "stopped"].some((w) => low.includes(w))) return "default";
  return "accent";
}

const SUMMARY_LABEL = { zh: "PR 概述：", en: "What it does: " } as const;

const ITEM_WORDS = {
  zh: {
    ended: "代审结束：",
    queued: "排队中：",
    running: "代审中：",
    as: "身份",
    mode: "方式",
    model: "模型",
    nobody: "对方",
    reviewOnly: "只 review，不合入",
    merge: "review，通过就合入",
    stop: "停止",
    hintQueued: "名额空出后会自动开始；点「停止」随时取消。",
    hint: "点「停止」随时停下；已经合入的不会撤回。",
  },
  en: {
    ended: "Review ended: ",
    queued: "Queued: ",
    running: "Reviewing: ",
    as: "As",
    mode: "Mode",
    model: "Model",
    nobody: "the reviewer",
    reviewOnly: "review only, no merge",
    merge: "review, and merge when it passes",
    stop: "Stop",
    hintQueued: "It starts by itself when a slot frees up; press Stop to cancel it.",
    hint: "Press Stop at any time; a merge already done is not undone.",
  },
} as const;

const ENDED_MEANING = { good: "good", attention: "failed", default: "stopped", accent: "review" } as const;

export function reviewItemCard(m: ReviewItemView, ended = "", summary = ""): CardMessage {
  const w = ITEM_WORDS[m.lang];
  const queued = m.queued && !ended;
  const who = plain(clip(m.who, 60));
  const pr = plain(clip(m.seq ? `#${String(m.seq)} ${m.pull}` : m.pull, 120));
  const title = (ended ? w.ended : queued ? w.queued : w.running) + pr;
  const rows: [string, string][] = [
    [w.as, who || w.nobody],
    [w.mode, m.reviewOnly ? w.reviewOnly : w.merge],
    [w.model, plain(clip(m.model, 80))],
  ];
  const tone = ended ? endedTone(ended) : "accent";
  const body: CardElement[] = [header(title, { tone, emoji: ENDED_MEANING[tone] }), ...facts(rows)];
  body.push(ended ? text(plain(clip(ended, 200)), { weight: "Bolder" }) : note(queued ? w.hintQueued : w.hint));
  if (ended && summary) body.push(text(plain(SUMMARY_LABEL[m.lang] + summary)));
  const stop = execute(w.stop, "primusclaw.work_stop", { primusclaw: "work", op: "stop", card: m.cardId });
  return message(body, ended ? [] : buttons([stop], "destructive"));
}

export const ITEM_CARD_ENDED_PLAIN_ZH = "已结束，见上方结果";

/** A review card's model again, from what it showed; undefined when `render` is not a complete one. */
function reviewOfRender(render: Readonly<Record<string, unknown>>, cardId: string): ReviewItemView | undefined {
  const seq = Number(render.seq ?? 0);
  if (render.kind !== "review" || typeof render.pull !== "string" || !Number.isInteger(seq)) return undefined;
  return {
    seq,
    pull: render.pull,
    who: typeof render.who === "string" ? render.who : "",
    reviewOnly: Boolean(render.review_only),
    model: typeof render.model === "string" ? render.model : "",
    cardId,
    lang: render.lang === "en" ? "en" : "zh",
    queued: false,
  };
}

export function endedItemCard(m: EndedItemView): CardMessage {
  const render = m.render;
  const review = m.ended === ITEM_CARD_ENDED_PLAIN_ZH ? undefined : reviewOfRender(render, m.cardId);
  if (review !== undefined) {
    return reviewItemCard(review, m.ended, typeof render.pr_summary === "string" ? render.pr_summary : "");
  }
  const shown =
    typeof render.title === "string" && render.title
      ? render.title
      : typeof render.pull === "string"
        ? render.pull
        : "";
  let label = plain(clip(shown, 120));
  const seq = typeof render.seq === "number" || typeof render.seq === "string" ? render.seq : "";
  if (seq && label && !label.startsWith("#")) label = `#${String(seq)} ${label}`;
  const title = label ? (render.kind === "review" ? "代审结束：" : "已结束：") + label : "已结束";
  return message([header(title, { tone: endedTone(m.ended) }), text(plain(clip(m.ended, 200)), { weight: "Bolder" })]);
}

export function githubConnectCard(m: GithubConnectView): CardMessage {
  const asked = clip(m.question, 120);
  const minutes = String(m.minutes);
  const code = clip(m.code, 20);
  const zh = m.lang === "zh";
  const more = zh
    ? "申请 `repo` 权限，你能访问的私有、内部仓库也读得到。令牌加密存在 Primus 身份服务，只在服务端用：你问 GitHub 时以你的身份读取，会写入的操作每次先问你；同事在群里点你名请你代审时也用它（要你先开 `/github auto-merge on`）。`/github unbind` 随时解除。"
    : "It asks for `repo`, so I can read the private and internal repositories you can reach too. The token is kept encrypted in the Primus identity service and used on the server only: to read your GitHub as you when you ask, with anything that would write waiting for your approval each time; and when a colleague names you for a review (once you turn on `/github auto-merge on`). `/github unbind` removes it at any time.";
  const body: CardElement[] = zh
    ? [
        header("连上 GitHub，我就能读到你的 PR 和 CI", {
          tone: "accent",
          subtitle: "你问的是你 GitHub 上的事，我还读不到。连一次就好。",
          emoji: "connect",
        }),
        ...facts([["验证码", `${code}（${minutes} 分钟内有效）`]]),
        text(
          `1. 点「打开 GitHub」，输入上面的验证码\n2. 页面上的应用名是 “GitHub CLI”，这是正常的；用你自己的账号批准\n3. 批准后我用你的 GitHub 再回答一次：「${asked}」`,
        ),
        ...fold("github-connect-more", [text(more, { subtle: true, size: "Small" })], "权限和安全"),
      ]
    : [
        header("Connect GitHub so I can read your pull requests and CI", {
          tone: "accent",
          subtitle: "This is about your GitHub, which I cannot read yet. Connect it once.",
          emoji: "connect",
        }),
        ...facts([["Code", `${code} (works for ${minutes} minutes)`]]),
        text(
          `1. Press Open GitHub and enter the code above\n2. The page names the application "GitHub CLI"; that is expected. Approve it with your own account\n3. Then I answer again with your GitHub: "${asked}"`,
        ),
        ...fold("github-connect-more", [text(more, { subtle: true, size: "Small" })], "Permissions and safety"),
      ];
  const [open, later] = zh ? ["打开 GitHub", "先不连"] : ["Open GitHub", "Not now"];
  return message(
    body,
    buttons([
      openUrl(open, m.uri),
      execute(later, "primusclaw.github_connect", { primusclaw: "github_connect", op: "dismiss", card: m.cardId }),
    ]),
  );
}

export const REVIEW_RENDERERS: Pick<
  Renderers,
  "reviewMode" | "githubConfirm" | "reviewItem" | "endedItem" | "githubConnect"
> = {
  reviewMode: reviewModeCard,
  githubConfirm: githubConfirmCard,
  reviewItem: (m) => reviewItemCard(m),
  endedItem: endedItemCard,
  githubConnect: githubConnectCard,
};
