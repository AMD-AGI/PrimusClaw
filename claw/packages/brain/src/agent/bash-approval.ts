// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Configurable "hold this bash command for a person" policy.
 *
 * Writes made through the bash tool (an HTTP client, a helper script) do not
 * pass through an MCP server, so `requires_approval` (approval-policy.ts)
 * cannot see them. This policy matches the command line itself, and a matching
 * call goes through the same HitlController gate: a permissionRequest, a
 * decision, denied when nobody answers, and no remember / always_allow.
 *
 * LIMITS, stated plainly. This is a guard against ACCIDENTAL writes, not a
 * sandbox boundary. It reads shell text; a determined model can defeat it
 * (eval, base64 pipes, a script written to a file and run, variable-built
 * URLs, an HTTP client the rules do not know). Server-side authorization stays
 * the real control; this only makes the common honest case ask first.
 *
 * Configuration: a list of rules, from a plugin tool's `config.bash_approval`
 * (or `bashApproval`) and/or the deployment's BASH_APPROVAL_RULES (JSON). Each
 * rule is an object:
 *
 *   label        required, shown to the user and logged
 *   regex        tested against the whole command line
 *   flags        optional regex flags, any of "i" "m" "s"
 *   program      program name (or list); a trailing `*` matches a prefix
 *   args_regex   tested against the arguments of one simple command
 *   http         { methods?: ["POST", ...], url_prefix?: "host/path",
 *                url_regex?: "..." } for curl / wget; the method is -X /
 *                --method, else implied by a body flag (POST), else GET; the
 *                scheme is ignored in url_prefix; url_regex is tested against
 *                the URL as written, so it also sees `$BASE/path`
 *
 * All fields present in a rule must match (`program`, `args_regex`, `http`
 * within the same simple command). A rule with none of regex / program /
 * args_regex / http, an unknown key, a bad type or an unparsable regex is
 * malformed. Malformed configuration fails closed: every bash command is held,
 * and a warning is logged. `false` / null / absent mean no rule.
 */
import pino from "pino";

const logger = pino({ name: "bash-approval" });

export interface BashApprovalPolicy {
  /** True when at least one rule (or a malformed config) is in force. */
  readonly active: boolean;
  /** The label of the first rule the command matches, or null to run it. */
  check(command: unknown): string | null;
}

/** Longer than any command a person would approve by reading; held unread. */
const MAX_COMMAND_CHARS = 100_000;
const MAX_SHELL_DEPTH = 3;
export const MALFORMED_LABEL = "bash approval rules are malformed; every bash command is held";

interface Segment { program: string; argv: string[] }
type RuleFn = (command: string, segments: Segment[]) => boolean;
interface Rule { label: string; test: RuleFn }

const RULE_KEYS = new Set(["label", "regex", "flags", "program", "args_regex", "http"]);
const WRAPPERS = new Set(["env", "sudo", "doas", "time", "nohup", "command", "exec", "nice", "stdbuf", "setsid"]);
/** Wrapper flags that take a value, so `sudo -u x curl` still finds curl. */
const WRAPPER_VALUE_FLAGS = new Set(["-u", "-g", "-C", "-h", "-p", "-r", "-t", "-U", "-n", "-S", "-i", "-o", "-e", "-c", "-s"]);
const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh"]);

/** Split shell text into simple commands, each as program + argv. */
export function parseSegments(text: string, depth = 0): Segment[] {
  const segments: Segment[] = [];
  let tokens: string[] = [];
  let cur = "";
  let has = false;
  const endToken = () => { if (has) tokens.push(cur); cur = ""; has = false; };
  const endSegment = () => {
    endToken();
    if (tokens.length) {
      const seg = toSegment(tokens);
      if (seg) {
        segments.push(seg);
        if (depth < MAX_SHELL_DEPTH && SHELLS.has(seg.program)) {
          const i = seg.argv.findIndex((a) => /^-[a-z]*c[a-z]*$/.test(a));
          if (i >= 0 && seg.argv[i + 1] !== undefined) segments.push(...parseSegments(seg.argv[i + 1], depth + 1));
        }
      }
    }
    tokens = [];
  };
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === "\\") { if (i + 1 < text.length) { cur += text[++i]; has = true; } continue; }
    if (c === "'") {
      const j = text.indexOf("'", i + 1);
      const end = j < 0 ? text.length : j;
      cur += text.slice(i + 1, end); has = true; i = end; continue;
    }
    if (c === '"') {
      i++;
      for (; i < text.length && text[i] !== '"'; i++) {
        if (text[i] === "\\" && i + 1 < text.length && /["\\$`\n]/.test(text[i + 1])) i++;
        cur += text[i];
      }
      has = true; continue;
    }
    if (c === ";" || c === "&" || c === "|" || c === "\n" || c === "(" || c === ")" || c === "`") { endSegment(); continue; }
    if (c === " " || c === "\t" || c === "\r") { endToken(); continue; }
    cur += c; has = true;
  }
  endSegment();
  return segments;
}

function toSegment(tokens: string[]): Segment | null {
  let i = 0;
  for (; i < tokens.length; i++) {
    const t = tokens[i];
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(t)) continue;
    if (WRAPPERS.has(t.split("/").pop()!)) {
      const w = t.split("/").pop()!;
      while (i + 1 < tokens.length && tokens[i + 1].startsWith("-")) {
        i++;
        // env -i / nice -n 5 etc: only sudo-family and nice take a value after a flag.
        if ((w === "sudo" || w === "doas" || w === "nice" || w === "stdbuf") && WRAPPER_VALUE_FLAGS.has(tokens[i]) && i + 1 < tokens.length) i++;
      }
      continue;
    }
    break;
  }
  if (i >= tokens.length) return null;
  return { program: tokens[i].split("/").pop() ?? tokens[i], argv: tokens.slice(i + 1) };
}

const CURL_VALUE_FLAGS = new Set([
  "-H", "--header", "-d", "--data", "--data-raw", "--data-binary", "--data-ascii", "--data-urlencode",
  "-F", "--form", "--form-string", "-u", "--user", "-o", "--output", "-A", "--user-agent", "-e", "--referer",
  "-b", "--cookie", "-c", "--cookie-jar", "-m", "--max-time", "-x", "--proxy", "-T", "--upload-file",
  "-w", "--write-out", "--connect-timeout", "--retry", "--cacert", "--cert", "--key", "--resolve", "--json",
  "-K", "--config", "-X", "--request", "--url", "-E", "--proxy-user", "-r", "--range", "-z", "--time-cond",
]);
const CURL_BODY_FLAGS = /^(-d|--data(-raw|-binary|-ascii|-urlencode)?|-F|--form(-string)?|-T|--upload-file|--json)$/;

interface Http { method: string; urls: string[] }

function curlInfo(argv: string[]): Http {
  let method: string | null = null;
  let body = false, get = false, head = false;
  const urls: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--") { urls.push(...argv.slice(i + 1)); break; }
    if (a === "-X" || a === "--request") { method = (argv[++i] ?? "").toUpperCase(); continue; }
    if (a.startsWith("--request=")) { method = a.slice(10).toUpperCase(); continue; }
    if (/^-X./.test(a)) { method = a.slice(2).toUpperCase(); continue; }
    if (a === "--url") { if (argv[i + 1]) urls.push(argv[++i]); continue; }
    if (a.startsWith("--url=")) { urls.push(a.slice(6)); continue; }
    if (a === "-G" || a === "--get") { get = true; continue; }
    if (a === "-I" || a === "--head") { head = true; continue; }
    if (CURL_BODY_FLAGS.test(a)) { body = true; i++; continue; }
    if (/^-[dFT]./.test(a) || /^--(data|form|json|upload-file)[^=]*=/.test(a)) { body = true; continue; }
    if (CURL_VALUE_FLAGS.has(a)) { i++; continue; }
    if (a.startsWith("-")) continue;
    urls.push(a);
  }
  return { method: method || (head ? "HEAD" : body && !get ? "POST" : "GET"), urls };
}

function wgetInfo(argv: string[]): Http {
  let method: string | null = null;
  let body = false;
  const urls: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--method") { method = (argv[++i] ?? "").toUpperCase(); continue; }
    if (a.startsWith("--method=")) { method = a.slice(9).toUpperCase(); continue; }
    if (/^--(post|body)-(data|file)(=|$)/.test(a)) { body = true; if (!a.includes("=")) i++; continue; }
    if (a.startsWith("-")) continue;
    urls.push(a);
  }
  return { method: method || (body ? "POST" : "GET"), urls };
}

function httpInfo(seg: Segment): Http | null {
  if (seg.program === "curl") return curlInfo(seg.argv);
  if (seg.program === "wget") return wgetInfo(seg.argv);
  return null;
}

const bare = (u: string) => u.replace(/^[a-z][a-z0-9+.-]*:\/\//i, "").toLowerCase();

function fail(msg: string): never { throw new Error(msg); }

function compileRegex(v: unknown, flags: string, field: string): RegExp {
  if (typeof v !== "string" || !v) fail(`${field} must be a non-empty string`);
  return new RegExp(v, flags);
}

function stringList(v: unknown, field: string): string[] {
  const list = typeof v === "string" ? [v] : v;
  if (!Array.isArray(list) || !list.length || list.some((s) => typeof s !== "string" || !s.trim())) {
    fail(`${field} must be a non-empty string or list of non-empty strings`);
  }
  return (list as string[]).map((s) => s.trim());
}

/** Throws on anything it cannot read; the caller turns that into hold-all. */
function compileRule(raw: unknown): Rule {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) fail("rule must be an object");
  const r = raw as Record<string, unknown>;
  for (const k of Object.keys(r)) if (!RULE_KEYS.has(k)) fail(`unknown key ${k}`);
  if (typeof r.label !== "string" || !r.label.trim()) fail("label is required");
  const label = r.label.trim();
  const flags = r.flags === undefined ? "" : typeof r.flags === "string" && /^[ims]*$/.test(r.flags) ? r.flags : fail("flags");
  if (r.regex === undefined && r.program === undefined && r.args_regex === undefined && r.http === undefined) {
    fail("rule needs at least one of regex, program, args_regex, http");
  }
  const full = r.regex === undefined ? null : compileRegex(r.regex, flags, "regex");
  const args = r.args_regex === undefined ? null : compileRegex(r.args_regex, flags, "args_regex");
  const programs = r.program === undefined ? null : stringList(r.program, "program");
  let methods: string[] | null = null;
  let prefixes: string[] | null = null;
  let urlRe: RegExp | null = null;
  const hasHttp = r.http !== undefined;
  if (hasHttp) {
    const h = r.http;
    if (!h || typeof h !== "object" || Array.isArray(h)) fail("http must be an object");
    const ho = h as Record<string, unknown>;
    for (const k of Object.keys(ho)) if (k !== "methods" && k !== "url_prefix" && k !== "url_regex") fail(`unknown http key ${k}`);
    if (ho.methods === undefined && ho.url_prefix === undefined && ho.url_regex === undefined) fail("http needs methods, url_prefix or url_regex");
    if (ho.url_regex !== undefined) urlRe = compileRegex(ho.url_regex, flags, "http.url_regex");
    if (ho.methods !== undefined) methods = stringList(ho.methods, "http.methods").map((m) => m.toUpperCase());
    if (ho.url_prefix !== undefined) prefixes = stringList(ho.url_prefix, "http.url_prefix").map(bare);
  }
  const progMatch = (p: string) => !programs || programs.some((x) => (x.endsWith("*") ? p.startsWith(x.slice(0, -1)) : p === x));
  const segmentLevel = programs || args || hasHttp;
  const test: RuleFn = (command, segments) => {
    if (full && !full.test(command)) return false;
    if (!segmentLevel) return true;
    return segments.some((seg) => {
      if (!progMatch(seg.program)) return false;
      if (args && !args.test(seg.argv.join(" "))) return false;
      if (hasHttp) {
        const info = httpInfo(seg);
        if (!info) return false;
        if (methods && !methods.includes(info.method)) return false;
        if (prefixes && !info.urls.some((u) => prefixes!.some((p) => bare(u).startsWith(p)))) return false;
        if (urlRe && !info.urls.some((u) => urlRe!.test(u))) return false;
      }
      return true;
    });
  };
  return { label, test };
}

export interface BashApprovalSource {
  /** Where the value came from, for the log only. */
  source: string;
  value: unknown;
}

/**
 * Build the policy from every configured source. A source that is absent
 * (undefined / null / false) contributes nothing; one that is present but not
 * a non-empty list of well-formed rules holds every bash command.
 */
export function bashApprovalPolicyFrom(sources: BashApprovalSource[]): BashApprovalPolicy {
  const rules: Rule[] = [];
  let holdAll = false;
  for (const { source, value } of sources) {
    if (value === undefined || value === null || value === false) continue;
    if (!Array.isArray(value) || value.length === 0) {
      logger.warn({ source, valueType: Array.isArray(value) ? "empty array" : typeof value },
        "bash_approval.invalid_holding_all_commands");
      holdAll = true;
      continue;
    }
    value.forEach((raw, index) => {
      try {
        rules.push(compileRule(raw));
      } catch (err) {
        logger.warn({ source, index, reason: (err as Error).message }, "bash_approval.invalid_holding_all_commands");
        holdAll = true;
      }
    });
  }
  return {
    active: holdAll || rules.length > 0,
    check(command: unknown): string | null {
      if (holdAll) return MALFORMED_LABEL;
      if (typeof command !== "string" || command.length > MAX_COMMAND_CHARS) return "unreadable bash command";
      const segments = parseSegments(command);
      for (const rule of rules) if (rule.test(command, segments)) return rule.label;
      return null;
    },
  };
}

/** Env form: "" is unset; JSON that does not parse is malformed (held), not ignored. */
export function bashApprovalFromEnvValue(raw: string | undefined): unknown {
  const text = raw?.trim();
  if (!text) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

/** Both spellings are read, so one cannot hide the other. */
export function bashApprovalFromToolConfig(cfg: unknown): unknown[] {
  if (!cfg || typeof cfg !== "object") return [];
  const c = cfg as Record<string, unknown>;
  return ["bash_approval", "bashApproval"].map((k) => c[k]).filter((v) => v !== undefined && v !== null);
}
