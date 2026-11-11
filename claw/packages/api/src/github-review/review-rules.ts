// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Checks by language and file type, chosen by the paths a pull request changes and added to the deep review's instructions.
 *
 * A general review prompt names logic, security and compatibility, and leaves the reviewer to remember what usually goes wrong in
 * a given language. These packs name it, briefly and only as defect classes (what goes wrong, and when): no style rules, nothing a
 * compiler, formatter or linter reports by itself. The idea of matching rule documents to files by path comes from
 * alibaba/open-code-review (`config/rules/system_rules.json`); the packs here are our own text.
 */

export interface RulePack {
  id: string;
  title: string;
  /** Whether a changed path is one this pack is about. */
  matches: (path: string) => boolean;
  checks: string;
}

const ext = (...exts: string[]) => (p: string): boolean => exts.some((e) => p.toLowerCase().endsWith(e));
const base = (p: string): string => p.slice(p.lastIndexOf("/") + 1);
const DEPLOY_DIRS = new Set(["templates", "charts", "k8s", "manifests", "deploy"]);

export const RULE_PACKS: readonly RulePack[] = [
  {
    id: "go",
    title: "Go",
    matches: ext(".go"),
    checks: `- An error that is ignored, overwritten before it is read, or turned into a success or a zero value on a path where the operation failed; \`%v\` where callers need \`errors.Is\`/\`As\` (\`%w\`).
- A nil map written to, a nil pointer dereferenced on a path the inputs can reach, a typed nil stored in an interface and later compared with nil.
- A goroutine that can block for ever (a send nobody receives, a channel never closed, no context to stop it), or request work started on \`context.Background()\` instead of the caller's context.
- Shared state (a map, a slice, a counter) read and written from goroutines without a lock or atomic; a struct holding a mutex copied by value.
- \`defer\` inside a loop that holds resources until the function returns; a response body, file or rows not closed on every path.
- \`append\` to a slice that aliases a caller's array; a loop variable captured by a closure that runs later (before Go 1.22).
- An integer conversion that can overflow or truncate (int64 to int32, a length from untrusted input), a division by a value that can be zero.`,
  },
  {
    id: "python",
    title: "Python",
    matches: ext(".py", ".pyi"),
    checks: `- A mutable default argument (\`def f(x=[])\`); a closure in a loop that captures the loop variable late.
- An exception swallowed (\`except: pass\`, \`except Exception\` that logs and continues) so a failure reads as success, or a variable used after the \`try\` that the failing branch never set.
- In async code: a blocking call (\`requests\`, \`time.sleep\`, file or subprocess I/O) on the event loop, a coroutine never awaited, a task never kept or awaited.
- A file, connection or lock not released on an error path (no \`with\`), a dict or list changed while it is iterated.
- \`is\` used to compare values, \`==\` against \`None\`/booleans where the type allows a falsy value, integer division or float rounding that changes a count.
- Untrusted input reaching \`subprocess\` with \`shell=True\`, \`eval\`, \`pickle\`, \`yaml.load\`, a SQL string or a file path without a containment check.
- A naive \`datetime\` compared with an aware one, or local time used where UTC was meant.`,
  },
  {
    id: "ts_js",
    title: "TypeScript and JavaScript",
    matches: ext(".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs", ".vue", ".svelte"),
    checks: `- A promise that is neither awaited nor handled (a rejection lost, or work that outlives the request); \`async\` callbacks in \`forEach\`; \`Promise.all\` where one failure leaves the others half applied.
- A property read on a value that can be \`undefined\` or \`null\` on a reachable path (an optional field, an empty array's first item, a failed lookup).
- A number parsed without checking for \`NaN\`, a falsy check (\`if (!x)\`) that also rejects \`0\` or \`""\`, a comparison of values of different types.
- React: a hook called conditionally or in a loop, an effect with missing dependencies or no cleanup (timers, listeners, subscriptions, aborted fetches), state mutated in place, a list without stable keys, a stale closure over state.
- User or remote text placed as HTML (\`innerHTML\`, \`dangerouslySetInnerHTML\`, \`v-html\`) or into a URL, a shell command, a regular expression or a SQL string without escaping.
- An event listener, interval or stream that is never removed or closed; a cache or map that grows without bound.
- A type cast or \`any\` that hides a real mismatch: the value at run time is not what the type says.`,
  },
  {
    id: "shell",
    title: "Shell",
    matches: (p) => ext(".sh", ".bash")(p) || base(p) === "Makefile",
    checks: `- An unquoted variable that splits or globs, \`rm -rf "$dir/"*\` with a variable that can be empty, a path built from input without a check.
- A failure that does not stop the script (no \`set -e\`/\`-o pipefail\`, a pipe or \`|| true\` hiding a failed step), or \`set -e\` disabled by the construct around it.
- A secret echoed or put on a command line other users can read; \`curl | sh\` of something not pinned.`,
  },
  {
    id: "github_workflows",
    title: "GitHub Actions workflows",
    matches: (p) => /^\.github\/(workflows\/[^/]+|actions\/.+)\.ya?ml$/i.test(p) || /(^|\/)action\.ya?ml$/i.test(p),
    checks: `- \`pull_request_target\` or \`workflow_run\` that checks out or runs the pull request's code with secrets or a write token.
- \`\${{ github.event.* }}\` or another untrusted value inside \`run:\` (script injection): it must go through \`env:\`.
- \`permissions\` wider than the job needs, or left to the default; a secret printed or passed to a step that does not need it.
- A third-party action not pinned to a commit; a condition (\`if:\`) or \`needs:\` that never or always runs the job.`,
  },
  {
    id: "containers",
    title: "Containers, Kubernetes and Helm",
    matches: (p) => {
      const b = base(p);
      if (b === "Dockerfile" || b.startsWith("Dockerfile.")) return true;
      if (!ext(".yaml", ".yml")(b)) return false;
      return b.toLowerCase().startsWith("values") || p.split("/").slice(0, -1).some((d) => DEPLOY_DIRS.has(d.toLowerCase()));
    },
    checks: `- A selector, label, port name or Service target that no longer matches what it selects; a renamed value that a template still reads by its old name.
- A container that runs as root or privileged without need, a secret in an image layer, a ConfigMap or plain env value.
- A probe, resource limit or rollout setting that makes the new pods fail to start or restart in a loop.`,
  },
];

/** The packs for the changed paths, in the order of {@link RULE_PACKS}. */
export function rulePacksFor(paths: readonly string[]): RulePack[] {
  return RULE_PACKS.filter((pack) => paths.some((p) => pack.matches(p)));
}

/**
 * The text added to the deep review's instructions for these paths, or "" when no pack matches. It asks for the checks where the change
 * touches them, and changes nothing about which findings are kept: they go through the same verification as any other.
 */
export function languageChecksText(paths: readonly string[]): string {
  const packs = rulePacksFor(paths);
  if (!packs.length) return "";
  return [
    "## Checks for the languages this change touches",
    "",
    "In the passes of step 5, look in the changed code for these as well. They are where problems usually are, not findings: keep only what you verify in this change, as step 6 says.",
    ...packs.flatMap((p) => ["", `### ${p.title}`, p.checks]),
  ].join("\n");
}
