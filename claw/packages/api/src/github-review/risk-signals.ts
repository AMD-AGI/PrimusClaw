// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * What a change DOES, read from its diff: the content half of the high-risk rule pack
 * (see risk.ts for the floor that does not depend on content).
 *
 * The question a person asks before a merge is not "which kind of file" but "what moved":
 * did the architecture change (a package or a deployable unit appeared or went, a directory
 * moved, the layering or the dependency graph changed), did an interface change (an exported
 * signature, an HTTP route, a schema, a command-line flag, a configuration or environment
 * contract, a database schema, a wire or event format), or did the change touch code that
 * decides who may do what (authentication, cryptography, permissions, secrets).
 *
 * Two properties keep it from crying wolf:
 *
 *  - It reads the NET change. A line that one file loses and another file (or the same file,
 *    reindented) gains cancels out, so a pure refactor, a move of code between files and a
 *    reformat contribute nothing, while a changed or removed signature still shows. Blank
 *    lines and comment lines are not content.
 *  - Documentation and tests are not product code: a sentence about authentication or a test
 *    that exercises a route changes no interface.
 *
 * These are heuristics over text, not a parser. They are tuned to over-report a little (a held
 * merge costs one click) and every one of them only ever ADDS a reason; nothing here can make
 * a change look safer than the floor in risk.ts says. What they cannot see (a field added to an
 * exported type, a parameter on a wrapped signature line, a behaviour that changed under an
 * unchanged name) is what the reviewing model's own judgement is for.
 */
import { addedLines, removedLines } from "./diff.js";
import type { RiskFile } from "./risk.js";

export type RiskCategory =
  | "architecture" | "interface" | "security" | "ci_release" | "dependency"
  | "size_breadth" | "integrity" | "provenance" | "reviewer";

export interface Finding {
  category: RiskCategory;
  reason: string;
}

// ----------------------------------------------------------------------- what a path is

const DOC_EXT = /\.(md|mdx|markdown|rst|txt|adoc|org)$/i;
const DOC_PATH = /(^|\/)(docs?|documentation)\/|(^|\/)(LICENSE|NOTICE|CHANGELOG|AUTHORS|CONTRIBUTING|README)[^/]*$/i;
const TEST_PATH = /(^|\/)(tests?|__tests__|spec|specs|testdata|fixtures?|e2e|__mocks__)\/|[._-](test|spec)\.[a-z0-9]+$|(^|\/)test_[^/]*\.py$|_test\.(go|py|rs)$/i;

export const isDoc = (p: string): boolean => DOC_EXT.test(p) || DOC_PATH.test(p);
export const isTest = (p: string): boolean => TEST_PATH.test(p);
/** Product code and configuration: everything that is neither documentation nor a test. */
export const isSource = (p: string): boolean => !isDoc(p) && !isTest(p);

/** Directories that sit inside a package rather than above it. */
const INSIDE_PACKAGE = new Set(["src", "lib", "app", "pkg", "internal", "cmd", "test", "tests", "spec", "__tests__", "scripts", "include"]);

/** The directory a file's package lives in: what comes before `src/`, `lib/` and the like, else its own directory. */
export function packageRoot(path: string): string {
  const segments = path.split("/");
  const inside = segments.findIndex((s, i) => i < segments.length - 1 && INSIDE_PACKAGE.has(s));
  return (inside === -1 ? segments.slice(0, -1) : segments.slice(0, inside)).join("/");
}

// ------------------------------------------------------------------ the net change

export interface NetLine { path: string; text: string }
export interface Net {
  added: NetLine[];
  removed: NetLine[];
  /** Files with a changed line longer than {@link MAX_LINE_CHARS}: minified or generated code the patterns below do not read. */
  unreadable: Set<string>;
}

/** The longest line the patterns read. A longer one is cut for them, and said so, so a very long line is a reason of its own. */
export const MAX_LINE_CHARS = 4000;

const norm = (l: string): string => l.trim().replace(/\s+/g, " ");
// `#` opens a comment in shell, Python and YAML but not a Rust attribute (`#[`) or a shebang (`#!`).
const COMMENT = /^(\/\/|\/\*|\*( |\/|$)|#(?![[!])|--( |$)|<!--|"""|''')/;
/** A line that says something: not blank and not only a comment. */
const meaningfulLine = (l: string): boolean => { const n = norm(l); return n !== "" && !COMMENT.test(n); };

/**
 * The lines the change really adds and really removes: a line that is removed in one place and added in
 * another (a move, a reindent) is in neither list.
 */
export function netChange(files: RiskFile[]): Net {
  const lost = new Map<string, number>();
  const removedAll: NetLine[] = [];
  const addedAll: NetLine[] = [];
  const unreadable = new Set<string>();
  const clip = (path: string, text: string): string => {
    if (text.length <= MAX_LINE_CHARS) return text;
    unreadable.add(path);
    return text.slice(0, MAX_LINE_CHARS);
  };
  for (const f of files) {
    for (const raw of removedLines(f.patch)) {
      const text = clip(f.path, raw);
      if (!meaningfulLine(text)) continue;
      removedAll.push({ path: f.path, text });
      lost.set(norm(text), (lost.get(norm(text)) ?? 0) + 1);
    }
    for (const raw of addedLines(f.patch)) {
      const text = clip(f.path, raw);
      if (meaningfulLine(text)) addedAll.push({ path: f.path, text });
    }
  }
  const added: NetLine[] = [];
  for (const l of addedAll) {
    const key = norm(l.text);
    const n = lost.get(key) ?? 0;
    if (n > 0) lost.set(key, n - 1); else added.push(l);
  }
  const removed: NetLine[] = [];
  for (const l of removedAll) {
    const key = norm(l.text);
    const n = lost.get(key) ?? 0;
    if (n > 0) { lost.set(key, n - 1); removed.push(l); }
  }
  return { added, removed, unreadable };
}

/** The paths that have at least one line of net change. */
export function touchedPaths(net: Net): Set<string> {
  return new Set([...net.added, ...net.removed].map((l) => l.path));
}

const sourceLines = (lines: NetLine[]): NetLine[] => lines.filter((l) => isSource(l.path));
const list = (names: string[], max = 3): string => {
  const uniq = [...new Set(names)];
  return uniq.slice(0, max).join(", ") + (uniq.length > max ? ` and ${uniq.length - max} more` : "");
};

// -------------------------------------------------------------------- interface changes

const SCHEMA_FILE = /\.(proto|graphql|graphqls|gql|avsc|thrift|capnp|fbs|xsd|wsdl|smithy|tsp)$|(^|\/)(openapi|swagger|asyncapi)[^/]*\.(ya?ml|json)$|\.(openapi|swagger)\.(ya?ml|json)$|\.schema\.json$|(^|\/)schemas?\/[^/]+\.(json|ya?ml)$/i;
const MIGRATION_PATH = /(^|\/)(migrations?|migrate|alembic\/versions|flyway|liquibase|prisma\/migrations|drizzle|knex)\//i;
const DDL = /\b(?:CREATE|ALTER|DROP|TRUNCATE)\s+(?:OR\s+REPLACE\s+)?(?:UNIQUE\s+)?(?:TEMP(?:ORARY)?\s+)?(?:TABLE|INDEX|VIEW|MATERIALIZED\s+VIEW|TYPE|SEQUENCE|SCHEMA|EXTENSION|TRIGGER|FUNCTION|COLUMN|CONSTRAINT|DATABASE)\b|\bADD\s+(?:COLUMN|CONSTRAINT)\b|\bDROP\s+(?:COLUMN|CONSTRAINT|DEFAULT|NOT\s+NULL)\b|\bRENAME\s+(?:TO|COLUMN|CONSTRAINT)\b/i;
const CONTRACT_DIR = /(^|\/)(protocol|wire|contracts?|idl)\//i;
const ENV_EXAMPLE = /(^|\/)\.env\.(example|sample|template|dist)$/i;

/** An HTTP route as a framework registers it. The path must be a literal that starts with `/` (or `*`), so `map.get("key")` is not one. */
const ROUTES: Array<[RegExp, (m: RegExpExecArray) => string]> = [
  [/(?<![\w$])(?:(?:r|e|g)|\w*(?:app|App|router|Router|fastify|server|Server|mux|Mux|routes?|Routes?|group|Group))\.(get|post|put|patch|delete|options|head|all|route|GET|POST|PUT|PATCH|DELETE|Any)\s*(?:<[^>]*>)?\(\s*[`'"]((?:\/|\*)[^`'"]*)[`'"]/, (m) => `${(m[1] as string).toUpperCase()} ${m[2]}`],
  [/@\w+\.(get|post|put|patch|delete|route|api_route|websocket)\(\s*['"]((?:\/|\*)[^'"]*)['"]/i, (m) => `${(m[1] as string).toUpperCase()} ${m[2]}`],
  [/@(Get|Post|Put|Patch|Delete|Request)Mapping\b(?:\(\s*(?:value\s*=\s*)?"([^"]*)")?/, (m) => `${(m[1] as string).toUpperCase()} ${m[2] ?? ""}`.trim()],
  [/\b(?:http|mux|router|r|e|g|app)\.(?:HandleFunc|Handle)\(\s*"([^"]+)"/, (m) => `${m[1]}`],
  [/\.(?:Methods)\(\s*"(GET|POST|PUT|PATCH|DELETE)"/, (m) => `${m[1]}`],
  [/\b(?:path|re_path|url)\(\s*r?['"]([^'"]*)['"]\s*,/, (m) => `${m[1]}`],
];

const CLI_FLAGS: Array<[RegExp, (m: RegExpExecArray) => string]> = [
  [/\.(?:option|requiredOption|addOption|command)\(\s*['"`](-{0,2}[\w-]+)/, (m) => `${m[1]}`],
  [/\bflag\.(?:String|Bool|Int|Int64|Uint|Float64|Duration|Var|StringVar|BoolVar|IntVar|DurationVar)\(\s*(?:&?[\w.]+,\s*)?"([\w-]+)"/, (m) => `-${m[1]}`],
  [/\.(?:Flags|PersistentFlags)\(\)\.(?:String|Bool|Int|Duration|StringSlice|Count|Float64)\w*\(\s*(?:&?[\w.]+,\s*)?"([\w-]+)"/, (m) => `--${m[1]}`],
  [/\.(?:add_argument|add_option)\(\s*['"](-{1,2}[\w-]+)/, (m) => `${m[1]}`],
  [/@click\.(?:option|argument)\(\s*['"](-{0,2}[\w-]+)/, (m) => `${m[1]}`],
  [/\bArg::new\(\s*"([\w-]+)"/, (m) => `--${m[1]}`],
  [/#\[(?:arg|clap)\([^\]]*\blong\b(?:\s*=\s*"([\w-]+)")?/, (m) => `--${m[1] ?? "(from the field name)"}`],
];

/** Where a program reads its environment. */
const ENV_READS: RegExp[] = [
  /process\.env\.([A-Z][A-Z0-9_]*)/,
  /process\.env\[\s*['"`]([A-Z][A-Z0-9_]*)/,
  /\bos\.(?:Getenv|LookupEnv)\(\s*"([A-Z][A-Z0-9_]*)"/,
  /\bos\.environ(?:\.get)?[[(]\s*['"]([A-Z][A-Z0-9_]*)/,
  /\bgetenv\(\s*['"]([A-Z][A-Z0-9_]*)/,
  /\benv(?:Bool|Int|Str|String|Number|Float)?\(\s*['"`]([A-Z][A-Z0-9_]*)['"`]/,
  /\bstd::env::var\(\s*"([A-Z][A-Z0-9_]*)"/,
  /\bSystem\.getenv\(\s*"([A-Z][A-Z0-9_]*)"/,
];
const SECRET_ENV_NAME = /SECRET|TOKEN|PASSW|PRIVATE|CREDENTIAL|API_?KEY|ACCESS_?KEY/;

type Lang = "js" | "go" | "py" | "jvm" | "rust";
function langOf(path: string): Lang | null {
  if (/\.[cm]?[jt]sx?$/i.test(path)) return "js";
  if (/\.go$/i.test(path)) return "go";
  if (/\.pyi?$/i.test(path)) return "py";
  if (/\.(java|kt|kts|cs|scala)$/i.test(path)) return "jvm";
  if (/\.rs$/i.test(path)) return "rust";
  return null;
}
/** A file that other packages import from: a new export there changes what they can see. */
const PUBLIC_ENTRY = /(^|\/)(index\.[cm]?[jt]sx?|mod\.rs|lib\.rs|__init__\.pyi?)$|\.d\.ts$|\.pyi$/;

interface ExportedSymbol { key: string; name: string; sig: string }

/** What the signature is, without the body that follows it and, for a constant, without the value that initialises it. */
function jsSignature(text: string): string {
  const t = text.trim().replace(/\s*\{\s*$/, "").replace(/;$/, "");
  const decl = /^(export\s+(?:declare\s+)?(?:default\s+)?(?:const|let|var)\s+[^=]+?)\s*=\s*(.*)$/.exec(t);
  if (!decl) return t;
  // A function-valued constant is its parameters: keep them, drop the body.
  const fn = /^((?:async\s*)?(?:<[^>]*>\s*)?(?:\([^)]*\)|[\w$]+)\s*(?::\s*[^=]+?)?\s*=>)/.exec(decl[2] as string);
  return fn ? `${decl[1]} = ${fn[1]}` : (decl[1] as string);
}

function exportedSymbol(lang: Lang, path: string, raw: string): ExportedSymbol | null {
  const t = raw.trim();
  if (lang === "js") {
    const m = /^export\s+(?:declare\s+)?(?:default\s+)?(?:abstract\s+)?(?:async\s+)?(function\s*\*?|class|interface|type|enum|const|let|var|namespace)\s*([A-Za-z_$][\w$]*)?/.exec(t);
    if (m) { const name = m[2] ?? "default"; return { key: name === "default" ? `${path}:default` : `js:${name}`, name, sig: jsSignature(t) }; }
    const names = /^export\s*(?:type\s*)?\{([^}]*)\}/.exec(t);
    if (names) return { key: `${path}:{}`, name: norm(names[1] as string), sig: t };
    const star = /^export\s*\*(?:\s*as\s+\w+)?\s*from\s*['"]([^'"]+)['"]/.exec(t);
    if (star) return { key: `${path}:*${star[1]}`, name: `* from ${star[1]}`, sig: t };
    if (/^export\s+default\b/.test(t)) return { key: `${path}:default`, name: "default", sig: jsSignature(t) };
    return null;
  }
  if (lang === "go") {
    const fn = /^func\s+(?:\(\s*\w*\s*\*?\s*(\w+)(?:\[[^\]]*\])?\s*\)\s*)?([A-Z]\w*)\s*[[(]/.exec(raw);
    if (fn) { const name = fn[1] ? `${fn[1]}.${fn[2]}` : (fn[2] as string); return { key: `go:${name}`, name, sig: t.replace(/\s*\{\s*$/, "") }; }
    const ty = /^(?:type|var|const)\s+([A-Z]\w*)\b/.exec(raw);
    if (ty) return { key: `go:${ty[1]}`, name: ty[1] as string, sig: t.replace(/\s*\{\s*$/, "") };
    return null;
  }
  if (lang === "py") {
    // Top level only (column 0) and not private.
    const def = /^(?:async\s+)?(?:def|class)\s+([A-Za-z]\w*)/.exec(raw);
    if (def) return { key: `py:${def[1]}`, name: def[1] as string, sig: t.replace(/:\s*$/, "") };
    return null;
  }
  if (lang === "jvm") {
    const type = /^public\s+(?:(?:static|final|abstract|sealed|partial|open|data)\s+)*(?:class|interface|enum|record|struct|object)\s+(\w+)/.exec(t);
    if (type) return { key: `jvm:${type[1]}`, name: type[1] as string, sig: t.replace(/\s*\{\s*$/, "") };
    const method = /^public\s+(?:(?:static|final|abstract|synchronized|override|async|virtual)\s+)*[\w<>[\],.? ]+?\s+(\w+)\s*\(/.exec(t);
    if (method) return { key: `jvm:${method[1]}`, name: method[1] as string, sig: t.replace(/\s*\{\s*$/, "") };
    return null;
  }
  const rs = /^pub(?:\([^)]*\))?\s+(?:(?:async|unsafe|const|extern)\s+)*(fn|struct|enum|trait|type|const|static|mod)\s+(\w+)/.exec(t);
  return rs ? { key: `rs:${rs[2]}`, name: rs[2] as string, sig: t.replace(/\s*\{\s*$/, "") } : null;
}

function exportFindings(net: Net, byPath: Map<string, RiskFile>): Finding[] {
  const out: Finding[] = [];
  const collect = (lines: NetLine[]): Map<string, Array<ExportedSymbol & { path: string }>> => {
    const m = new Map<string, Array<ExportedSymbol & { path: string }>>();
    for (const l of sourceLines(lines)) {
      const lang = langOf(l.path);
      const sym = lang ? exportedSymbol(lang, l.path, l.text) : null;
      if (sym) m.set(sym.key, [...(m.get(sym.key) ?? []), { ...sym, path: l.path }]);
    }
    return m;
  };
  const gone = collect(net.removed);
  const came = collect(net.added);
  const changed: Record<string, string[]> = {};
  const removed: Record<string, string[]> = {};
  for (const [key, was] of gone) {
    const now = came.get(key);
    const first = was[0] as ExportedSymbol & { path: string };
    if (!now) { (removed[first.path] ??= []).push(first.name); continue; }
    if (was.some((w) => !now.some((n) => n.sig === w.sig)) || now.some((n) => !was.some((w) => w.sig === n.sig))) {
      (changed[first.path] ??= []).push(first.name);
    }
  }
  for (const [path, names] of Object.entries(changed)) out.push({ category: "interface", reason: `interface change: exported ${list(names)} has a different signature (${path})` });
  for (const [path, names] of Object.entries(removed)) {
    const file = byPath.get(path);
    out.push({ category: "interface", reason: `interface change: exported ${list(names)} removed (${path}${file?.status === "removed" ? ", file deleted" : ""})` });
  }
  // A new export is a change to what others can use only where others look: a package's entry point.
  const added: Record<string, string[]> = {};
  for (const [key, now] of came) {
    if (gone.has(key)) continue;
    for (const n of now) if (PUBLIC_ENTRY.test(n.path)) (added[n.path] ??= []).push(n.name);
  }
  for (const [path, names] of Object.entries(added)) out.push({ category: "interface", reason: `interface change: new public export ${list(names)} in ${path}` });
  return out;
}

function interfaceFindings(files: RiskFile[], net: Net, touched: Set<string>): Finding[] {
  const out: Finding[] = [];
  const byPath = new Map(files.map((f) => [f.path, f]));
  const add = (reason: string): void => { out.push({ category: "interface", reason }); };

  for (const f of files) {
    const paths = f.previousPath && f.previousPath !== f.path ? [f.path, f.previousPath] : [f.path];
    const moved = f.status === "added" || f.status === "removed" || f.status === "renamed" || f.status === "copied";
    const real = moved || touched.has(f.path);
    if (!real) continue;
    if (paths.some((p) => SCHEMA_FILE.test(p) && !isTest(p))) add(`interface change: an API or data schema definition changed (${f.path})`);
    if (paths.some((p) => MIGRATION_PATH.test(p) && !isDoc(p) && !isTest(p))) add(`interface change: database migration ${f.status === "removed" ? "removed" : "changed"} (${f.path})`);
    else if (paths.some((p) => CONTRACT_DIR.test(p) && isSource(p))) add(`interface change: a wire, event or contract definition changed (${f.path})`);
    if (ENV_EXAMPLE.test(f.path)) add(`interface change: the documented configuration contract changed (${f.path})`);
  }

  const routes: Record<string, string[]> = {};
  const flags: Record<string, string[]> = {};
  const envs: Record<string, string[]> = {};
  const secretEnvs: Record<string, string[]> = {};
  const ddl = new Set<string>();
  for (const l of sourceLines([...net.added, ...net.removed])) {
    for (const [re, name] of ROUTES) { const m = re.exec(l.text); if (m) { (routes[l.path] ??= []).push(name(m)); break; } }
    for (const [re, name] of CLI_FLAGS) { const m = re.exec(l.text); if (m) { (flags[l.path] ??= []).push(name(m)); break; } }
    for (const re of ENV_READS) {
      const m = re.exec(l.text);
      if (m) { const n = m[1] as string; (envs[l.path] ??= []).push(n); if (SECRET_ENV_NAME.test(n)) (secretEnvs[l.path] ??= []).push(n); break; }
    }
    if (DDL.test(l.text) && !MIGRATION_PATH.test(l.path)) ddl.add(l.path);
  }
  for (const [path, names] of Object.entries(routes)) add(`interface change: HTTP route ${list(names)} added, removed or changed (${path})`);
  for (const [path, names] of Object.entries(flags)) add(`interface change: command-line flag ${list(names)} added, removed or changed (${path})`);
  for (const [path, names] of Object.entries(envs)) add(`interface change: configuration read from environment ${list(names)} added, removed or changed (${path})`);
  for (const path of ddl) add(`interface change: database schema statement added, removed or changed (${path})`);
  for (const [path, names] of Object.entries(secretEnvs)) out.push({ category: "security", reason: `security-sensitive code: secret-bearing environment variable ${list(names)} (${path})` });
  out.push(...exportFindings(net, byPath));
  return out;
}

// ------------------------------------------------------------------ architecture changes

const PACKAGE_MARKER = /(^|\/)(package\.json|go\.mod|Cargo\.toml|pyproject\.toml|setup\.py|pom\.xml|build\.gradle(\.kts)?|Chart\.ya?ml|[^/]+\.csproj|mix\.exs|pubspec\.ya?ml|composer\.json|Gemfile)$/i;
const DEPLOYABLE_FILE = /(^|\/)(Dockerfile[^/]*|docker-compose[^/]*\.ya?ml|compose\.ya?ml|Procfile|skaffold\.ya?ml|kustomization\.ya?ml)$/i;
const WORKLOAD_KIND = /^\s*kind:\s*(Deployment|StatefulSet|DaemonSet|CronJob|Job|Service|Ingress|HTTPRoute|Gateway|VirtualService|NetworkPolicy|ClusterRole|ClusterRoleBinding|Role|RoleBinding)\b/;
const TERRAFORM_UNIT = /^\s*(?:resource|module)\s+"([^"]+)"/;
/** Files that state which package may depend on which, or how the workspace is cut. */
const LAYERING_ANY = /(^|\/)(go\.work|pnpm-workspace\.ya?ml|lerna\.json|nx\.json|turbo\.json|rush\.json|\.dependency-cruiser[^/]*|\.importlinter|import-linter[^/]*|WORKSPACE|BUILD(\.bazel)?)$/i;
const TSCONFIG = /(^|\/)tsconfig[^/]*\.json$/i;
const TSCONFIG_GRAPH = /"(paths|references|baseUrl|rootDirs|extends)"\s*:|"path"\s*:\s*"\.|"@[\w/-]+\/?\*?"\s*:\s*\[/;
const ESLINT_CONFIG = /(^|\/)(\.eslintrc[^/]*|eslint\.config\.[cm]?[jt]s)$/i;
const ESLINT_LAYERING = /no-restricted-(imports|paths)|import\/no-|boundaries\/|no-cycle|no-internal-modules/;
const WORKSPACES_LINE = /"workspaces"\s*:|"packages"\s*:/;
/** An entry of a JSON string list: what a workspace glob looks like when the key above it is only context in the diff. */
const STRING_ENTRY = /^\s*"[^"]+"\s*,?\s*$/;
const RELATIVE_IMPORT = /(?:\bfrom|\bimport|\brequire\s*\(|\bimport\s*\()\s*['"`](\.{1,2}\/[^'"`]+)['"`]/;

function resolveRelative(fromPath: string, spec: string): string | null {
  const parts = fromPath.split("/").slice(0, -1);
  for (const seg of spec.split("/")) {
    if (seg === "." || seg === "") continue;
    if (seg === "..") { if (parts.length === 0) return null; parts.pop(); } else parts.push(seg);
  }
  return parts.join("/");
}

function architectureFindings(files: RiskFile[], net: Net): Finding[] {
  const out: Finding[] = [];
  const add = (reason: string): void => { out.push({ category: "architecture", reason }); };

  const moves = new Map<string, number>();
  const crossings = new Set<string>();
  for (const f of files) {
    if (isDoc(f.path) && !PACKAGE_MARKER.test(f.path)) continue;
    const kind = f.status === "added" ? "added" : f.status === "removed" ? "removed" : null;
    if (kind && !isTest(f.path)) {
      if (PACKAGE_MARKER.test(f.path) || /\/__init__\.py$/.test(f.path)) {
        add(`architecture change: a package or module was ${kind} (${f.path})`);
      }
      if (DEPLOYABLE_FILE.test(f.path)) add(`architecture change: a deployable unit was ${kind} (${f.path})`);
    }
    if ((f.status === "renamed" || f.status === "copied") && f.previousPath && f.previousPath !== f.path && !isDoc(f.path) && !isTest(f.path)) {
      const from = f.previousPath.replace(/\/[^/]*$/, "");
      const to = f.path.replace(/\/[^/]*$/, "");
      if (from !== to) moves.set(`${from}/ -> ${to}/`, (moves.get(`${from}/ -> ${to}/`) ?? 0) + 1);
      const a = packageRoot(f.previousPath);
      const b = packageRoot(f.path);
      if (a && b && a !== b) crossings.add(`${a}/ -> ${b}/`);
    }
  }
  for (const [pair, n] of moves) if (n >= 3) add(`architecture change: ${n} files moved ${pair}`);
  for (const pair of crossings) add(`architecture change: code moved between packages ${pair}`);

  const seen = new Set<string>();
  const imports = new Set<string>();
  for (const l of sourceLines(net.added)) {
    if (langOf(l.path) === "js") {
      const m = RELATIVE_IMPORT.exec(l.text);
      const target = m ? resolveRelative(l.path, m[1] as string) : null;
      const from = packageRoot(l.path);
      const to = target === null ? "" : packageRoot(target);
      if (m && target !== null && from && to && from !== to && !target.startsWith(`${from}/`)) imports.add(`${l.path} (${m[1]})`);
    }
    const unit = TERRAFORM_UNIT.exec(l.text);
    if (unit && /\.tf$/i.test(l.path)) add(`architecture change: infrastructure resource ${unit[1]} added (${l.path})`);
    const kind = WORKLOAD_KIND.exec(l.text);
    if (kind && !seen.has(`${kind[1]}:${l.path}`)) { seen.add(`${kind[1]}:${l.path}`); add(`architecture change: Kubernetes ${kind[1]} added (${l.path})`); }
  }
  for (const l of sourceLines(net.removed)) {
    const unit = TERRAFORM_UNIT.exec(l.text);
    if (unit && /\.tf$/i.test(l.path)) add(`architecture change: infrastructure resource ${unit[1]} removed (${l.path})`);
    const kind = WORKLOAD_KIND.exec(l.text);
    if (kind && !seen.has(`${kind[1]}:${l.path}`)) { seen.add(`${kind[1]}:${l.path}`); add(`architecture change: Kubernetes ${kind[1]} removed (${l.path})`); }
  }
  for (const imp of imports) add(`architecture change: a new import reaches into another package: ${imp}`);

  const layering = new Set<string>();
  const byPath = new Map(files.map((f) => [f.path, f]));
  for (const l of [...net.added, ...net.removed]) {
    if (isTest(l.path)) continue;
    if (LAYERING_ANY.test(l.path)
      || (TSCONFIG.test(l.path) && TSCONFIG_GRAPH.test(l.text))
      || (ESLINT_CONFIG.test(l.path) && ESLINT_LAYERING.test(l.text))
      || (/(^|\/)package\.json$/i.test(l.path) && (WORKSPACES_LINE.test(l.text) || (STRING_ENTRY.test(l.text) && /"workspaces"\s*:/.test(byPath.get(l.path)?.patch ?? ""))))) layering.add(l.path);
  }
  for (const path of layering) add(`architecture change: workspace, layering or module-boundary rules changed (${path})`);

  // Breadth: a change that spans many packages changes how they relate whatever each edit says.
  const roots = new Set(files.filter((f) => isSource(f.path)).map((f) => packageRoot(f.path)).filter(Boolean));
  if (roots.size >= 5) out.push({ category: "size_breadth", reason: `broad change: it spans ${roots.size} packages` });
  return out;
}

// ------------------------------------------------------------------ security-sensitive code

/** Code that decides who may do what, or protects what is kept secret. A match is a reason to look, not a finding. */
const SECURITY_CODE: Array<[RegExp, string]> = [
  [/(?:^|[^a-z])(?:jwt|jws|jwk|oauth2?|oidc|saml|openid|bearer)(?:[^a-z]|$)|jsonwebtoken|verifyJwt/i, "token or sign-in handling"],
  [/\b(?:createHash|createHmac|createCipher(?:iv)?|createDecipher(?:iv)?|createSign|createVerify|randomBytes|randomFillSync|generateKeyPair(?:Sync)?|timingSafeEqual|constantTimeEquals|scrypt|pbkdf2|bcrypt|argon2|hkdf|webcrypto)\b|\bcrypto\.|\bhashlib\.|\bhmac\.|\bcrypto\/(?:aes|cipher|hmac|rand|rsa|sha256|tls|x509)\b|\b(?:AES|RSA|ECDSA|Ed25519|ChaCha20|HMAC)\b/, "cryptography"],
  [/\b(?:isAdmin|isSystemAdmin|hasRole|hasPermission|checkPermission|authori[sz]\w*|authenticat\w*|requireAuth\w*|requireRole|rbac|acl|ClusterRole(?:Binding)?|RoleBinding|allowedRoles|permissions?|privileges?|isAnonymous\w*|ANONYMOUS_\w+|skipAuth|noAuth)\b/i, "authorization or permission logic"],
  [/\b(?:chmod|chown|setuid|setgid|sudo|CAP_[A-Z_]+|seccomp|apparmor|privileged|allowPrivilegeEscalation|runAsRoot|runAsUser|hostPID|hostNetwork|hostPath|securityContext|NET_ADMIN|SYS_ADMIN)\b/, "privilege or isolation settings"],
  [/\b(?:secretKeyRef|secretRef|SecretStore|ExternalSecret|getSecret|readSecret|decrypt\w*|encrypt\w*|passw(?:or)?d|passphrase|api[_-]?key|private[_-]?key|client[_-]?secret|access[_-]?key|credentials?)\b/i, "secret or credential handling"],
  [/\b(?:cors|csrf|xsrf|helmet|trustProxy)\b|Access-Control-Allow-\w+|Content-Security-Policy|\bSameSite\b|\bHttpOnly\b|X-Forwarded-For/i, "web security settings"],
  [/(?<![.\w])(?:exec|execSync|execFile|spawn|spawnSync)\(|child_process|\bos\.system\(|\bsubprocess\.|shell\s*:\s*true|(?<![.\w])eval\(|new Function\(|innerHTML|dangerouslySetInnerHTML|pickle\.loads|\bvm\.run\w+/, "code execution or injection surface"],
];

function securityFindings(net: Net): Finding[] {
  const seen = new Set<string>();
  const out: Finding[] = [];
  for (const l of sourceLines([...net.added, ...net.removed])) {
    for (const [re, what] of SECURITY_CODE) {
      if (!re.test(l.text)) continue;
      const key = `${what}:${l.path}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ category: "security", reason: `security-sensitive code: ${what} changed (${l.path})` });
    }
  }
  return out;
}

/** Everything the content of the change says, over the files GitHub described. */
export function contentFindings(files: RiskFile[]): { findings: Finding[]; touched: Set<string>; net: Net } {
  const net = netChange(files);
  const touched = touchedPaths(net);
  // Fails closed: what cannot be read in a reasonable length is not known to be harmless.
  const unreadable: Finding[] = [...net.unreadable].map((path) => ({ category: "integrity", reason: `a changed line is too long to read (minified or generated code): ${path}` }));
  return {
    findings: [...unreadable, ...architectureFindings(files, net), ...interfaceFindings(files, net, touched), ...securityFindings(net)],
    touched,
    net,
  };
}
