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
 *
 * The person approves what the words say, so the words say every field the call sets: each GitHub tool lists the inputs its
 * words cover, and any other input that carries a value is appended as `key=value`, the way the target shows it. A field
 * added to a tool later is therefore shown, not dropped, until the words learn to say it.
 */
export function approvalAction(tool: unknown, input: unknown, zh: boolean): { action: string; detail: string } {
  const name = typeof tool === "string" ? tool : "";
  const a = input && typeof input === "object" && !Array.isArray(input) ? input as Record<string, unknown> : {};
  const str = (v: unknown, max = VALUE_MAX): string => clip(oneLine(redactCommandSecrets(typeof v === "string" ? v : typeof v === "number" ? String(v) : "")), max);
  const list = (v: unknown): string => (Array.isArray(v) ? v.filter((x) => typeof x === "string").map((x) => str(x)).join(", ") : "");
  const at = `${str(a.repo)}${a.number !== undefined ? `#${str(a.number)}` : ""}`;
  const body = typeof a.body === "string" ? clip(redactCommandSecrets(a.body.trim()), APPROVAL_DETAIL_MAX) : "";
  const github = /^mcp__github__(.+)$/.exec(name)?.[1];
  const known = github ? githubWords(github, a, { str, list, at }) : undefined;
  if (known) {
    // `body` is the detail, said whole after the action, wherever it is set.
    const covered = new Set([...known.covers, "body"]);
    const rest: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(a)) {
      if (!covered.has(key) && value !== null && value !== undefined && value !== "") rest[key] = value;
    }
    const more = salientInput(rest);
    const action = zh ? known.zh : known.en;
    return { action: more ? (zh ? `${action}（另设 ${more}）` : `${action} (also setting ${more})`) : action, detail: body };
  }
  if (name.toLowerCase() === "bash") {
    const command = str(a.command, APPROVAL_TARGET_MAX);
    return { action: zh ? `运行命令：${command}` : `Run the command: ${command}`, detail: "" };
  }
  const target = approvalTarget(name, input);
  return { action: zh ? `执行 ${target}` : `Run ${target}`, detail: body };
}

/** The words for a tool of the API's GitHub server, and the inputs they say; undefined for a tool they do not know. */
function githubWords(
  tool: string,
  a: Record<string, unknown>,
  { str, list, at }: { str: (v: unknown, max?: number) => string; list: (v: unknown) => string; at: string },
): { zh: string; en: string; covers: string[] } | undefined {
  const set = (v: unknown): boolean => v !== null && v !== undefined && v !== "";
  switch (tool) {
    case "issue_comment":
      return { zh: `以你的 GitHub 账号在 ${at} 上发表一条评论`, en: `Post a comment on ${at} as your GitHub account`, covers: ["repo", "number"] };
    case "issue_create": {
      const labels = list(a.labels);
      return {
        zh: `以你的 GitHub 账号在 ${str(a.repo)} 新建 issue「${str(a.title, 200)}」${labels ? `，标签：${labels}` : ""}`,
        en: `Open an issue "${str(a.title, 200)}" in ${str(a.repo)}${labels ? ` labelled ${labels}` : ""} as your GitHub account`,
        covers: ["repo", "title", ...(Array.isArray(a.labels) ? ["labels"] : [])],
      };
    }
    case "pr_create": {
      const draft = a.draft === true;
      return {
        zh: `以你的 GitHub 账号在 ${str(a.repo)} 开一个${draft ? "草稿 " : " "}PR「${str(a.title, 200)}」（${str(a.head)} → ${str(a.base)}）`,
        en: `Open a ${draft ? "draft " : ""}pull request "${str(a.title, 200)}" in ${str(a.repo)} (${str(a.head)} → ${str(a.base)}) as your GitHub account`,
        // `draft: false` is what a pull request is anyway.
        covers: ["repo", "title", "head", "base", ...(typeof a.draft === "boolean" ? ["draft"] : [])],
      };
    }
    case "pr_update": {
      const zh: string[] = [];
      const en: string[] = [];
      const covers = ["repo", "number"];
      if (set(a.title)) { zh.push(`标题改为「${str(a.title, 200)}」`); en.push(`title to "${str(a.title, 200)}"`); covers.push("title"); }
      if (set(a.base)) { zh.push(`base 改为 ${str(a.base)}`); en.push(`base to ${str(a.base)}`); covers.push("base"); }
      if (typeof a.body === "string") { zh.push("正文改为下文"); en.push("description to the text below"); }
      if (a.state === "closed") { zh.push("关闭它"); en.push("close it"); covers.push("state"); }
      if (a.state === "open") { zh.push("重新打开"); en.push("reopen it"); covers.push("state"); }
      return { zh: `修改 ${at}${zh.length ? `：${zh.join("，")}` : ""}`, en: `Change ${at}${en.length ? `: ${en.join(", ")}` : ""}`, covers };
    }
    case "review_thread_reply":
      return { zh: "以你的 GitHub 账号在一个评审线程里回复", en: "Reply in a review thread as your GitHub account", covers: ["thread_id"] };
    case "review_thread_resolve":
      return { zh: "把一个评审线程标为已解决", en: "Mark a review thread resolved", covers: ["thread_id"] };
    case "checks_rerun_failed":
      return { zh: `重跑 ${str(a.repo)} 的 CI 运行 ${str(a.run_id)} 里失败的任务`, en: `Rerun the failed jobs of run ${str(a.run_id)} in ${str(a.repo)}`, covers: ["repo", "run_id"] };
    case "pr_request_reviewers": {
      const who = [list(a.reviewers), list(a.team_reviewers)].filter(Boolean).join(", ");
      return {
        zh: `请 ${who} 评审 ${at}`,
        en: `Ask ${who} to review ${at}`,
        covers: ["repo", "number", ...(Array.isArray(a.reviewers) ? ["reviewers"] : []), ...(Array.isArray(a.team_reviewers) ? ["team_reviewers"] : [])],
      };
    }
    case "labels_set":
      return { zh: `把 ${at} 的标签设为：${list(a.labels) || "（无）"}`, en: `Set the labels of ${at} to: ${list(a.labels) || "(none)"}`, covers: ["repo", "number", "labels"] };
    default:
      return undefined;
  }
}
