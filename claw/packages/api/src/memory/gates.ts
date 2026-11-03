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

// A request, not a mention: "forget" but not "forgetting" or "don't forget", "忘掉" but not "总忘记".
const FORGET_REQUEST = /(?<!\b(?:don't|dont|do not|never|not)\s+)\b(forget|delete|remove|undo|revert)\b|忘掉|忘了(它|这|那|吧)|忘记(它|这|那|关于)|删掉|删除|删了|撤销|撤回|去掉|别记|不要记|不用记/i;

/**
 * Whether a quote asks to forget or undo this entry: it is a request to forget, and it names the entry by its
 * number or by what it says. Any other sentence of the user's ("review this repository", "I keep forgetting
 * my vim shortcuts") is not such a request.
 */
export function quoteAsksToForget(quote: string, id: number, entry: string): boolean {
  if (!FORGET_REQUEST.test(quote.normalize("NFKC").replace(/[’‘]/g, "'"))) return false;
  return (quote.normalize("NFKC").match(/\d+/g) ?? []).includes(String(id)) || quoteSupports(quote, entry);
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

/** The check skill content gets (the save_skill tool, the skill routes, evolution): threat patterns and a length cap. */
export function scanMemoryContent(content: string, maxLength = 2000): string | null {
  for (const { pattern, id } of THREAT_PATTERNS) {
    if (pattern.test(content)) return `Blocked: threat pattern '${id}'`;
  }
  if (content.length > maxLength) return `Blocked: content too long (max ${maxLength} chars)`;
  return null;
}

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
