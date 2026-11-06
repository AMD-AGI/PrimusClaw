// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * What an approval notification says is being approved.
 *
 * The text lands in somebody's chat, so it is built to be read there and to leak
 * nothing: the command (for bash) or the tool's name with its salient inputs
 * (for anything else), with credentials masked FIRST and the length cut AFTER,
 * so a secret that straddles the cut is masked rather than half shown.
 *
 * `redactPublicJson` knows the vendor token shapes, a Bearer header and a URL's
 * userinfo, and masks values under credential-looking keys. A command line
 * carries other shapes that nothing else covers (`GH_TOKEN=abc`, `--token abc`,
 * `curl -u user:pass`), so those are masked here, for this text only.
 */
import { redactPublicJson } from "../events/redaction.js";

/** The longest `approval.target`, ellipsis included. */
export const APPROVAL_TARGET_MAX = 300;
/** More than anyone reads; the masking works on this much, then the text is cut. */
const SCAN_MAX = 20_000;
const MAX_FIELDS = 6;
const VALUE_MAX = 80;

// A credential's name, as a word that may sit inside a longer one (`--kube-token`, `MY_API_KEY`).
// `author` is not one, though it begins with the letters.
const SECRET_WORDS = "(?:token|password|passwd|passphrase|secret|credentials?|api[-_]?key|access[-_]?key|private[-_]?key|auth(?!or)|bearer|cookie)";
const NAME_WITH_SECRET = new RegExp(`\\b([A-Za-z0-9_]*${SECRET_WORDS}[A-Za-z0-9_]*)(\\s*=\\s*)("[^"]*"|'[^']*'|\\S+)`, "gi");
const SECRET_FLAG = new RegExp(`(\\s--?[A-Za-z0-9_-]*${SECRET_WORDS}[A-Za-z0-9_-]*(?:=|\\s+))("[^"]*"|'[^']*'|\\S+)`, "gi");
const BASIC_AUTH_FLAG = /(\s(?:-u|--user|--proxy-user)(?:=|\s+))("[^":]*:[^"]*"|'[^':]*:[^']*'|[^\s:]+:\S+)/g;
const PASSWORD_FIELD = /(["']?(?:password|passwd|secret|token|api_?key)["']?\s*:\s*)("[^"]*"|'[^']*')/gi;

/** Mask the credential shapes a command line carries. Idempotent. */
export function redactCommandSecrets(text: string): string {
  const shapes = String(redactPublicJson(text) ?? "");
  return shapes
    .replace(NAME_WITH_SECRET, "$1$2<redacted>")
    .replace(SECRET_FLAG, "$1<redacted>")
    .replace(BASIC_AUTH_FLAG, "$1<redacted>")
    .replace(PASSWORD_FIELD, "$1\"<redacted>\"");
}

const oneLine = (s: string): string => s.replace(/\s+/g, " ").trim();

function clip(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

function salientInput(input: unknown): string {
  if (!input || typeof input !== "object" || Array.isArray(input)) return "";
  // Keys that look like credentials are masked by value, and kept, so the reader
  // sees that one was passed.
  const safe = redactPublicJson(input) as Record<string, unknown>;
  const parts: string[] = [];
  for (const [key, value] of Object.entries(safe)) {
    if (parts.length >= MAX_FIELDS) break;
    if (value === null || value === undefined || value === "") continue;
    const text = typeof value === "object" ? JSON.stringify(value) : String(value);
    parts.push(`${key}=${clip(oneLine(text), VALUE_MAX)}`);
  }
  return parts.join(" ");
}

/**
 * The redacted, clipped (<= 300 characters) summary of what a held tool call
 * would do: the command for `bash`, otherwise the tool's name and its salient
 * inputs.
 */
export function approvalTarget(tool: unknown, input: unknown): string {
  const name = typeof tool === "string" ? tool : "";
  let raw: string;
  if (name.toLowerCase() === "bash") {
    const command = input && typeof input === "object" ? (input as Record<string, unknown>).command : undefined;
    raw = typeof command === "string" ? command : name;
  } else {
    const salient = salientInput(input);
    raw = salient ? `${name} ${salient}` : name;
  }
  return clip(oneLine(redactCommandSecrets(raw.slice(0, SCAN_MAX))), APPROVAL_TARGET_MAX);
}

/** The longest text a held write carries for the person to read before they decide (a comment's body): they approve exactly it. */
export const APPROVAL_DETAIL_MAX = 1500;

/**
 * What a held tool call would do, in plain words of the person's language (`zh`: Chinese, else English), for the message that asks
 * them: `action` says what is done and where, `detail` is the text it would write (a comment's or an issue's body), when there is one.
 * The tools of the API's GitHub server are named by what they do; any other tool by its name and its salient inputs, as
 * `approvalTarget` gives them. Masked as the target is, and cut.
 */
export function approvalAction(tool: unknown, input: unknown, zh: boolean): { action: string; detail: string } {
  const name = typeof tool === "string" ? tool : "";
  const a = input && typeof input === "object" && !Array.isArray(input) ? input as Record<string, unknown> : {};
  const str = (v: unknown, max = VALUE_MAX): string => clip(oneLine(redactCommandSecrets(typeof v === "string" ? v : typeof v === "number" ? String(v) : "")), max);
  const list = (v: unknown): string => (Array.isArray(v) ? v.filter((x) => typeof x === "string").map((x) => str(x)).join(", ") : "");
  const at = `${str(a.repo)}${a.number !== undefined ? `#${str(a.number)}` : ""}`;
  const body = typeof a.body === "string" ? clip(redactCommandSecrets(a.body.trim()), APPROVAL_DETAIL_MAX) : "";
  const github = /^mcp__github__(.+)$/.exec(name)?.[1];
  const words: Record<string, [string, string]> = {
    issue_comment: [`以你的 GitHub 账号在 ${at} 上发表一条评论`, `Post a comment on ${at} as your GitHub account`],
    issue_create: [`以你的 GitHub 账号在 ${str(a.repo)} 新建 issue「${str(a.title, 200)}」`, `Open an issue "${str(a.title, 200)}" in ${str(a.repo)} as your GitHub account`],
    pr_create: [`以你的 GitHub 账号在 ${str(a.repo)} 开一个 PR「${str(a.title, 200)}」（${str(a.head)} → ${str(a.base)}）`, `Open a pull request "${str(a.title, 200)}" in ${str(a.repo)} (${str(a.head)} → ${str(a.base)}) as your GitHub account`],
    pr_update: [`修改 ${at}${a.state === "closed" ? "（关闭它）" : a.state === "open" ? "（重新打开）" : ""}`, `Change ${at}${a.state === "closed" ? " (close it)" : a.state === "open" ? " (reopen it)" : ""}`],
    review_thread_reply: ["以你的 GitHub 账号在一个评审线程里回复", "Reply in a review thread as your GitHub account"],
    review_thread_resolve: ["把一个评审线程标为已解决", "Mark a review thread resolved"],
    checks_rerun_failed: [`重跑 ${str(a.repo)} 的 CI 运行 ${str(a.run_id)} 里失败的任务`, `Rerun the failed jobs of run ${str(a.run_id)} in ${str(a.repo)}`],
    pr_request_reviewers: [`请 ${list(a.reviewers) || list(a.team_reviewers)} 评审 ${at}`, `Ask ${list(a.reviewers) || list(a.team_reviewers)} to review ${at}`],
    labels_set: [`把 ${at} 的标签设为：${list(a.labels) || "（无）"}`, `Set the labels of ${at} to: ${list(a.labels) || "(none)"}`],
  };
  const known = github ? words[github] : undefined;
  if (known) return { action: zh ? known[0] : known[1], detail: body };
  if (name.toLowerCase() === "bash") {
    const command = str(a.command, APPROVAL_TARGET_MAX);
    return { action: zh ? `运行命令：${command}` : `Run the command: ${command}`, detail: "" };
  }
  const target = approvalTarget(name, input);
  return { action: zh ? `执行 ${target}` : `Run ${target}`, detail: body };
}
