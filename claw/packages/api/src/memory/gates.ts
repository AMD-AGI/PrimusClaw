// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The checks a memory write passes before anything is stored. Pure functions: the service decides what to
 * do with an answer, these only give it.
 */

export const MEMORY_TYPES = ["user", "feedback", "project", "reference"] as const;
export type MemoryType = (typeof MEMORY_TYPES)[number];

export const TITLE_MAX = 60;
export const BODY_MAX = 500;
export const NOTE_MAX = 300;
/** Characters a quote keeps after normalisation. "记住" or "ok" alone proves nothing about what to store. */
export const QUOTE_MIN = 4;
/** Character-bigram Jaccard at or above which a new entry is taken to restate an existing one. */
export const SIMILARITY_THRESHOLD = 0.5;

/**
 * What two spellings of one sentence share: NFKC (full-width forms), lower case, and no whitespace,
 * punctuation or symbols, since a model quoting a user routinely changes those and nothing else.
 */
export function normalizeText(text: string): string {
  return (text || "").normalize("NFKC").toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, "");
}

/** Whether `quote` is, after normalisation, part of one of `messages` and long enough to mean something. */
export function quoteIsFrom(quote: string, messages: readonly string[]): boolean {
  const q = normalizeText(quote);
  if ([...q].length < QUOTE_MIN) return false;
  return messages.some((m) => normalizeText(m).includes(q));
}

// Words that say "store this" rather than what to store; sharing only these with the entry is no overlap.
const TRIGGER_WORDS = new Set(["remember", "always", "never", "forget", "please", "from", "now", "on", "记住", "记下", "别忘", "以后", "忘掉", "忘记", "撤销"]);

function contentGrams(text: string): Set<string> {
  const out = new Set<string>();
  const norm = (text || "").normalize("NFKC").toLowerCase();
  for (const word of norm.match(/[a-z0-9_]{3,}/g) ?? []) if (!TRIGGER_WORDS.has(word)) out.add(word);
  for (const run of norm.match(/[^\x00-\x7f\s\p{P}\p{S}]+/gu) ?? []) {
    const chars = [...run];
    for (let i = 0; i + 1 < chars.length; i++) {
      const gram = chars[i] + chars[i + 1];
      if (!TRIGGER_WORDS.has(gram)) out.add(gram);
    }
  }
  return out;
}

/** Whether the quote and the entry say something in common, beyond "remember". */
export function quoteSupports(quote: string, text: string): boolean {
  const entry = contentGrams(text);
  for (const g of contentGrams(quote)) if (entry.has(g)) return true;
  return false;
}

export type MemoryCommandOp = "forget" | "undo";

// The whole message, and nothing else: an optional "please"/"请", the command spelt as shown (the space before "#"
// optional in Chinese only), an optional full stop or "!".
const MEMORY_COMMANDS: ReadonlyArray<{ pattern: RegExp; op: Record<string, MemoryCommandOp> }> = [
  { pattern: /^(?:please )?(forget|undo) memory #([1-9]\d*)[.!。]?$/, op: { forget: "forget", undo: "undo" } },
  { pattern: /^请?(忘掉|撤销)记忆 ?#([1-9]\d*)[.!。]?$/, op: { 忘掉: "forget", 撤销: "undo" } },
];

/**
 * The commands that let the model forget or undo an entry: the user's message is exactly "forget memory #N" or
 * "undo memory #N" ("忘掉记忆 #N", "撤销记忆 #N"), in any letter case and full- or half-width forms. Any other
 * message, however it mentions forgetting, commands nothing: a fixed phrase has no clause, aside or negation for
 * a quote to cut out.
 */
export function memoryCommand(message: string): { op: MemoryCommandOp; id: number } | null {
  // Spaces and tabs only: JavaScript's \s also takes format characters such as U+FEFF, which would let an
  // invisible character stand for the space the command spells or forbids.
  const said = (message || "").normalize("NFKC").toLowerCase().replace(/^[ \t\r\n]+|[ \t\r\n]+$/g, "").replace(/[ \t]+/g, " ");
  for (const { pattern, op } of MEMORY_COMMANDS) {
    const m = pattern.exec(said);
    const id = m ? Number(m[2]) : NaN;
    if (m && Number.isSafeInteger(id)) return { op: op[m[1]], id };
  }
  return null;
}

function bigrams(text: string): Set<string> {
  const chars = [...normalizeText(text)];
  const out = new Set<string>();
  if (chars.length === 1) out.add(chars[0]);
  for (let i = 0; i + 1 < chars.length; i++) out.add(chars[i] + chars[i + 1]);
  return out;
}

/** Character-bigram Jaccard of the two normalised texts, 0..1. */
export function similarity(a: string, b: string): number {
  const x = bigrams(a);
  const y = bigrams(b);
  if (!x.size || !y.size) return 0;
  let shared = 0;
  for (const g of x) if (y.has(g)) shared += 1;
  return shared / (x.size + y.size - shared);
}

const SECRET_PATTERNS: Array<{ pattern: RegExp; id: string }> = [
  { pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/, id: "private_key" },
  { pattern: /\bAKIA[0-9A-Z]{16}\b/, id: "aws_access_key" },
  { pattern: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{30,}\b|\bgithub_pat_[A-Za-z0-9_]{40,}/, id: "github_token" },
  { pattern: /\b(?:sk|ak|pk|rk)-[A-Za-z0-9_-]{20,}/, id: "api_key" },
  { pattern: /\bxox[abprs]-[A-Za-z0-9-]{10,}/, id: "slack_token" },
  { pattern: /\bBearer\s+[A-Za-z0-9._~+/=-]{16,}/i, id: "bearer_token" },
  { pattern: /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/, id: "jwt" },
  { pattern: /\b[A-Za-z0-9_]*(?:PASSWORD|PASSWD|SECRET|TOKEN|API_?KEY|PRIVATE_?KEY)[A-Za-z0-9_]*\s*[:=]\s*["']?[^\s"']{8,}/i, id: "credential_assignment" },
  { pattern: /(?:密码|口令|密钥|令牌)\s*[:：是为]\s*\S{6,}/, id: "credential_assignment" },
];

/**
 * A long run that looks like key material: base64-ish, mixed letter case and digits. A commit sha (hex), a
 * UUID and a path or URL segment do not match: hex is one case, a UUID is cut by dashes, a URL by slashes.
 */
function highEntropyRun(text: string): boolean {
  for (const run of text.match(/[A-Za-z0-9+_=-]{32,}/g) ?? []) {
    if (/^[0-9a-f]+$/i.test(run)) continue;
    if (/[a-z]/.test(run) && /[A-Z]/.test(run) && /[0-9]/.test(run)) return true;
  }
  return false;
}

/** The kind of secret the text holds, or null. Never the secret itself. */
export function scanSecrets(text: string): string | null {
  for (const { pattern, id } of SECRET_PATTERNS) if (pattern.test(text)) return id;
  return highEntropyRun(text) ? "high_entropy_string" : null;
}

const THREAT_PATTERNS: Array<{ pattern: RegExp; id: string }> = [
  { pattern: /ignore\s+(previous|all|above|prior)\s+instructions/i, id: "prompt_injection" },
  { pattern: /you\s+are\s+now\s+/i, id: "role_hijack" },
  { pattern: /do\s+not\s+tell\s+the\s+user/i, id: "deception" },
  { pattern: /disregard\s+(your|all|any)\s+(instructions|rules)/i, id: "disregard" },
  { pattern: /curl\s+[^\n]*\$\{?\w*(KEY|TOKEN|SECRET|PASSWORD)/i, id: "exfil" },
];

const INJECTION_PATTERNS: Array<{ pattern: RegExp; id: string }> = [
  ...THREAT_PATTERNS,
  { pattern: /(忽略|无视|忘掉|忘记)(掉)?(之前|以上|上面|前面|先前|所有|全部|你的)?(的)?(所有|全部)?(指令|指示|说明|提示|规则|要求)/, id: "prompt_injection" },
  { pattern: /(从现在起|现在)?你(现在)?(是|扮演|充当)(一个|一名)?[^，。,.]{0,12}(助手|角色|系统|管理员|AI)/, id: "role_hijack" },
  { pattern: /(不要|别|切勿)(告诉|通知|让)用户/, id: "deception" },
  { pattern: /(系统提示|system\s*prompt)(词)?(是|为|改为|如下)/i, id: "prompt_injection" },
];

/** The kind of instruction-hijack the text carries, or null. */
export function scanInjection(text: string): string | null {
  for (const { pattern, id } of INJECTION_PATTERNS) if (pattern.test(text)) return id;
  return null;
}

/** The type a pre-typed entry is shown and ranked as. Its row is not rewritten: only the user's review does that. */
export function legacyType(category: string): MemoryType {
  switch (category) {
    case "preference": return "user";
    case "correction":
    case "pattern": return "feedback";
    case "tool_quirk": return "reference";
    default: return "project";
  }
}

export function isMemoryType(v: unknown): v is MemoryType {
  return typeof v === "string" && (MEMORY_TYPES as readonly string[]).includes(v);
}

// ===== Recall by a message =====

/**
 * The terms a text is matched on: each run of letters and digits as one word (`kestrel`, `wren`, `v3`), and each run of
 * other characters (Chinese, Japanese, ...) as its character bigrams, a single character alone. Normalised as
 * `normalizeText` does (NFKC, lower case), but split at whitespace and punctuation instead of joined across them, so
 * that two English words do not make a bigram that neither holds.
 */
export function recallTerms(text: string): Set<string> {
  const out = new Set<string>();
  const s = (text || "").normalize("NFKC").toLowerCase();
  for (const run of s.match(/[\p{L}\p{N}]+/gu) ?? []) {
    for (const part of run.match(/[a-z0-9]+|[^a-z0-9]+/g) ?? []) {
      if (/^[a-z0-9]/.test(part)) { out.add(part); continue; }
      const chars = [...part];
      if (chars.length === 1) out.add(chars[0]);
      for (let i = 0; i + 1 < chars.length; i++) out.add(chars[i] + chars[i + 1]);
    }
  }
  return out;
}

/** A word counts as the bigrams it spells (`kestrel` as six), so a name weighs what it would in the bigram measure. */
function termLength(term: string): number {
  return /^[a-z0-9]/.test(term) ? Math.max(1, term.length - 1) : 1;
}

export interface MessageRecallOptions {
  /** At most this many, best first. */
  limit: number;
  /** The share of the message's known wording an entry must hold, 0..1 (`rankByMessage`). */
  minScore: number;
}

/**
 * The texts a message is about, best first. A text's score is the share of the message's wording it holds, each term
 * weighted by how few of the texts share it (inverse document frequency over `texts`, so a word every entry has counts
 * for little) and a word by its length (`termLength`), out of all the message's terms that any text holds: words no
 * entry has (greetings, 一般, 哪天) neither help nor dilute. A text must also hold at least one term that few of the
 * texts hold (a quarter of them, or two), so a message that shares only the commonest wording (用户, 时候) with many
 * entries recalls nothing. Pure, and over the given texts only.
 */
export function rankByMessage<T>(
  message: string, texts: readonly T[], textOf: (t: T) => string, opts: MessageRecallOptions,
): Array<{ item: T; score: number }> {
  const query = recallTerms(message);
  if (!query.size || !texts.length) return [];
  const docs = texts.map((t) => recallTerms(textOf(t)));
  const n = docs.length;
  const df = new Map<string, number>();
  for (const g of query) {
    let c = 0;
    for (const d of docs) if (d.has(g)) c += 1;
    if (c) df.set(g, c);
  }
  let known = 0;
  const idf = new Map<string, number>();
  for (const [g, c] of df) { const w = Math.log(1 + n / c) * termLength(g); idf.set(g, w); known += w; }
  if (known <= 0) return [];
  // A telling term: one at most a quarter of the texts hold, or two of a handful, where a quarter is less than one.
  const rare = Math.max(2, Math.ceil(n / 4));
  const out: Array<{ item: T; score: number; at: number }> = [];
  docs.forEach((d, at) => {
    let held = 0;
    let distinctive = false;
    for (const [g, w] of idf) if (d.has(g)) { held += w; if ((df.get(g) ?? 0) <= rare) distinctive = true; }
    const score = held / known;
    if (distinctive && score >= opts.minScore) out.push({ item: texts[at], score, at });
  });
  return out.sort((a, b) => b.score - a.score || a.at - b.at).slice(0, opts.limit).map(({ item, score }) => ({ item, score }));
}
