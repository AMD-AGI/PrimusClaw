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

function salientInput(input: unknown, maxFields = MAX_FIELDS): string {
  if (!input || typeof input !== "object" || Array.isArray(input)) return "";
  // Keys that look like credentials are masked by value, and kept, so the reader
  // sees that one was passed.
  const safe = redactPublicJson(input) as Record<string, unknown>;
  const parts: string[] = [];
  for (const [key, value] of Object.entries(safe)) {
    if (parts.length >= maxFields) break;
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
 * The tools of the API's GitHub server, and the writes of Dispatron, Agent Board, Autopilot and SaFE, are named by what they do; any
 * other MCP tool by the service it belongs to and its own name in words; never by its `mcp__<server>__<tool>` name, which is text a
 * person is never shown (2026-11-07 G0 run: "需要你批准：执行 mcp__dispatron__put_plans_plan_id_automation plan_id=…" in four
 * cases). A tool that is not an MCP tool is named as `approvalTarget` gives it. Masked as the target is, and cut.
 *
 * The person approves what the words say, so the words say every field the call sets: each known tool lists the inputs its words
 * cover, and any other input that carries a value is appended as `key=value`, the way the target shows it. A field added to a tool
 * later is therefore shown, not dropped, until the words learn to say it. The only inputs a known tool's words leave unsaid are its
 * preconditions (`expected_*`, `confirm_*`): they change nothing, they make the call refuse when the thing changed since it was read.
 */
export function approvalAction(tool: unknown, input: unknown, zh: boolean): { action: string; detail: string } {
  const name = typeof tool === "string" ? tool : "";
  const a = input && typeof input === "object" && !Array.isArray(input) ? input as Record<string, unknown> : {};
  const str = (v: unknown, max = VALUE_MAX): string => clip(oneLine(redactCommandSecrets(typeof v === "string" ? v : typeof v === "number" ? String(v) : "")), max);
  const list = (v: unknown): string => (Array.isArray(v) ? v.filter((x) => typeof x === "string" || typeof x === "number").map((x) => str(x)).join(", ") : "");
  const at = `${str(a.repo)}${a.number !== undefined ? `#${str(a.number)}` : ""}`;
  const body = typeof a.body === "string" ? clip(redactCommandSecrets(a.body.trim()), APPROVAL_DETAIL_MAX) : "";
  const mcp = /^mcp__(.+?)__(.+)$/.exec(name);
  const known = !mcp ? undefined : mcp[1] === "github" ? githubWords(mcp[2], a, { str, list, at }) : serviceWords(mcp[1], mcp[2], a, { str, list });
  if (known) {
    // `body` is the detail, said whole after the action, wherever it is set as text.
    const covered = new Set([...known.covers, ...(typeof a.body === "string" ? ["body"] : [])]);
    const rest: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(a)) {
      if (!covered.has(key) && value !== null && value !== undefined && value !== "") rest[key] = value;
    }
    // Masked as the target is: a value can carry a command line's credential shapes (`GH_TOKEN=…`), which only the target's masking knows.
    // Every one of them, not the target's first six: what is approved is what is shown.
    const more = redactCommandSecrets(salientInput(rest, Infinity));
    const action = zh ? known.zh : known.en;
    if (!more) return { action, detail: body };
    if (mcp?.[1] === "github") return { action: zh ? `${action}（另设 ${more}）` : `${action} (also setting ${more})`, detail: body };
    return { action: zh ? `${action}，参数：${more}` : `${action}, with ${more}`, detail: body };
  }
  if (name.toLowerCase() === "bash") {
    const command = str(a.command, APPROVAL_TARGET_MAX);
    return { action: zh ? `运行命令：${command}` : `Run the command: ${command}`, detail: "" };
  }
  const target = approvalTarget(name, input);
  return { action: zh ? `执行 ${target}` : `Run ${target}`, detail: body };
}

type Words = { zh: string; en: string; covers: string[] };
type Say = { str: (v: unknown, max?: number) => string; list: (v: unknown) => string };

/** The services whose tools a person may be asked to approve, by the name their MCP server has in Claw's configs. */
const SERVICE_NAMES: Record<string, string> = {
  dispatron: "Dispatron", "agent-board": "Agent Board", autopilot: "Autopilot", safe: "SaFE", pulse: "Pulse", triggers: "Claw",
};

/** A service's name for a person: the known ones as they are written, any other one in words (`my-tool` -> "My Tool"). */
export function serviceName(server: string): string {
  return SERVICE_NAMES[server] ?? server.split(/[-_]+/).filter(Boolean).map((w) => w[0]!.toUpperCase() + w.slice(1)).join(" ");
}

// The verb a tool's name begins with, in words; an HTTP method first (Dispatron's tools are named after their route).
const VERBS: Record<string, [string, string]> = {
  put: ["更新", "Update"], post: ["提交", "Submit"], patch: ["修改", "Change"], delete: ["删除", "Delete"], apply: ["应用", "Apply"],
  create: ["新建", "Create"], update: ["更新", "Update"], set: ["设置", "Set"], add: ["添加", "Add"], remove: ["移除", "Remove"],
  stop: ["停止", "Stop"], start: ["启动", "Start"], cancel: ["取消", "Cancel"], write: ["写入", "Write"],
};

/** Inputs that only make a call refuse when what it acts on changed since it was read: they set nothing. */
const PRECONDITION = /^(expected_|confirm_)/;

/**
 * The words for a write of Dispatron, Agent Board, Autopilot or SaFE, and the inputs they say; for any other tool of an MCP server,
 * the service and the tool's own name in words, saying no input. Never undefined: an MCP tool is never named by its `mcp__` name.
 */
function serviceWords(server: string, tool: string, a: Record<string, unknown>, say: Say): Words {
  const service = serviceName(server);
  const known = server === "dispatron" ? dispatronWords(tool, a, say)
    : server === "agent-board" ? boardWords(tool, a, say)
    : server === "autopilot" ? autopilotWords(tool, a, say)
    : server === "safe" ? safeWords(tool, a, say)
    : undefined;
  if (known) {
    // A reason is said after what is done, wherever a known tool takes one; the preconditions are left unsaid (see `approvalAction`).
    const why = typeof a.reason === "string" && a.reason.trim() ? say.str(a.reason, 200) : "";
    const preconditions = Object.keys(a).filter((k) => PRECONDITION.test(k));
    return {
      zh: why ? `${known.zh}，理由：「${why}」` : known.zh,
      en: why ? `${known.en}, because "${why}"` : known.en,
      covers: [...known.covers, ...preconditions, ...(why ? ["reason"] : [])],
    };
  }
  const [first, ...others] = tool.split("_").filter(Boolean);
  const verb = first ? VERBS[first.toLowerCase()] : undefined;
  const object = (verb ? others : [first, ...others]).join(" ");
  if (verb && object) return { zh: `在 ${service} 上${verb[0]}「${object}」`, en: `${verb[1]} "${object}" on ${service}`, covers: [] };
  return { zh: `在 ${service} 上执行「${object || tool}」`, en: `Run "${object || tool}" on ${service}`, covers: [] };
}

const set = (v: unknown): boolean => v !== null && v !== undefined && v !== "";
/** The keys of `a` among `keys` that carry a value: what a phrase that says them covers. */
const said = (a: Record<string, unknown>, ...keys: string[]): string[] => keys.filter((k) => set(a[k]));
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function dispatronWords(tool: string, a: Record<string, unknown>, { str, list }: Say): Words | undefined {
  const run = str(a.task_id);
  const plan = str(a.plan_id);
  const config = str(a.config_id);
  const problem = str(a.problem_id);
  const scalar = (v: unknown): boolean => typeof v === "string" || typeof v === "number";
  switch (tool) {
    case "post_runs_task_id_owner":
      return set(a.github)
        ? { zh: `在 Dispatron 上把运行 ${run} 的负责人设为 ${str(a.github)}`, en: `Make ${str(a.github)} the owner of run ${run} on Dispatron`, covers: ["task_id", "github"] }
        : { zh: `在 Dispatron 上认领运行 ${run}`, en: `Take ownership of run ${run} on Dispatron`, covers: ["task_id"] };
    case "post_runs_task_id_not_defect":
      return { zh: `在 Dispatron 上把运行 ${run} 标为「不是缺陷」`, en: `Mark run ${run} as not a defect on Dispatron`, covers: ["task_id"] };
    case "delete_runs_task_id_not_defect":
      return { zh: `在 Dispatron 上撤销运行 ${run} 的「不是缺陷」标记`, en: `Withdraw the not-a-defect mark on run ${run} on Dispatron`, covers: ["task_id"] };
    case "post_runs_task_id_cancel":
      return { zh: `在 Dispatron 上取消运行 ${run}`, en: `Cancel run ${run} on Dispatron`, covers: ["task_id"] };
    case "post_runs_task_id_issue":
      return { zh: `在 Dispatron 上为运行 ${run} 新建 issue「${str(a.title, 200)}」`, en: `Open an issue "${str(a.title, 200)}" for run ${run} on Dispatron`, covers: ["task_id", "title"] };
    case "post_runs_task_id_issue_link":
      return { zh: `在 Dispatron 上把运行 ${run} 关联到 issue ${str(a.url, 200)}`, en: `Link run ${run} to the issue ${str(a.url, 200)} on Dispatron`, covers: ["task_id", "url"] };
    case "post_runs_task_id_issue_unlink":
      return { zh: `在 Dispatron 上解除运行 ${run} 与 issue 的关联`, en: `Unlink run ${run} from its issue on Dispatron`, covers: ["task_id"] };
    case "post_problems_problem_id_resolve": {
      const kind = scalar(a.kind) ? str(a.kind) : "";
      const link = set(a.link) ? str(a.link, 200) : "";
      return {
        zh: `在 Dispatron 上把问题 ${problem} 标为已解决${kind ? `（类型 ${kind}）` : ""}${link ? `，链接 ${link}` : ""}`,
        en: `Mark problem ${problem} resolved on Dispatron${kind ? ` (kind ${kind})` : ""}${link ? `, linking ${link}` : ""}`,
        covers: ["problem_id", ...(kind ? ["kind"] : []), ...said(a, "link")],
      };
    }
    case "post_problems_problem_id_reopen":
      return { zh: `在 Dispatron 上重新打开问题 ${problem}`, en: `Reopen problem ${problem} on Dispatron`, covers: ["problem_id"] };
    case "post_problems_problem_id_diagnosis_mark": {
      const verdict = a.verdict === "right" ? ["正确", "right"] : a.verdict === "wrong" ? ["错误", "wrong"] : null;
      if (!verdict) return undefined;
      const note = set(a.note) ? str(a.note, 200) : "";
      return {
        zh: `在 Dispatron 上把问题 ${problem} 的诊断标为${verdict[0]}${note ? `，备注：「${note}」` : ""}`,
        en: `Mark the diagnosis of problem ${problem} ${verdict[1]} on Dispatron${note ? `, noting "${note}"` : ""}`,
        covers: ["problem_id", "verdict", ...said(a, "note")],
      };
    }
    case "post_change_log_change_id_revert": {
      const dry = a.dry_run === true;
      return {
        zh: `在 Dispatron 上${dry ? "试运行：" : ""}撤回变更 ${str(a.change_id)}`,
        en: `${dry ? "Try out (dry run): revert" : "Revert"} change ${str(a.change_id)} on Dispatron`,
        covers: ["change_id", ...(typeof a.dry_run === "boolean" ? ["dry_run"] : [])],
      };
    }
    case "put_configs":
      return { zh: "在 Dispatron 上新建或替换配置", en: "Create or replace configs on Dispatron", covers: [] };
    case "patch_configs_params":
      return { zh: "在 Dispatron 上批量修改配置参数", en: "Change the parameters of several configs on Dispatron", covers: [] };
    case "patch_configs_config_id_params":
      return { zh: `在 Dispatron 上修改配置 ${config} 的参数`, en: `Change the parameters of config ${config} on Dispatron`, covers: ["config_id"] };
    case "post_configs_config_id_copy":
      return { zh: `在 Dispatron 上把配置 ${config} 复制为「${str(a.name, 200)}」`, en: `Copy config ${config} as "${str(a.name, 200)}" on Dispatron`, covers: ["config_id", "name"] };
    case "post_plans":
      return { zh: `在 Dispatron 上新建计划「${str(a.name, 200)}」`, en: `Create the plan "${str(a.name, 200)}" on Dispatron`, covers: ["name"] };
    case "put_plans_plan_id_overrides":
      return { zh: `在 Dispatron 上修改计划 ${plan} 的覆盖参数`, en: `Change the overrides of plan ${plan} on Dispatron`, covers: ["plan_id"] };
    case "put_plans_plan_id_schedule": {
      const mode = scalar(a.mode) ? str(a.mode) : "";
      return {
        zh: `在 Dispatron 上修改计划 ${plan} 的排期${mode ? `，模式设为 ${mode}` : ""}`,
        en: `Change the schedule of plan ${plan} on Dispatron${mode ? `, mode ${mode}` : ""}`,
        covers: ["plan_id", ...(mode ? ["mode"] : [])],
      };
    }
    case "post_plans_plan_id_recycle": {
      const batch = scalar(a.batch_id) ? str(a.batch_id) : "";
      return {
        zh: `在 Dispatron 上回收计划 ${plan}${batch ? ` 的批次 ${batch}` : ""}`,
        en: `Recycle ${batch ? `batch ${batch} of ` : ""}plan ${plan} on Dispatron`,
        covers: ["plan_id", ...(batch ? ["batch_id"] : [])],
      };
    }
    case "put_plans_plan_id_status": {
      const status = scalar(a.status) ? str(a.status) : "";
      if (!status) return undefined;
      return { zh: `在 Dispatron 上把计划 ${plan} 的状态设为 ${status}`, en: `Set the status of plan ${plan} to ${status} on Dispatron`, covers: ["plan_id", "status"] };
    }
    case "put_plans_plan_id_automation":
      return { zh: `在 Dispatron 上修改计划 ${plan} 的自动化设置`, en: `Change the automation settings of plan ${plan} on Dispatron`, covers: ["plan_id"] };
    case "post_plans_plan_id_items": {
      const configs = list(a.config_ids);
      return {
        zh: `在 Dispatron 上往计划 ${plan} 加入配置 ${configs}`,
        en: `Add configs ${configs} to plan ${plan} on Dispatron`,
        covers: ["plan_id", ...(configs ? ["config_ids"] : [])],
      };
    }
    case "delete_plans_plan_id_items_config_id":
      return { zh: `在 Dispatron 上把配置 ${config} 移出计划 ${plan}`, en: `Remove config ${config} from plan ${plan} on Dispatron`, covers: ["plan_id", "config_id"] };
    case "patch_plans_plan_id_items_config_id":
      return { zh: `在 Dispatron 上修改计划 ${plan} 里配置 ${config} 的设置`, en: `Change the settings of config ${config} in plan ${plan} on Dispatron`, covers: ["plan_id", "config_id"] };
    case "post_plans_plan_id_items_config_id_requeue":
      return { zh: `在 Dispatron 上把计划 ${plan} 里的配置 ${config} 重新排队`, en: `Requeue config ${config} in plan ${plan} on Dispatron`, covers: ["plan_id", "config_id"] };
    case "patch_plans_plan_id_labels":
      return { zh: `在 Dispatron 上修改计划 ${plan} 的标签`, en: `Change the labels of plan ${plan} on Dispatron`, covers: ["plan_id"] };
    default:
      return undefined;
  }
}

function boardWords(tool: string, a: Record<string, unknown>, { str, list }: Say): Words | undefined {
  const repo = `${str(a.owner)}/${str(a.repo)}`;
  const at = `${repo}${a.issue_number !== undefined ? `#${str(a.issue_number)}` : ""}`;
  const where = ["method", "owner", "repo"];
  switch (tool) {
    case "issue_write":
      switch (a.method) {
        case "create":
          return {
            zh: `以你的 Agent Board 账号在 ${repo} 新建话题「${str(a.title, 200)}」`,
            en: `Open the topic "${str(a.title, 200)}" in ${repo} as your Agent Board account`,
            covers: [...where, "title"],
          };
        case "update": {
          const zh: string[] = [];
          const en: string[] = [];
          const covers = [...where, "issue_number"];
          if (set(a.title)) { zh.push(`标题改为「${str(a.title, 200)}」`); en.push(`title to "${str(a.title, 200)}"`); covers.push("title"); }
          if (typeof a.body === "string") {
            if (a.body.trim()) { zh.push("正文改为下文"); en.push("description to the text below"); } else { zh.push("清空正文"); en.push("clear the description"); }
          }
          if (a.state === "closed") { zh.push("关闭它"); en.push("close it"); covers.push("state"); }
          if (a.state === "open") { zh.push("重新打开"); en.push("reopen it"); covers.push("state"); }
          return { zh: `修改 Agent Board 上的 ${at}${zh.length ? `：${zh.join("，")}` : ""}`, en: `Change ${at} on Agent Board${en.length ? `: ${en.join(", ")}` : ""}`, covers };
        }
        case "add_comment":
          return { zh: `以你的 Agent Board 账号在 ${at} 下发表一条回复`, en: `Post a reply on ${at} as your Agent Board account`, covers: [...where, "issue_number"] };
        case "edit_comment":
          return { zh: `修改你在 Agent Board 上 ${at} 的回复 ${str(a.commentID)}`, en: `Edit your reply ${str(a.commentID)} on ${at} on Agent Board`, covers: [...where, "issue_number", "commentID"] };
        case "add_labels":
          return { zh: `给 Agent Board 上的 ${at} 加标签 ${list(a.labels)}`, en: `Add the labels ${list(a.labels)} to ${at} on Agent Board`, covers: [...where, "issue_number", "labels"] };
        case "replace_labels":
          return { zh: `把 Agent Board 上 ${at} 的标签换成 ${list(a.labels) || "（无）"}`, en: `Set the labels of ${at} on Agent Board to ${list(a.labels) || "(none)"}`, covers: [...where, "issue_number", "labels"] };
        case "remove_label":
          return { zh: `从 Agent Board 上的 ${at} 去掉标签 ${str(a.label_id)}`, en: `Remove the label ${str(a.label_id)} from ${at} on Agent Board`, covers: [...where, "issue_number", "label_id"] };
        case "clear_labels":
          return { zh: `清空 Agent Board 上 ${at} 的标签`, en: `Clear the labels of ${at} on Agent Board`, covers: [...where, "issue_number"] };
        case "add_dependency":
        case "remove_dependency": {
          const add = a.method === "add_dependency";
          const other = `${str(a.related_owner) || str(a.owner)}/${str(a.related_repo) || str(a.repo)}#${str(a.related_issue_number)}`;
          const how = a.dependency_type === "blocking" ? ["阻塞", "blocking"] : a.dependency_type === "blocked_by" ? ["被阻塞于", "blocked by"] : null;
          if (!how) return undefined;
          return {
            zh: `在 Agent Board 上${add ? "记下" : "去掉"} ${at} ${how[0]} ${other}`,
            en: `${add ? "Record" : "Remove"} on Agent Board that ${at} is ${how[1]} ${other}`,
            covers: [...where, "issue_number", "dependency_type", ...said(a, "related_owner", "related_repo", "related_issue_number")],
          };
        }
        default:
          return undefined;
      }
    case "label_write": {
      const org = typeof a.method === "string" && a.method.endsWith("_org_label");
      // "在 Agent Board 的组织 boards" but "在 Agent Board 的 boards/cortex".
      const scope = org ? `组织 ${str(a.org)}` : ` ${repo}`;
      const scopeEn = org ? `the organization ${str(a.org)}` : repo;
      const scopeKeys = org ? ["org"] : ["owner", "repo"];
      const verb = typeof a.method === "string" ? a.method.split("_")[0] : "";
      if (verb === "create") {
        return { zh: `在 Agent Board 的${scope} 新建标签「${str(a.name)}」`, en: `Create the label "${str(a.name)}" in ${scopeEn} on Agent Board`, covers: ["method", ...scopeKeys, "name"] };
      }
      if (verb === "edit") return { zh: `修改 Agent Board 上${scope} 的标签 ${str(a.id)}`, en: `Edit the label ${str(a.id)} of ${scopeEn} on Agent Board`, covers: ["method", ...scopeKeys, "id"] };
      if (verb === "delete") return { zh: `删除 Agent Board 上${scope} 的标签 ${str(a.id)}`, en: `Delete the label ${str(a.id)} of ${scopeEn} on Agent Board`, covers: ["method", ...scopeKeys, "id"] };
      return undefined;
    }
    case "milestone_write":
      if (a.method === "create") return { zh: `在 Agent Board 的 ${repo} 新建里程碑「${str(a.title, 200)}」`, en: `Create the milestone "${str(a.title, 200)}" in ${repo} on Agent Board`, covers: [...where, "title"] };
      if (a.method === "update" || a.method === "edit") return { zh: `修改 Agent Board 上 ${repo} 的里程碑 ${str(a.id)}`, en: `Change the milestone ${str(a.id)} of ${repo} on Agent Board`, covers: [...where, "id"] };
      if (a.method === "delete") return { zh: `删除 Agent Board 上 ${repo} 的里程碑 ${str(a.id)}`, en: `Delete the milestone ${str(a.id)} of ${repo} on Agent Board`, covers: [...where, "id"] };
      return undefined;
    case "notification_write":
      if (a.method === "mark_read") return { zh: `把 Agent Board 上的通知 ${str(a.id)} 标为已读`, en: `Mark the notification ${str(a.id)} read on Agent Board`, covers: ["method", "id"] };
      if (a.method === "mark_all_read") {
        const scoped = set(a.owner) && set(a.repo);
        return {
          zh: `把 Agent Board 上${scoped ? ` ${repo} 的` : "的"}通知全部标为已读`,
          en: `Mark every notification${scoped ? ` of ${repo}` : ""} read on Agent Board`,
          covers: ["method", ...(scoped ? ["owner", "repo"] : [])],
        };
      }
      return undefined;
    case "create_repo": {
      const full = `${set(a.organization) ? `${str(a.organization)}/` : ""}${str(a.name)}`;
      return { zh: `在 Agent Board 上新建仓库 ${full}`, en: `Create the repository ${full} on Agent Board`, covers: ["name", ...said(a, "organization")] };
    }
    case "fork_repo":
      return { zh: `在 Agent Board 上 fork ${str(a.user)}/${str(a.repo)}`, en: `Fork ${str(a.user)}/${str(a.repo)} on Agent Board`, covers: ["user", "repo"] };
    default:
      return undefined;
  }
}

function autopilotWords(tool: string, a: Record<string, unknown>, { str }: Say): Words | undefined {
  // An id is a UUID the person never reads whole: its first 8 characters, which is how Autopilot itself has it confirmed.
  const id = (v: unknown): string => (typeof v === "string" && UUID.test(v) ? `${v.slice(0, 8)}…` : str(v));
  const until = set(a.until) ? str(a.until) : "";
  const untilZh = until ? `，直到 ${until}` : "";
  const untilEn = until ? ` until ${until}` : "";
  const untilKeys = until ? ["until"] : [];
  switch (tool) {
    case "apply_pool_limits":
      return { zh: `在 Autopilot 上修改资源池 ${id(a.pool_id)} 的限额`, en: `Change the limits of pool ${id(a.pool_id)} on Autopilot`, covers: ["pool_id"] };
    case "apply_allocation_stop":
      return {
        zh: `在 Autopilot 上停止分配 ${id(a.allocation_id)} 的第 ${str(a.generation)} 代`,
        en: `Stop generation ${str(a.generation)} of allocation ${id(a.allocation_id)} on Autopilot`,
        covers: ["allocation_id", "generation"],
      };
    case "apply_allocation_resolve": {
      const finding = set(a.finding) ? str(a.finding, 200) : "";
      return {
        zh: `在 Autopilot 上了结分配 ${id(a.allocation_id)} 的第 ${str(a.generation)} 代${finding ? `，检查结果：「${finding}」` : ""}`,
        en: `Close generation ${str(a.generation)} of allocation ${id(a.allocation_id)} on Autopilot${finding ? `, having found "${finding}"` : ""}`,
        covers: ["allocation_id", "generation", ...said(a, "finding")],
      };
    }
    case "apply_gpupool_spec":
      return { zh: `在 Autopilot 上修改 GPU 池 ${str(a.name)} 的 QoS`, en: `Change the QoS of GPU pool ${str(a.name)} on Autopilot`, covers: ["name"] };
    case "apply_gpupool_layout":
      return { zh: `在 Autopilot 上替换 GPU 池 ${str(a.name)} 的整个布局`, en: `Replace the whole layout of GPU pool ${str(a.name)} on Autopilot`, covers: ["name"] };
    case "apply_gpupool_delete":
      return { zh: `在 Autopilot 上删除 GPU 池 ${str(a.name)}`, en: `Delete GPU pool ${str(a.name)} on Autopilot`, covers: ["name"] };
    case "apply_gpupool_create": {
      const named = set(a.name) ? str(a.name) : str(a.namespace);
      return {
        zh: `在 Autopilot 上新建 GPU 池 ${named}（命名空间 ${str(a.namespace)}，节点类型 ${str(a.node_class)}）`,
        en: `Create GPU pool ${named} on Autopilot (namespace ${str(a.namespace)}, node class ${str(a.node_class)})`,
        covers: ["namespace", "node_class", ...said(a, "name")],
      };
    }
    case "apply_host_exclusion_add":
      return { zh: `在 Autopilot 上把主机 ${str(a.host)} 排除出所有资源池${untilZh}`, en: `Exclude host ${str(a.host)} from every pool on Autopilot${untilEn}`, covers: ["host", ...untilKeys] };
    case "apply_host_exclusion_remove":
      return { zh: `在 Autopilot 上取消主机 ${str(a.host)} 的排除`, en: `Lift the exclusion of host ${str(a.host)} on Autopilot`, covers: ["host"] };
    case "apply_submit_account_exclusion_add":
      return { zh: `在 Autopilot 上停用提交账号 ${str(a.account)}${untilZh}`, en: `Take the submit account ${str(a.account)} out of new submissions on Autopilot${untilEn}`, covers: ["account", ...untilKeys] };
    case "apply_submit_account_exclusion_remove":
      return { zh: `在 Autopilot 上恢复提交账号 ${str(a.account)}`, en: `Put the submit account ${str(a.account)} back into new submissions on Autopilot`, covers: ["account"] };
    default:
      return undefined;
  }
}

function safeWords(tool: string, a: Record<string, unknown>, { str, list }: Say): Words | undefined {
  const workload = str(a.workload_id);
  const node = str(a.node_id);
  switch (tool) {
    case "workload_stop":
      return { zh: `在 SaFE 上停止任务 ${workload}`, en: `Stop the workload ${workload} on SaFE`, covers: ["workload_id"] };
    case "workload_resume":
      return { zh: `在 SaFE 上恢复任务 ${workload}`, en: `Resume the workload ${workload} on SaFE`, covers: ["workload_id"] };
    case "workload_delete":
      return { zh: `在 SaFE 上删除任务 ${workload}`, en: `Delete the workload ${workload} on SaFE`, covers: ["workload_id"] };
    case "workload_batch_stop":
      return { zh: `在 SaFE 上停止任务 ${list(a.workload_ids)}`, en: `Stop the workloads ${list(a.workload_ids)} on SaFE`, covers: ["workload_ids"] };
    case "workload_batch_delete":
      return { zh: `在 SaFE 上删除任务 ${list(a.workload_ids)}`, en: `Delete the workloads ${list(a.workload_ids)} on SaFE`, covers: ["workload_ids"] };
    case "node_cordon":
      return { zh: `在 SaFE 上把节点 ${node} 设为不可调度`, en: `Cordon node ${node} on SaFE`, covers: ["node_id"] };
    case "node_uncordon":
      return { zh: `在 SaFE 上恢复节点 ${node} 的调度`, en: `Uncordon node ${node} on SaFE`, covers: ["node_id"] };
    case "node_drain":
      return { zh: `在 SaFE 上清空节点 ${node} 上的任务`, en: `Drain node ${node} on SaFE`, covers: ["node_id"] };
    case "node_reboot":
      return { zh: `在 SaFE 上重启节点 ${node}`, en: `Reboot node ${node} on SaFE`, covers: ["node_id"] };
    case "node_delete":
      return { zh: `在 SaFE 上删除节点 ${node}`, en: `Delete node ${node} on SaFE`, covers: ["node_id"] };
    default:
      return undefined;
  }
}

/** The words for a tool of the API's GitHub server, and the inputs they say; undefined for a tool they do not know. */
function githubWords(
  tool: string,
  a: Record<string, unknown>,
  { str, list, at }: { str: (v: unknown, max?: number) => string; list: (v: unknown) => string; at: string },
): Words | undefined {
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
      // An empty description clears it: there is no text below to read, so the words say so.
      if (typeof a.body === "string") {
        if (a.body.trim()) { zh.push("正文改为下文"); en.push("description to the text below"); } else { zh.push("清空正文"); en.push("clear the description"); }
      }
      if (a.state === "closed") { zh.push("关闭它"); en.push("close it"); covers.push("state"); }
      if (a.state === "open") { zh.push("重新打开"); en.push("reopen it"); covers.push("state"); }
      return { zh: `修改 ${at}${zh.length ? `：${zh.join("，")}` : ""}`, en: `Change ${at}${en.length ? `: ${en.join(", ")}` : ""}`, covers };
    }
    case "review_thread_reply":
      return { zh: `以你的 GitHub 账号在评审线程 ${str(a.thread_id)} 里回复`, en: `Reply in review thread ${str(a.thread_id)} as your GitHub account`, covers: ["thread_id"] };
    case "review_thread_resolve":
      return { zh: `把评审线程 ${str(a.thread_id)} 标为已解决`, en: `Mark review thread ${str(a.thread_id)} resolved`, covers: ["thread_id"] };
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
