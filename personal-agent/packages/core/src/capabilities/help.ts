// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Help, rendered from the capability registry: the capabilities a chat shows, by category, one short line each with the example to
 * type; the current value of a setting where it is known; what the bot can do and as whom; and what to know about answers and data.
 * No list of commands.
 */
import { BOT_NAME } from "../branding.js";
import { own } from "../own.js";
import { toLang, type Lang } from "../locales/lang.js";
import { dataStatement, type GroupContextKept } from "../locales/transparency.js";
import { CAPABILITIES, CATEGORIES, type Capability, type Part } from "./registry.js";
import { shown, type ChatShape } from "./visibility.js";

export const CURRENT_WORDS: Readonly<Record<Lang, string>> = { zh: "当前：", en: "now: " };

/** A confirmation setting as help says it: [Chinese, English]. */
export const CONFIRM_MODE_WORDS: Readonly<Record<string, readonly [string, string]>> = {
  high_risk_confirm: ["高风险时再问你", "ask you on high risk"],
  fully_auto: ["全自动合入", "fully automatic"],
};

function authorityZh(parts: ReadonlySet<Part>): string[] {
  const lines = [
    "**我能做什么、以谁的身份做**",
    "- 对话和任务：用你连接的 Primus 账号、以你自己的权限做，权限不会比你本人多。",
    "- 沙箱之外的写操作（推送代码、开 PR 等）先发审批卡片，只有发起的人能批准或拒绝。",
  ];
  if (parts.has("github")) {
    lines.push(
      "- 代审合入：用被点名同事自己的 GitHub 账号，要 TA 事先在和我的 1:1 里授权，只接受指定组织的 PR。",
      "- 高风险的合入、代发的 review 要 TA 本人在卡片上确认；卡片写明仓库、PR、目标分支和执行的 GitHub 账号。",
    );
  }
  if (parts.has("remote")) lines.push("- 远程 agent：在你自己的机器上、以你的账号运行；它要权限时发卡片给你。");
  lines.push(
    "- 批准、确认合入、发起代审、切换到免审批模式，每人有次数上限；拒绝不受限制。",
    "- 每次批准和合入都记审计日志，不含消息正文。",
  );
  return lines;
}

function authorityEn(parts: ReadonlySet<Part>): string[] {
  const lines = [
    "**What I can do, and as whom**",
    "- Chat and tasks: with the Primus account you connected, with your own permissions and never more.",
    "- A write outside the sandbox (a push, a pull request, ...) waits for a card only the person who asked can approve or deny.",
  ];
  if (parts.has("github")) {
    lines.push(
      "- Reviews for a colleague: with the named colleague's own GitHub account, after they allowed it, for the allowed organizations only.",
      "- A high-risk merge, or a review posted for someone else, waits for them to confirm on a card that names the repository,",
      "  the pull request, the target branch and the GitHub account it acts as.",
    );
  }
  if (parts.has("remote")) {
    lines.push("- Remote agents: run on your own machines as you; they ask for permission with a card.");
  }
  lines.push(
    "- Approving, confirming a merge, starting a review for a colleague and switching to a mode that does not ask are limited per person;",
    "  denying never is. Every approval and merge is recorded in an audit log, without message text.",
  );
  return lines;
}

/**
 * The paragraph of help that says what the bot can do and as whom (security review): every action is someone's own, what waits
 * for a person's tap, and that the taps that add authority are limited per person. The review and remote-agent sentences only when
 * those parts are on.
 */
export function authorityText(zh: boolean, parts: ReadonlySet<Part> = new Set()): string {
  return (zh ? authorityZh(parts) : authorityEn(parts)).join("\n");
}

export interface HelpOptions {
  readonly group?: boolean;
  readonly assistant?: boolean;
  readonly parts?: ReadonlySet<Part>;
  /** This person's settings as help shows them ("当前：..."), by a capability's `setting`. */
  readonly values?: Readonly<Record<string, string>>;
  /** Goes first: which account, where the chat is attached. */
  readonly lead?: string;
  readonly bot?: string;
  readonly understanding?: boolean;
  /** The deployment keeps a group's recent messages as background (what the data statement then says it sees). */
  readonly groupContext?: GroupContextKept;
  /** The chat app's full name (`SurfaceCaps.name`): where the data statement says messages go through. */
  readonly channel?: string;
}

function capabilityLine(c: Capability, lang: Lang, current: string | undefined): string {
  const zh = lang === "zh";
  let line = `- ${zh ? c.zh : c.en}`;
  if (current) line += zh ? `（${CURRENT_WORDS.zh}${current}）` : ` (${CURRENT_WORDS.en}${current})`;
  const say = zh ? c.sayZh : c.sayEn;
  if (say) line += zh ? `：「${say}」` : `: "${say}"`;
  return line;
}

function categoryBlocks(lang: Lang, chat: ChatShape, values: Readonly<Record<string, string>>): string[] {
  const blocks: string[] = [];
  for (const category of CATEGORIES) {
    const items = CAPABILITIES.filter((c) => c.category === category.key && shown(c, chat));
    if (items.length === 0) continue;
    const lines = [`**${lang === "zh" ? category.zh : category.en}**`];
    for (const c of items) {
      const current = c.setting && !chat.group ? own(values, c.setting) : undefined;
      lines.push(capabilityLine(c, lang, current));
    }
    blocks.push(lines.join("\n"));
  }
  return blocks;
}

/**
 * In a group: what a 1:1 chat with the bot does that the group cannot, in a few words each (a capability's `dmZh`/`dmEn`), as the 1:1
 * chat of the person who asked shows it (`assistant`, `parts`), and how to open one. Words only: nothing of anyone's settings, and
 * nothing to tap, since what it names is done in the 1:1 chat. A machine of one's own leads: a group cannot show it at all.
 */
function oneToOneBlock(lang: Lang, chat: ChatShape, bot: string): string | undefined {
  const zh = lang === "zh";
  const oneToOne: ChatShape = { ...chat, group: false, understanding: false };
  const names: string[] = [];
  const items = CAPABILITIES.filter((c) => c.where === "dm" && (zh ? c.dmZh : c.dmEn) !== "" && shown(c, oneToOne));
  for (const c of [...items.filter((c) => c.category === "remote"), ...items.filter((c) => c.category !== "remote")]) {
    const name = zh ? c.dmZh : c.dmEn;
    if (!names.includes(name)) names.push(name);
  }
  if (names.length === 0) return undefined;
  const lines = [zh ? "**私聊我还可以**" : "**More in a 1:1 chat with me**"];
  for (const name of names) lines.push(`- ${name}`);
  lines.push(
    zh
      ? `这些在和我的 1:1 聊天里用：点 ${bot} 的名字，发起私聊就行。`
      : `These are in a 1:1 chat with me: select ${bot}'s name and start a chat.`,
  );
  return lines.join("\n");
}

function chatOf(options: HelpOptions): ChatShape {
  return {
    group: options.group ?? false,
    assistant: options.assistant ?? false,
    parts: options.parts ?? new Set<Part>(),
    understanding: options.understanding ?? false,
  };
}

function groupLead(zh: boolean, bot: string): string {
  return zh
    ? `在群里先 @${bot}，再说要做什么。我以你自己的身份做事，第一次用请先在和我的 1:1 聊天里连上账号。`
    : `In a group, @mention ${bot} first. I act as you, with your own account: connect it once in a 1:1 chat with me.`;
}

/** The help for a chat, in `language` ("zh", or anything else for English). */
export function renderHelp(language: string, options: HelpOptions = {}): string {
  const lang = toLang(language);
  const zh = lang === "zh";
  const chat = chatOf(options);
  const bot = options.bot ?? BOT_NAME;
  const out = [zh ? `**${bot} 能帮你做什么**` : `**What ${bot} can do for you**`];
  if (options.lead) out.push(options.lead);
  if (chat.group) out.push(groupLead(zh, bot));
  out.push(...categoryBlocks(lang, chat, options.values ?? {}));
  const oneToOne = chat.group ? oneToOneBlock(lang, chat, bot) : undefined;
  if (oneToOne !== undefined) out.push(oneToOne);
  out.push(authorityText(zh, chat.parts));
  if (chat.group)
    out.push(
      zh
        ? `设置只能在和我的 1:1 聊天里改。\n只有这个群的回复语言在群里设：@${bot} 说「这个群用英文」（或中文、跟随提问者）。`
        : "Settings are changed in a 1:1 chat with me.\n" +
            `This group's language is set here: @${bot} "use English in this group" (or Chinese, or "follow the asker").`,
    );
  // (every help: 1:1, group and the assistant's)
  out.push(dataStatement(lang, !chat.group && chat.parts.has("remote"), options.groupContext, options.channel));
  out.push(
    zh
      ? "随时问我「你能做什么」看这份说明。底部菜单里也有常用的按钮。"
      : 'Ask "what can you do" any time to see this again. The menu by the compose box has the common ones too.',
  );
  return out.join("\n\n");
}
