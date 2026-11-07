// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * What an approval notification says is being approved: the command or the tool
 * with its salient inputs, masked first and cut second, never longer than 300.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { pendingText } from "../src/assistant/holds.js";
import { heldWriteText } from "../src/assistant/outbound.js";
import { APPROVAL_TARGET_MAX, approvalAction, approvalTarget, redactCommandSecrets } from "../src/notifications/approval-target.js";

const GH = "ghp_0123456789abcdefghijklmnopqrstuvwxyzAB";

// Each row: a command, and a string that must NOT survive in the target.
const SECRET_COMMANDS: Array<[string, string, string]> = [
  ["a vendor token in an env assignment", `GH_TOKEN=${GH} git push`, GH],
  ["a plain value in a secret-named variable", "GH_TOKEN=abc123xyz git push origin main", "abc123xyz"],
  ["a password variable", "export DB_PASSWORD=hunter2 && ./migrate", "hunter2"],
  ["a quoted secret value", `API_KEY="s3cr3t value with spaces" ./run`, "s3cr3t value"],
  ["a lower-case secret name", "my_token=zzz111 ./run", "zzz111"],
  ["a name that is only the keyword", "TOKEN=zzz222 ./run", "zzz222"],
  ["a --token flag", "tool --token abc123def456 run", "abc123def456"],
  ["a --token=value flag", "kubectl --token=abcdef123456 get pods", "abcdef123456"],
  ["a --password flag", "mysql --password hunter2 -e 'select 1'", "hunter2"],
  ["a qualified token flag with a separate value", "helm --kube-token hunter2 upgrade prod ./chart", "hunter2"],
  ["a qualified token flag with =", "kubectl --kube-token=abcdef123456 get pods", "abcdef123456"],
  ["an api-key flag with a prefix", "tool --my-api-key abcdef123456 run", "abcdef123456"],
  ["a secret-access-key flag", "aws --secret-access-key wJalrXUtnFEMI s3 ls", "wJalrXUtnFEMI"],
  ["an oauth bearer flag", "curl --oauth2-bearer abc123def https://x.example.invalid", "abc123def"],
  ["a short qualified flag", "tool -x-token=abc987 run", "abc987"],
  ["a quoted flag value with spaces", "tool --client-secret 'a b c' run", "a b c"],
  ["a flag with a suffix after the word", "tool --token-file /run/secrets/tok --other x", "/run/secrets/tok"],
  ["a credentials flag", "tool --credentials abc123xyz run", "abc123xyz"],
  ["a credentials variable", "AWS_CREDENTIALS=zzz777 ./run", "zzz777"],
  ["a cookie variable", "COOKIE=sessionid123 curl https://x.example.invalid", "sessionid123"],
  ["an auth variable", "MY_AUTH=zzz555 ./run", "zzz555"],
  ["a bearer header", "curl -H 'Authorization: Bearer abcdefghijklmnopqrstuvwxyz0123' https://x.example.invalid", "abcdefghijklmnopqrstuvwxyz0123"],
  ["basic auth", "curl -u admin:hunter2 https://x.example.invalid", "hunter2"],
  ["basic auth, long form", "curl --user admin:hunter2 https://x.example.invalid", "hunter2"],
  ["userinfo in a url", "git push https://user:s3cretpass@github.com/o/r.git main", "s3cretpass"],
  ["a token as the userinfo", `git push https://x-access-token:${GH}@github.com/o/r`, GH],
  ["a database url", "psql postgres://u:pw123456@db.example.invalid/x", "pw123456"],
  ["a json password field", `curl -d '{"password": "hunter2", "user": "a"}' https://x.example.invalid`, "hunter2"],
  ["a vendor token standing alone", `echo ${GH}`, GH],
];

for (const [label, command, secret] of SECRET_COMMANDS) {
  test(`bash target masks ${label}`, () => {
    const target = approvalTarget("bash", { command });
    assert.equal(target.includes(secret), false, target);
    assert.ok(target.length <= APPROVAL_TARGET_MAX);
    assert.match(target, /redacted/i, "and says that something was masked");
  });
}

test("words that merely resemble credential names are left alone", () => {
  for (const c of [
    "git commit --author \"Ada L <ada@example.invalid>\" -m x",
    "git log --authors-file x",
    "export AUTHOR=ada",
    "grep -rn --include '*.token' needle .",
    "ls --all --author",
    "tar --exclude secrets.txt -czf a.tgz .",
    "echo the password is rotated monthly",
  ]) assert.equal(approvalTarget("bash", { command: c }), c, c);
});

test("a command with nothing secret in it comes through as it was written, on one line", () => {
  assert.equal(approvalTarget("bash", { command: "git push origin feat/x" }), "git push origin feat/x");
  assert.equal(approvalTarget("bash", { command: "cd /workspace/app &&\n  git push -u origin HEAD" }), "cd /workspace/app && git push -u origin HEAD");
  assert.equal(approvalTarget("Bash", { command: "gh pr create --fill" }), "gh pr create --fill", "the tool name is not case-sensitive");
  assert.equal(approvalTarget("bash", { command: "  rm -rf /tmp/x  " }), "rm -rf /tmp/x");
  for (const harmless of ["git status", "echo PASSWORDS are mentioned here", "ls --all", "grep -r token docs/"]) {
    assert.equal(approvalTarget("bash", { command: harmless }), harmless, harmless);
  }
});

test("a bash call without a command says only that it is bash", () => {
  assert.equal(approvalTarget("bash", {}), "bash");
  assert.equal(approvalTarget("bash", { command: 5 }), "bash");
  assert.equal(approvalTarget("bash", null), "bash");
  assert.equal(approvalTarget("bash", "git push"), "bash");
});

test("the target is cut at 300 characters with an ellipsis, never more", () => {
  const long = `echo ${"word ".repeat(200)}`;
  const t = approvalTarget("bash", { command: long });
  assert.equal(t.length, APPROVAL_TARGET_MAX);
  assert.ok(t.endsWith("…"));
  assert.ok(t.startsWith("echo word word"));
  const exact = "x".repeat(APPROVAL_TARGET_MAX);
  assert.equal(approvalTarget("bash", { command: exact }), exact, "exactly 300 is not cut");
  assert.equal(approvalTarget("bash", { command: exact + "y" }).length, APPROVAL_TARGET_MAX);
  assert.equal(approvalTarget("bash", { command: "x".repeat(500_000) }).length, APPROVAL_TARGET_MAX, "a huge command is cut without scanning all of it");
});

test("a secret that would straddle the cut is masked, not half shown", () => {
  const prefix = "a".repeat(290);
  const t = approvalTarget("bash", { command: `${prefix} --token abcdefghijklmnopqrstuvwxyz` });
  assert.equal(t.includes("abcdefg"), false, t);
  assert.ok(t.length <= APPROVAL_TARGET_MAX);
  const vendor = approvalTarget("bash", { command: `${"b".repeat(285)} ${GH}` });
  assert.equal(vendor.includes("ghp_0123"), false, vendor);
});

test("an MCP tool: its name and the salient inputs", () => {
  assert.equal(
    approvalTarget("mcp__jobs__create_run", { plan_id: "p-1", gpus: 8, dry_run: false }),
    "mcp__jobs__create_run plan_id=p-1 gpus=8 dry_run=false",
  );
  assert.equal(approvalTarget("mcp__board__post", {}), "mcp__board__post");
  assert.equal(approvalTarget("mcp__board__post", null), "mcp__board__post");
  assert.equal(approvalTarget("mcp__x__y", { a: null, b: "", c: undefined, d: 1 }), "mcp__x__y d=1", "empty values say nothing");
});

test("an MCP tool: at most six fields, long values and nested ones clipped, whitespace collapsed", () => {
  const input = { a: 1, b: 2, c: 3, d: 4, e: 5, f: 6, g: 7 };
  assert.equal(approvalTarget("t", input), "t a=1 b=2 c=3 d=4 e=5 f=6");
  const long = approvalTarget("t", { body: "z".repeat(500) });
  assert.equal(long.length, "t body=".length + 80);
  assert.ok(long.endsWith("…"));
  assert.equal(approvalTarget("t", { cfg: { a: 1, b: [1, 2] } }), 't cfg={"a":1,"b":[1,2]}');
  assert.equal(approvalTarget("t", { note: "line one\n   line two" }), "t note=line one line two");
});

test("an MCP tool: credential-looking keys keep their name and lose their value; secret shapes in values are masked", () => {
  const t = approvalTarget("mcp__x__call", { api_key: "k-123456789", password: "hunter2", url: "https://u:pw123456@h.example.invalid/x", note: `see ${GH}` });
  for (const secret of ["k-123456789", "hunter2", "pw123456", GH]) assert.equal(t.includes(secret), false, t);
  assert.match(t, /api_key=<redacted>/);
  assert.match(t, /password=<redacted>/);
  assert.ok(t.length <= APPROVAL_TARGET_MAX);
});

test("an MCP tool: a value under a credential-like key is masked by the key's name alone", () => {
  // None of these values has a shape the general patterns know, and none of the names carries a
  // word the command-line patterns look for (token, secret, password, ...): the key list is what masks them.
  const t = approvalTarget("mcp__x__call", { dsn: "plain-dsn-value1", pat: "plain-pat-value2", platform_key: "plain-key-value3", connection_string: "plain-cs-value4" });
  for (const secret of ["plain-dsn-value1", "plain-pat-value2", "plain-key-value3", "plain-cs-value4"]) assert.equal(t.includes(secret), false, t);
  assert.match(t, /dsn=\[REDACTED\]/);
  assert.match(t, /pat=\[REDACTED\]/);
  assert.match(t, /platform_key=\[REDACTED\]/);
});

test("a tool that is not a string, and input that is not an object, never throw", () => {
  assert.equal(approvalTarget(undefined, { a: 1 }), " a=1".trim());
  assert.equal(approvalTarget(5, undefined), "");
  assert.equal(approvalTarget("t", "just a string"), "t");
  assert.equal(approvalTarget("t", [1, 2, 3]), "t");
  assert.doesNotThrow(() => approvalTarget("t", { self: Object.create(null) }));
});

test("redactCommandSecrets is idempotent and leaves ordinary text alone", () => {
  const once = redactCommandSecrets(`GH_TOKEN=abc123 curl -u a:b https://h --token zzz`);
  assert.equal(redactCommandSecrets(once), once);
  assert.equal(redactCommandSecrets("git log --oneline -5"), "git log --oneline -5");
});

test("approvalAction says every field a GitHub write sets, and shows the ones its words do not know", () => {
  const say = (tool: string, input: Record<string, unknown>, zh = false) => approvalAction(`mcp__github__${tool}`, input, zh).action;
  assert.equal(say("pr_update", { repo: "o/r", number: 5, title: "New", base: "release" }), 'Change o/r#5: title to "New", base to release');
  assert.equal(say("pr_update", { repo: "o/r", number: 5, title: "New", base: "release" }, true), "修改 o/r#5：标题改为「New」，base 改为 release");
  assert.equal(say("pr_update", { repo: "o/r", number: 5, body: "b", state: "open" }), "Change o/r#5: description to the text below, reopen it");
  // An empty description clears it, and the words say so: there is no text to show below them.
  assert.equal(say("pr_update", { repo: "o/r", number: 5, body: "" }), "Change o/r#5: clear the description");
  assert.equal(say("pr_update", { repo: "o/r", number: 5, body: "  " }, true), "修改 o/r#5：清空正文");
  assert.equal(say("review_thread_resolve", { thread_id: "PRRT_abc" }), "Mark review thread PRRT_abc resolved");
  assert.equal(say("issue_create", { repo: "o/r", title: "T", labels: ["bug"] }), 'Open an issue "T" in o/r labelled bug as your GitHub account');
  assert.equal(say("pr_create", { repo: "o/r", head: "h", base: "main", title: "T", draft: true }), 'Open a draft pull request "T" in o/r (h → main) as your GitHub account');
  assert.equal(say("pr_create", { repo: "o/r", head: "h", base: "main", title: "T", draft: false }), 'Open a pull request "T" in o/r (h → main) as your GitHub account');
  assert.equal(say("pr_request_reviewers", { repo: "o/r", number: 5, reviewers: ["a"], team_reviewers: ["t"] }), "Ask a, t to review o/r#5");
  // A field added to a tool later, or a value the words cannot say, is shown and masked, not dropped.
  assert.equal(say("pr_update", { repo: "o/r", number: 5, milestone: 3, state: "weird" }), "Change o/r#5 (also setting milestone=3 state=weird)");
  const leaked = say("issue_comment", { repo: "o/r", number: 5, body: "x", token: GH });
  assert.ok(!leaked.includes(GH) && /also setting token=/.test(leaked), leaked);
  // The body is the detail, not a field to repeat.
  assert.deepEqual(approvalAction("mcp__github__issue_comment", { repo: "o/r", number: 5, body: "hi" }, false), { action: "Post a comment on o/r#5 as your GitHub account", detail: "hi" });
});

// Every write tool of the servers Claw holds writes for, with the inputs it takes, as their tools/list gave them live on 2026-11-07
// (`approval-coverage-check.py`: dispatron 26, agent-board 6, autopilot 11, safe 29 writes). A held write of any of them is put to
// the person in words: never as its `mcp__<server>__<tool>` name (G0 run 2026-11-07: four cases showed "执行 mcp__dispatron__…").
const LIVE_WRITES: Record<string, Record<string, string[]>> = {
  "dispatron": {
    post_runs_task_id_owner: ["task_id", "reason", "github"],
    post_runs_task_id_not_defect: ["task_id", "reason"],
    delete_runs_task_id_not_defect: ["task_id", "reason", "expected_change"],
    post_problems_problem_id_resolve: ["problem_id", "expected_state", "reason", "kind", "link"],
    post_problems_problem_id_reopen: ["problem_id", "expected_state", "reason", "expected_change"],
    post_problems_problem_id_diagnosis_mark: ["problem_id", "expected_state", "reason", "verdict", "note", "expected_change"],
    post_change_log_change_id_revert: ["change_id", "reason", "dry_run"],
    put_configs: ["reason", "configs"],
    post_plans: ["reason", "expected_updated_at", "name", "plan_id", "platform_id", "workspace", "mode", "kind", "max_concurrency", "loop_delay_seconds", "cron_expr", "timezone", "catalog_feed"],
    put_plans_plan_id_overrides: ["plan_id", "params", "env", "images", "reason", "expected_updated_at"],
    patch_configs_config_id_params: ["config_id", "reason", "params", "env", "columns", "rename", "expected_updated_at"],
    post_configs_config_id_copy: ["config_id", "reason", "name", "params", "env", "columns", "expected_updated_at"],
    patch_configs_params: ["reason", "configs"],
    put_plans_plan_id_schedule: ["plan_id", "reason", "expected_updated_at", "mode", "cron_expr", "timezone"],
    post_plans_plan_id_recycle: ["plan_id", "batch_id", "reason", "expected_updated_at"],
    put_plans_plan_id_status: ["plan_id", "reason", "expected_updated_at", "status", "batch_id"],
    put_plans_plan_id_automation: ["plan_id", "reason", "expected_updated_at", "automation"],
    post_plans_plan_id_items: ["plan_id", "reason", "expected_updated_at", "config_ids"],
    delete_plans_plan_id_items_config_id: ["plan_id", "config_id", "reason", "expected_updated_at"],
    patch_plans_plan_id_items_config_id: ["plan_id", "config_id", "reason", "expected_updated_at", "retry_limit", "platform_id", "ring", "expected"],
    post_plans_plan_id_items_config_id_requeue: ["plan_id", "config_id", "reason", "expected_updated_at"],
    patch_plans_plan_id_labels: ["plan_id", "labels", "reason", "expected_updated_at"],
    post_runs_task_id_issue: ["task_id", "reason", "title", "body"],
    post_runs_task_id_issue_link: ["task_id", "reason", "url"],
    post_runs_task_id_issue_unlink: ["task_id", "reason", "expected_url"],
    post_runs_task_id_cancel: ["task_id", "reason"],
  },
  "agent-board": {
    create_repo: ["auto_init", "default_branch", "description", "gitignores", "issue_labels", "license", "name", "object_format_name", "organization", "private", "readme", "template", "trust_model"],
    fork_repo: ["name", "organization", "repo", "user"],
    issue_write: ["assignees", "body", "commentID", "deadline", "dependency_type", "issue_number", "label_id", "labels", "method", "milestone", "owner", "ref", "related_issue_number", "related_owner", "related_repo", "remove_deadline", "repo", "state", "title"],
    label_write: ["color", "description", "exclusive", "id", "is_archived", "method", "name", "org", "owner", "repo"],
    milestone_write: ["description", "due_on", "id", "method", "owner", "repo", "state", "title"],
    notification_write: ["id", "last_read_at", "method", "owner", "repo"],
  },
  "autopilot": {
    apply_pool_limits: ["confirm_token", "expected_policy_revision", "limits", "pool_id"],
    apply_allocation_stop: ["allocation_id", "confirm_id_prefix", "confirm_token", "expected_transition_revision", "generation", "reason"],
    apply_allocation_resolve: ["allocation_id", "checked_at", "checked_command", "confirm_token", "finding", "generation"],
    apply_gpupool_spec: ["confirm_token", "expected_generation", "external_budget", "name", "qos", "reason"],
    apply_gpupool_layout: ["confirm_token", "exclude_reasons", "expected_generation", "layout", "name", "reason"],
    apply_gpupool_delete: ["confirm_name", "confirm_token", "expected_uid", "name", "reason"],
    apply_host_exclusion_add: ["confirm_token", "host", "reason", "until"],
    apply_host_exclusion_remove: ["confirm_token", "host", "reason"],
    apply_submit_account_exclusion_add: ["account", "confirm_token", "reason", "until"],
    apply_submit_account_exclusion_remove: ["account", "confirm_token", "reason"],
    apply_gpupool_create: ["external_budget", "name", "namespace", "node_class", "qos"],
  },
  "safe": {
    workspace_manage_nodes: ["action", "node_ids", "workspace_id"],
    workload_stop: ["workload_id"],
    workspace_create: ["cluster_id", "description", "enable_preempt", "flavor_id", "image_secret_ids", "is_default", "name", "queue_policy", "replica", "scopes", "volumes"],
    node_create: ["flavor_id", "hostname", "labels", "port", "private_ip", "public_ip", "ssh_secret_id", "template_id"],
    node_delete: ["force", "node_id"],
    node_reboot: ["job_name", "node_id"],
    workload_create: ["customer_labels", "description", "display_name", "entry_points", "env", "excluded_nodes", "images", "is_supervised", "is_tolerate_all", "kind", "liveness", "max_retry", "preheat", "priority", "readiness", "resources", "secrets", "service", "specified_nodes", "sticky_nodes", "timeout", "ttl_seconds_after_finished", "workspace_id"],
    workload_delete: ["workload_id"],
    workload_batch_delete: ["workload_ids"],
    cluster_delete: ["cluster_id"],
    workspace_delete: ["workspace_id"],
    node_update: ["flavor_id", "labels", "node_id", "port", "private_ip", "taints", "template_id"],
    node_cordon: ["node_id"],
    workspace_update: ["description", "enable_preempt", "flavor_id", "image_secret_ids", "is_default", "managers", "queue_policy", "replica", "scopes", "volumes", "workspace_id"],
    workspace_scale: ["replica", "workspace_id"],
    workload_batch_stop: ["workload_ids"],
    opsjob_create: ["available_ratio", "batch_count", "entry_point", "env", "excluded_nodes", "hostpath", "image", "inputs", "is_tolerate_all", "name", "resource", "security_upgrade", "timeout_second", "ttl_seconds_after_finished", "type", "workspace_id"],
    opsjob_stop: ["job_id"],
    opsjob_delete: ["job_id"],
    cluster_manage_nodes: ["action", "cluster_id", "node_ids"],
    workload_resume: ["workload_id"],
    cluster_update: ["cluster_id", "is_control_plane", "is_protected", "kube_spray_image", "kube_version", "labels"],
    workload_update: ["description", "entry_points", "env", "images", "max_retry", "priority", "resources", "service", "timeout", "workload_id"],
    workload_logs_download: ["timeout_second", "workload_id"],
    apikey_create: ["name", "ttl_days", "whitelist"],
    cluster_create: ["description", "image_secret_id", "is_protected", "kube_api_server_args", "kube_network_plugin", "kube_pods_subnet", "kube_service_address", "kube_spray_image", "kube_version", "labels", "name", "nodes", "ssh_secret_id"],
    node_uncordon: ["node_id"],
    node_drain: ["force", "ignore_daemonsets", "node_id", "timeout"],
    apikey_delete: ["apikey_id"],
  },
};
// The methods a tool takes as `method`, each a different write.
const METHODS: Record<string, string[]> = {
  issue_write: ["create", "update", "add_comment", "edit_comment", "add_labels", "remove_label", "replace_labels", "clear_labels", "add_dependency", "remove_dependency"],
  label_write: ["create_repo_label", "edit_repo_label", "delete_repo_label", "create_org_label", "edit_org_label", "delete_org_label"],
  milestone_write: ["create", "update", "edit", "delete"],
  notification_write: ["mark_read", "mark_all_read"],
};
const ID = "3f2b9c1e-7a44-4d2e-9b1a-0c5e6f7a8b9c";
function sampleInput(keys: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of keys) {
    if (k === "pool_id" || k === "allocation_id") out[k] = ID;
    else if (/(^|_)(ids?|number|generation|revision|commentID)$|_id$|^id$/.test(k) && k !== "task_id" && k !== "workload_id" && k !== "node_id") out[k] = 7;
    else if (/s$/.test(k) && /(labels|ids|configs|assignees|nodes|images|entry_points|secrets|scopes|volumes|managers)$/.test(k)) out[k] = ["a"];
    else if (k === "verdict") out[k] = "right";
    else if (k === "dependency_type") out[k] = "blocking";
    else if (k === "dry_run" || k === "force") out[k] = true;
    else out[k] = `${k}-v`;
  }
  return out;
}
const liveCalls = (): Array<[string, Record<string, unknown>]> => Object.entries(LIVE_WRITES).flatMap(([server, tools]) =>
  Object.entries(tools).flatMap(([tool, keys]) => (METHODS[tool] ?? [undefined]).map((method): [string, Record<string, unknown>] =>
    [`mcp__${server}__${tool}${method ? `#${method}` : ""}`, { ...sampleInput(keys), ...(method ? { method } : {}) }])));

test("a held write of any non-GitHub server is said in words, never by its mcp__ name, in the action and the message the person reads", () => {
  const calls = liveCalls();
  assert.equal(calls.length, 26 + 2 + 10 + 6 + 4 + 2 + 11 + 29, "every live write, each method its own");
  for (const [label, input] of calls) {
    const tool = label.split("#")[0]!;
    for (const zh of [true, false]) {
      const { action } = approvalAction(tool, input, zh);
      assert.doesNotMatch(action, /\bmcp__/, `${label} ${zh ? "zh" : "en"}: ${action}`);
      const params = { holds: [{ kind: "approval", attention_seq: 2, action, zh, expires_at: "2026-11-07T18:00:00Z", tool_use_id: "tu-1" }] };
      const text = heldWriteText({ seq: 3, title: "t", board_state: "needs_you", attention_seq: 2 }, params);
      assert.ok(text && !/\bmcp__/.test(text), `${label}: ${text}`);
      // The pending question a channel or the console shows, as `holds.ts` writes it, says the same words, in either language.
      assert.doesNotMatch(pendingText("approval", approvalTarget(tool, input), zh, action), /\bmcp__/, `${label} ${zh ? "zh" : "en"} pending`);
    }
  }
});

test("the writes of Dispatron, Agent Board and Autopilot have their own words, and the service's name otherwise", () => {
  const generic = /^在 \S+(?: \S+)? 上(?:更新|提交|修改|删除|应用|新建|设置|添加|移除|停止|启动|取消|写入|执行)「/;
  for (const [label, input] of liveCalls()) {
    if (label.startsWith("mcp__safe__")) continue;
    const { action } = approvalAction(label.split("#")[0]!, input, true);
    assert.doesNotMatch(action, generic, `${label} has no words of its own: ${action}`);
  }
  const zh = (tool: string, input: Record<string, unknown>) => approvalAction(tool, input, true).action;
  const en = (tool: string, input: Record<string, unknown>) => approvalAction(tool, input, false).action;
  // The four G0 cases (2026-11-07): what each one held, as the person now reads it.
  assert.equal(
    zh("mcp__dispatron__post_runs_task_id_not_defect", { task_id: "hyperloom:11-13-g62-a4440c8798", reason: "infra 中断，不是代码问题" }),
    "在 Dispatron 上把运行 hyperloom:11-13-g62-a4440c8798 标为「不是缺陷」，理由：「infra 中断，不是代码问题」",
  );
  assert.equal(
    zh("mcp__dispatron__put_plans_plan_id_automation", { plan_id: 12, automation: { retry_on_preempt: true }, expected_updated_at: "2026-11-07T11:00:00Z" }),
    '在 Dispatron 上修改计划 12 的自动化设置，参数：automation={"retry_on_preempt":true}',
    "the setting is shown as it would be written; the precondition is not",
  );
  assert.deepEqual(
    approvalAction("mcp__agent-board__issue_write", { method: "create", owner: "boards", repo: "cortex", title: "评测平台定 Langfuse", body: "@weilei 请确认" }, true),
    { action: "以你的 Agent Board 账号在 boards/cortex 新建话题「评测平台定 Langfuse」", detail: "@weilei 请确认" },
  );
  assert.equal(en("mcp__agent-board__issue_write", { method: "add_comment", owner: "boards", repo: "cortex", issue_number: 4, body: "ok" }), "Post a reply on boards/cortex#4 as your Agent Board account");
  assert.equal(
    zh("mcp__autopilot__apply_allocation_stop", { allocation_id: ID, generation: 2, expected_transition_revision: 5, reason: "空跑", confirm_id_prefix: "3f2b9c1e", confirm_token: "ct-abcdefgh" }),
    "在 Autopilot 上停止分配 3f2b9c1e… 的第 2 代，理由：「空跑」",
  );
  assert.equal(en("mcp__safe__workload_stop", { workload_id: "w-1" }), "Stop the workload w-1 on SaFE");
  // A tool the words do not know: the service and its name in words, and every input shown.
  assert.equal(zh("mcp__dispatron__put_plans_plan_id_flags", { plan_id: 3, flags: "x" }), "在 Dispatron 上更新「plans plan id flags」，参数：plan_id=3 flags=x");
  assert.equal(en("mcp__my-tool__frobnicate", { a: 1 }), 'Run "frobnicate" on My Tool, with a=1');
  // A field a known tool's words do not say is shown, and masked, not dropped; an unknown value falls back to the generic words.
  assert.match(zh("mcp__dispatron__post_runs_task_id_cancel", { task_id: "t-1", force: true, api_token: GH }), /^在 Dispatron 上取消运行 t-1，参数：force=true api_token=/);
  assert.ok(!zh("mcp__dispatron__post_runs_task_id_cancel", { task_id: "t-1", note: `GH_TOKEN=${GH}` }).includes(GH));
  assert.equal(zh("mcp__dispatron__post_problems_problem_id_diagnosis_mark", { problem_id: 4, verdict: "maybe" }), "在 Dispatron 上提交「problems problem id diagnosis mark」，参数：problem_id=4 verdict=maybe");
  // The preconditions of an unknown tool are not known to be preconditions: they are shown.
  assert.match(zh("mcp__x__set_y", { expected_updated_at: "t" }), /参数：expected_updated_at=t$/);
});
