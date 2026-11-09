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
import { BOT_NAME } from "@primusclaw/personal-agent";

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
    "审完没有问题、检查全部通过时直接批准并合入，不再请你确认；只有仓库自己要求确认的变更（.github/clawy.yml 的 confirm_merge: always 等）仍会先问你。",
    "Approved and merged when nothing needs fixing and every check passes, without asking you; only a change the repository itself requires a person for (confirm_merge: always in its review config, and the like) still waits for your click.",
  ],
};
const MODE_BUTTON: Readonly<Record<string, string>> = { high_risk_confirm: "高风险再问我", fully_auto: "全自动合入" };

/** The button that adds the app for a person (none when no such link is configured). */
function addAppButton(installUrl: string): CardElement[] {
  return installUrl ? [openUrl(`添加 ${BOT_NAME}`, installUrl)] : [];
}

export function reviewModeCard(model: ReviewModeView): CardMessage {
  const first = model.suggested || "high_risk_confirm";
  const order = [first, ...Object.keys(REVIEW_MODES).filter((m) => m !== first)];
  const now = model.current ? `当前：${MODE_BUTTON[model.current] ?? ""}` : "还没有设置，默认是第一项";
  const body: CardElement[] = [header("选择代审合入的确认方式", { tone: "accent", subtitle: now, emoji: "settings" })];
  if (model.lead) body.push(text(model.lead));
  const english: CardElement[] = [];
  for (const mode of order) {
    const [zh, en] = REVIEW_MODES[mode as keyof typeof REVIEW_MODES];
    const [whatZh = "", whatEn = ""] = MODE_WHAT[mode] ?? [];
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
      "这个设置对你自己让 Clawy 审 PR、以及同事请你代审都生效。是否允许同事以你的名义请我审并合入，是另一个开关：`/github auto-merge on|off`。",
    ),
  );
  english.push(
    text(
      "This applies when you ask Clawy to review a pull request and when a colleague asks Clawy to review one as you. Whether colleagues may ask at all is the other switch, `/github auto-merge on|off`.",
      { size: "Small" },
    ),
  );
  body.push(...fold("review-mode-en", english, "English"));
  // (the card is Chinese: a bilingual hint keeps its Chinese half)
  if (model.hint) body.push(note(model.hint.split(" / ")[0] ?? ""));
  const choices = order.map((m) =>
    execute(MODE_BUTTON[m] ?? m, "primusclaw.github_mode", { primusclaw: "github_mode", mode: m }),
  );
  return message(body, buttons([...choices, ...(model.hint ? addAppButton(model.installUrl) : [])]));
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

function confirmWordsZh(m: GithubConfirmView, account: string, inline: number, event: string): ConfirmWords {
  const pull = `${clip(m.repo, 100)}#${clip(String(m.number), 10)}`;
  const into = m.base ? `\`${clip(m.base.replaceAll("`", ""), 100)}\`` : "";
  const held = m.review !== undefined;
  const sub =
    (m.room ? `${clip(m.requester, 60)} 在 ${clip(m.room, 60)} 请求` : `${clip(m.requester, 60)} 请求`) +
    (held ? "，我以你的身份发布" : "，我以你的身份合入");
  const impact = held
    ? `确认后：在 ${pull} 上以${account} 发布 ${event} review。`
    : `确认后：把 ${pull} 合入 ${into || "它的目标分支（没读到，请在 PR 上核对）"}，用${account}。`;
  const rows: [string, string][] = [
    ["PR", `#${clip(String(m.number), 10)} ${clip(m.title, 120)}`],
    ["作者", clip(m.author, 60)],
  ];
  if (held) {
    rows.push(["结论", event + (inline ? `，${String(inline)} 条行内评论` : "")]);
    if (m.summary) rows.push(["概述", m.summary]);
    rows.push(["内容", clip(String(m.review?.body ?? ""), 200)]);
  } else {
    if (m.summary) rows.push(["概述", m.summary]);
    rows.push(["分支", m.base ? clip(m.base, 100) : "没读到"], ["检查", clip(m.checks, 80)]);
  }
  const reasons = m.reasons
    .slice(0, 5)
    .filter(Boolean)
    .map((r) => clip(r, 100));
  rows.push(["原因", m.reasons.some(Boolean) ? reasons.join("；") : "在总是需要人确认的变更清单上"]);
  const more: [string, string][] = [
    ["仓库", clip(m.repo, 100)],
    ["Head", clip(m.headSha, 12)],
    ["模型", m.model ? clip(m.model, 100) : "默认模型"],
    ["账号", account],
  ];
  return { heading: held ? "发布 review 前需要你确认" : "合入前需要你确认", sub, impact, rows, more };
}

function confirmWordsEn(m: GithubConfirmView, account: string, inline: number, event: string): ConfirmWords {
  const pull = `${clip(m.repo, 100)}#${clip(String(m.number), 10)}`;
  const into = m.base ? `\`${clip(m.base.replaceAll("`", ""), 100)}\`` : "";
  const held = m.review !== undefined;
  const asker = clip(m.requester, 60) + (m.room ? ` in ${clip(m.room, 60)}` : "");
  const impact = held
    ? `If you confirm: a ${event} review is posted on ${pull} with ${account}.`
    : `If you confirm: ${pull} is merged into ${into || "its base branch (not read from GitHub; check it on the pull request)"}, by ${account}.`;
  const rows: [string, string][] = [
    ["Pull request", `#${clip(String(m.number), 10)} ${clip(m.title, 120)}`],
    ["Author", clip(m.author, 60)],
  ];
  if (held) {
    rows.push(["Review", event + (inline ? `, ${String(inline)} inline comment${inline !== 1 ? "s" : ""}` : "")]);
    if (m.summary) rows.push(["What it does", m.summary]);
    rows.push(["Text", clip(String(m.review?.body ?? ""), 200)]);
  } else {
    if (m.summary) rows.push(["What it does", m.summary]);
    rows.push(["Target", m.base ? clip(m.base, 100) : "not read"], ["Checks", clip(m.checks, 80)]);
  }
  const reasons = m.reasons
    .slice(0, 5)
    .filter(Boolean)
    .map((r) => clip(r, 100));
  rows.push([
    "Why",
    m.reasons.some(Boolean) ? reasons.join("; ") : "It is on the list of changes that always need a person.",
  ]);
  const more: [string, string][] = [
    ["Repository", clip(m.repo, 100)],
    ["Head", clip(m.headSha, 12)],
    ["Model", m.model ? clip(m.model, 100) : "the default"],
    ["Acts as", account],
  ];
  return {
    heading: held ? "This review needs your confirmation" : "This merge needs your confirmation",
    sub: `Asked by ${asker}. I act as you, so the ${held ? "review is posted as yours" : "merge is yours"}`,
    impact,
    rows,
    more,
  };
}

export function githubConfirmCard(m: GithubConfirmView): CardMessage {
  const zh = m.lang === "zh";
  const who = clip(m.login, 40);
  const account = zh
    ? who
      ? `你的 GitHub 账号 @${who}`
      : "你的 GitHub 账号"
    : who
      ? `your GitHub account @${who}`
      : "your GitHub account";
  const comments = m.review?.comments;
  const inline = Array.isArray(comments) ? comments.length : 0;
  const event = m.review === undefined ? "" : clip(String(m.review.event ?? ""), 20);
  const words = zh ? confirmWordsZh(m, account, inline, event) : confirmWordsEn(m, account, inline, event);
  const body: CardElement[] = [
    header(words.heading, { tone: "warning", subtitle: words.sub, emoji: "needs_you" }),
    text(words.impact),
    ...facts(words.rows, 400),
    ...fold("confirm-more", facts(words.more), zh ? "更多信息" : "More"),
  ];
  if (m.hint) body.push(note(typedConfirmHint(m.number, m.lang)));
  const actions = buttons(githubConfirmButtons(m.confirmationId, m.review !== undefined, m.lang).map(action));
  return message(body, [...actions, ...(m.hint ? addAppButton(m.installUrl) : [])]);
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

export function reviewItemCard(m: ReviewItemView, ended = "", summary = ""): CardMessage {
  const zh = m.lang === "zh";
  const queued = m.queued && !ended;
  const who = plain(clip(m.who, 60));
  const model = plain(clip(m.model, 80));
  const pr = plain(clip(m.seq ? `#${String(m.seq)} ${m.pull}` : m.pull, 120));
  const title =
    (zh
      ? ended
        ? "代审结束："
        : queued
          ? "排队中："
          : "代审中："
      : ended
        ? "Review ended: "
        : queued
          ? "Queued: "
          : "Reviewing: ") + pr;
  const rows: [string, string][] = zh
    ? [
        ["身份", who || "对方"],
        ["方式", m.reviewOnly ? "只 review，不合入" : "review，通过就合入"],
        ["模型", model],
      ]
    : [
        ["As", who || "the reviewer"],
        ["Mode", m.reviewOnly ? "review only, no merge" : "review, and merge when it passes"],
        ["Model", model],
      ];
  const hint = zh
    ? queued
      ? "名额空出后会自动开始；点「停止」随时取消。"
      : "点「停止」随时停下；已经合入的不会撤回。"
    : queued
      ? "It starts by itself when a slot frees up; press Stop to cancel it."
      : "Press Stop at any time; a merge already done is not undone.";
  const tone = ended ? endedTone(ended) : "accent";
  const meaning = ended
    ? (({ good: "good", attention: "failed", default: "stopped" } as const)[tone as "good"] ?? "review")
    : "review";
  const body: CardElement[] = [header(title, { tone, emoji: meaning }), ...facts(rows)];
  body.push(ended ? text(plain(clip(ended, 200)), { weight: "Bolder" }) : note(hint));
  if (ended && summary) body.push(text(plain(SUMMARY_LABEL[m.lang] + summary)));
  const stop = execute(zh ? "停止" : "Stop", "primusclaw.work_stop", {
    primusclaw: "work",
    op: "stop",
    card: m.cardId,
  });
  return message(body, ended ? [] : buttons([stop], "destructive"));
}

export const ITEM_CARD_ENDED_PLAIN_ZH = "已结束，见上方结果";

export function endedItemCard(m: EndedItemView): CardMessage {
  const render = m.render;
  const lang = render.lang === "en" ? "en" : "zh";
  if (render.kind === "review" && m.ended !== ITEM_CARD_ENDED_PLAIN_ZH && typeof render.pull === "string") {
    const seq = Number(render.seq ?? 0);
    if (Number.isInteger(seq)) {
      return reviewItemCard(
        {
          seq,
          pull: render.pull,
          who: String(render.who ?? ""),
          reviewOnly: Boolean(render.review_only),
          model: String(render.model ?? ""),
          cardId: m.cardId,
          lang,
          queued: false,
        },
        m.ended,
        typeof render.pr_summary === "string" ? render.pr_summary : "",
      );
    }
  }
  let label = plain(clip(String(render.title || render.pull || ""), 120));
  const seq = render.seq;
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
