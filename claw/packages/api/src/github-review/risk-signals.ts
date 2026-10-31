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
 *  - For interfaces and architecture it reads the NET change. A line that one file loses and
 *    another file (or the same file, reindented) gains cancels out, so a pure refactor, a move of
 *    code between files and a reformat contribute nothing, while a changed or removed signature
 *    still shows. Blank lines and comment lines are not content.
 *  - For security-sensitive code, schemas, migrations, layering rules and the files the path rules
 *    watch it reads the RAW change, with nothing cancelled: a guard that is removed in one place
 *    and an identical line added in another is indistinguishable from a move, and a removed check
 *    must not be able to hide behind a copy of itself. Moving code that carries such a line is a
 *    change to security-sensitive code, and is held.
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
  /** Every meaningful changed line, nothing cancelled: what the rules that must not be argued out of a change read. */
  raw: { added: NetLine[]; removed: NetLine[] };
  /** Files with a changed line longer than {@link MAX_LINE_CHARS}: minified or generated code the patterns below do not read. */
  unreadable: Set<string>;
}

/** The longest line the patterns read. A longer one is cut for them, and said so, so a very long line is a reason of its own. */
export const MAX_LINE_CHARS = 4000;

/**
 * The most the content half reads of one change: this many changed lines and this many characters of them. A pull request that adds
 * more is not read past the point the budget runs out, and that is a reason of its own (it is also large, which holds it): what a
 * person outside the organisation writes must cost the shared API a bounded amount, however many lines it sends.
 */
export const MAX_READ_LINES = 20_000;
export const MAX_READ_CHARS = 2_000_000;

/** A changed line as the patterns read it: cut at {@link MAX_LINE_CHARS}, which bounds what any pattern can cost. */
export const clipLine = (text: string): string => (text.length <= MAX_LINE_CHARS ? text : text.slice(0, MAX_LINE_CHARS));

/** The changed lines of every file as the patterns read them, read once: cut at {@link MAX_LINE_CHARS} and within the budget above. */
export interface ChangeText {
  lines: Map<RiskFile, { added: string[]; removed: string[] }>;
  /** Files with a changed line longer than {@link MAX_LINE_CHARS}: minified or generated code the patterns do not read in full. */
  unreadable: Set<string>;
  /** The budget ran out: the lines after that point were not read. */
  truncated: boolean;
}

export function readChange(files: RiskFile[]): ChangeText {
  const lines = new Map<RiskFile, { added: string[]; removed: string[] }>();
  const unreadable = new Set<string>();
  let count = 0;
  let chars = 0;
  let truncated = false;
  const take = (path: string, raw: string[]): string[] => {
    const out: string[] = [];
    for (const line of raw) {
      if (count >= MAX_READ_LINES || chars >= MAX_READ_CHARS) { truncated = true; break; }
      if (line.length > MAX_LINE_CHARS) unreadable.add(path);
      const text = clipLine(line);
      count += 1;
      chars += text.length;
      out.push(text);
    }
    return out;
  };
  for (const f of files) lines.set(f, { added: take(f.path, addedLines(f.patch)), removed: take(f.path, removedLines(f.patch)) });
  return { lines, unreadable, truncated };
}

const norm = (l: string): string => l.trim().replace(/\s+/g, " ");

/**
 * What a comment looks like in a file, by the file's name: only the markers its language has. A line that starts like a comment
 * in some other language is code here (`#allowed() {` is a JavaScript private member, an empty block comment followed by a call is a
 * call, `* b;` ends a multiplication), and a file of a kind that is not listed has no comments at all, so nothing in it is dropped. A line is a
 * comment only when all of it is: after a block comment that closes on the line, a statement is still a statement. The inside
 * of a block comment is not tracked (a lone `/*` inside a string would hide the code after it), so a line in the middle of a
 * comment block is read like any other line.
 */
interface CommentSyntax { line: readonly string[]; block: boolean; html: boolean }
const NO_COMMENTS: CommentSyntax = { line: [], block: false, html: false };
const SLASH: CommentSyntax = { line: ["//"], block: true, html: false };
const HASH: CommentSyntax = { line: ["#"], block: false, html: false };
const SYNTAX_BY_EXTENSION = new Map<string, CommentSyntax>();
const syntaxFor = (syntax: CommentSyntax, ...extensions: string[]): void => { for (const e of extensions) SYNTAX_BY_EXTENSION.set(e, syntax); };
syntaxFor(SLASH, "js", "jsx", "mjs", "cjs", "ts", "tsx", "mts", "cts", "go", "java", "kt", "kts", "scala", "c", "h", "cc", "cpp", "cxx", "hpp", "hh",
  "cu", "cuh", "cs", "rs", "swift", "dart", "groovy", "gradle", "proto", "thrift", "jsonc", "json5", "m", "mm", "sol");
syntaxFor({ line: ["//", "#"], block: true, html: false }, "php");
syntaxFor(HASH, "py", "pyi", "sh", "bash", "zsh", "ksh", "rb", "pl", "pm", "r", "yaml", "yml", "toml", "tf", "tfvars", "hcl", "conf", "cfg", "ini",
  "properties", "ps1", "nix", "ex", "exs", "mk", "cmake", "bzl", "bazel", "dockerfile", "gitignore", "dockerignore", "graphql", "graphqls", "gql");
syntaxFor({ line: ["--"], block: true, html: false }, "sql", "psql");
syntaxFor({ line: ["--"], block: false, html: false }, "lua", "hs");
syntaxFor({ line: [], block: false, html: true }, "html", "htm", "xhtml", "xml", "svg", "vue");
const HASH_FILES = /^(?:Dockerfile.*|(?:GNU)?[Mm]akefile|\.env(?:\..*)?|BUILD|WORKSPACE|Procfile|\.gitattributes|\.npmrc)$/;
const SLASH_FILES = /^(?:Jenkinsfile.*|go\.work)$/;
function commentSyntax(path: string): CommentSyntax {
  const name = path.slice(path.lastIndexOf("/") + 1);
  if (HASH_FILES.test(name)) return HASH;
  if (SLASH_FILES.test(name)) return SLASH;
  const dot = name.lastIndexOf(".");
  return (dot > 0 ? SYNTAX_BY_EXTENSION.get(name.slice(dot + 1).toLowerCase()) : undefined) ?? NO_COMMENTS;
}

/** A line marker that opens a comment at `i`: `#` is not a Rust attribute (`#[`) or a shebang (`#!`), and `--` needs a space or the end after it. */
function lineMarkerAt(marker: string, n: string, i: number): boolean {
  if (!n.startsWith(marker, i)) return false;
  const next = n[i + marker.length];
  if (marker === "#") return next !== "[" && next !== "!";
  if (marker === "--") return next === undefined || next === " ";
  return true;
}

/** Whether every character of the (normalised, non-blank) line is comment. Linear: it only moves forward over comments it recognises. */
function commentOnly(n: string, syntax: CommentSyntax): boolean {
  let i = 0;
  while (i < n.length) {
    if (n.charCodeAt(i) === 32) { i += 1; continue; }
    if (syntax.block && n.startsWith("/*", i)) {
      const end = n.indexOf("*/", i + 2);
      if (end < 0) return true; // an opening line: comment to its end, and the lines inside it are read as lines
      i = end + 2;
      continue;
    }
    if (syntax.html && n.startsWith("<!--", i)) {
      const end = n.indexOf("-->", i + 4);
      if (end < 0) return false;
      i = end + 3;
      continue;
    }
    return syntax.line.some((m) => lineMarkerAt(m, n, i));
  }
  return true;
}

/**
 * A line that is shaped like a comment and is read by a tool: it changes what happens, so it is not a comment. A Dockerfile parser
 * directive can name the frontend that runs the build, a migration tool reads its own `-- +goose` and `-- migrate:` lines, the Go
 * toolchain runs `//go:generate` and obeys `//go:build` and `//go:embed`, a code generator turns `// +kubebuilder:rbac` into
 * permissions, and a comment can switch a security scanner off for the line it sits on.
 */
const DIRECTIVE = /^(?:#\s*(?:syntax|escape|check)\s*=|(?:--|#|\/\/)\s*\+?(?:goose|migrate)\b|--\s*(?:migrate:|liquibase|changeset|atlas:|flyway)|\/\/\s*(?:go:|\+build|\+kubebuilder|\+k8s|\+genclient|nolint)|\/[/*]\s*(?:@ts-|eslint-|istanbul|webpack)|.*(?:#nosec|\bnosec\b|checkov:skip|trivy:ignore|NOSONAR|pragma:\s*allowlist|\bnoqa\b|lgtm\[|codeql\[))/i;
/** A line that says something: not blank and not only a comment of its file's language (a comment a tool reads is not only a comment). */
const meaningfulLine = (l: string, path = ""): boolean => {
  const n = norm(l);
  if (n === "") return false;
  return !commentOnly(n, commentSyntax(path)) || DIRECTIVE.test(n);
};

/**
 * The lines the change really adds and really removes: a line that is removed in one place and added in
 * another (a move, a reindent) is in neither list.
 */
export function netChange(files: RiskFile[], read: ChangeText): Net {
  const lost = new Map<string, number>();
  const removedAll: NetLine[] = [];
  const addedAll: NetLine[] = [];
  for (const f of files) {
    const lines = read.lines.get(f);
    for (const text of lines?.removed ?? []) {
      if (!meaningfulLine(text, f.path)) continue;
      removedAll.push({ path: f.path, text });
      lost.set(norm(text), (lost.get(norm(text)) ?? 0) + 1);
    }
    for (const text of lines?.added ?? []) {
      if (meaningfulLine(text, f.path)) addedAll.push({ path: f.path, text });
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
  return { added, removed, raw: { added: addedAll, removed: removedAll }, unreadable: read.unreadable };
}

/** The paths that have at least one meaningful changed line, whether or not it appears elsewhere: a comment is not a change, a moved line is. */
export function touchedPaths(net: Net): Set<string> {
  return new Set([...net.raw.added, ...net.raw.removed].map((l) => l.path));
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

/*
 * The patterns below read a line that a stranger wrote, in the API's own process, so none of them may cost more than the line is long.
 * Two things keep them to that. The line is normalised first (runs of whitespace are one space, see `norm`), so a pattern never has two
 * optional runs of whitespace next to each other to divide a long run between; and a part of a pattern that can match what the part
 * next to it matches (a word followed by an optional word, a lazy run followed by a space) is split with plain string code instead.
 * A pattern that backtracks super-linearly on a 4000-character line is a defect: test/github-review-redos.test.ts times every
 * language on adversarial lines.
 */

/** What the signature is, without the body that follows it and, for a constant, without the value that initialises it. `n` is normalised. */
function jsSignature(n: string): string {
  const t = n.replace(/ ?\{$/, "").replace(/;$/, "");
  const decl = /^(export (?:declare )?(?:default )?(?:const|let|var) [^=]+?) ?= ?(.*)$/.exec(t);
  if (!decl) return t;
  // A function-valued constant is its parameters: keep them, drop the body.
  const fn = /^((?:async ?)?(?:<[^>]*> ?)?(?:\([^)]*\)|[\w$]+) ?(?:: ?[^=]+?)? ?=>)/.exec(decl[2] as string);
  return fn ? `${decl[1]} = ${fn[1]}` : (decl[1] as string);
}

/** `func (r *T[K]) Name(` or `func Name(`: the receiver's type, if there is one, and the name. Split in two so that no pattern has to divide the receiver's words. */
function goFunction(n: string): { recv: string | null; name: string } | null {
  const fn = /^func (?:\(([^)]*)\) ?)?([A-Z]\w*) ?[[(]/.exec(n);
  if (!fn) return null;
  if (fn[1] === undefined) return { recv: null, name: fn[2] as string };
  const recv = /^(?:\w+(?: |(?=\*)))?\*? ?(\w+)(?:\[[^\]]*\])? ?$/.exec(fn[1]);
  return recv ? { recv: recv[1] as string, name: fn[2] as string } : null;
}

/** `public [modifiers] ReturnType name(`: the method's name. `n` is normalised; the first `(` ends the declaration part, which holds no `(` of its own. */
function jvmMethodName(n: string): string | null {
  if (!n.startsWith("public ")) return null;
  const open = n.indexOf("(");
  if (open < 0) return null;
  const left = n.slice(7, open).trimEnd();
  const space = left.lastIndexOf(" ");
  if (space < 0) return null; // a return type and a name are both needed
  const name = left.slice(space + 1);
  // What stands before the name: modifiers and the return type, in the characters a type is written with.
  return /^\w+$/.test(name) && /^[\w<>[\],.? ]+$/.test(left.slice(0, space)) ? name : null;
}

function exportedSymbol(lang: Lang, path: string, raw: string): ExportedSymbol | null {
  const t = norm(raw);
  // Go and Python declare at column 0 only: an indented line is a nested one.
  const top = !/^\s/.test(raw);
  if (lang === "js") {
    const m = /^export (?:declare )?(?:default )?(?:abstract )?(?:async )?(function ?\*?|class|interface|type|enum|const|let|var|namespace) ?([A-Za-z_$][\w$]*)?/.exec(t);
    if (m) { const name = m[2] ?? "default"; return { key: name === "default" ? `${path}:default` : `js:${name}`, name, sig: jsSignature(t) }; }
    const names = /^export ?(?:type ?)?\{([^}]*)\}/.exec(t);
    if (names) return { key: `${path}:{}`, name: norm(names[1] as string), sig: t };
    const star = /^export ?\*(?: ?as \w+)? ?from ?['"]([^'"]+)['"]/.exec(t);
    if (star) return { key: `${path}:*${star[1]}`, name: `* from ${star[1]}`, sig: t };
    if (/^export default\b/.test(t)) return { key: `${path}:default`, name: "default", sig: jsSignature(t) };
    return null;
  }
  if (lang === "go") {
    if (!top) return null;
    const fn = goFunction(t);
    if (fn) { const name = fn.recv ? `${fn.recv}.${fn.name}` : fn.name; return { key: `go:${name}`, name, sig: t.replace(/ ?\{$/, "") }; }
    const ty = /^(?:type|var|const) ([A-Z]\w*)\b/.exec(t);
    if (ty) return { key: `go:${ty[1]}`, name: ty[1] as string, sig: t.replace(/ ?\{$/, "") };
    return null;
  }
  if (lang === "py") {
    // Top level only (column 0) and not private.
    const def = top ? /^(?:async )?(?:def|class) ([A-Za-z]\w*)/.exec(t) : null;
    if (def) return { key: `py:${def[1]}`, name: def[1] as string, sig: t.replace(/:$/, "") };
    return null;
  }
  if (lang === "jvm") {
    const type = /^public (?:(?:static|final|abstract|sealed|partial|open|data) )*(?:class|interface|enum|record|struct|object) (\w+)/.exec(t);
    if (type) return { key: `jvm:${type[1]}`, name: type[1] as string, sig: t.replace(/ ?\{$/, "") };
    const method = jvmMethodName(t);
    if (method) return { key: `jvm:${method}`, name: method, sig: t.replace(/ ?\{$/, "") };
    return null;
  }
  const rs = /^pub(?:\([^)]*\))? (?:(?:async|unsafe|const|extern) )*(fn|struct|enum|trait|type|const|static|mod) (\w+)/.exec(t);
  return rs ? { key: `rs:${rs[2]}`, name: rs[2] as string, sig: t.replace(/ ?\{$/, "") } : null;
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
  for (const l of [...net.raw.added, ...net.raw.removed]) {
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
  [/(?<![.\w])(?:exec|execSync|execFile|spawn|spawnSync)\(|child_process|\bos\.system\(|\bsubprocess\.|shell\s*:\s*true|(?<![.\w])eval\(|new Function\(|innerHTML|dangerouslySetInnerHTML|pickle\.loads|\bvm\.run\w+|\/\/\s*go:generate\b/, "code execution or injection surface"],
  [/#nosec|\bnosec\b|checkov:skip|trivy:ignore|NOSONAR|pragma:\s*allowlist|nolint:[^\n]*gosec|noqa:\s*S\d|lgtm\[|codeql\[|eslint-disable[^\n]*security/i, "a security check suppressed"],
];

function securityFindings(net: Net): Finding[] {
  const seen = new Set<string>();
  const out: Finding[] = [];
  // Raw, not net: see the header. Nothing a change adds elsewhere cancels a security-sensitive line it removes.
  for (const l of sourceLines([...net.raw.added, ...net.raw.removed])) {
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
export function contentFindings(files: RiskFile[], read: ChangeText = readChange(files)): { findings: Finding[]; touched: Set<string>; net: Net } {
  const net = netChange(files, read);
  const touched = touchedPaths(net);
  // Fails closed: what cannot be read in a reasonable length is not known to be harmless.
  const unreadable: Finding[] = [...net.unreadable].map((path) => ({ category: "integrity", reason: `a changed line is too long to read (minified or generated code): ${path}` }));
  return {
    findings: [...unreadable, ...architectureFindings(files, net), ...interfaceFindings(files, net, touched), ...securityFindings(net)],
    touched,
    net,
  };
}
