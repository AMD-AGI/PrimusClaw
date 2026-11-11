// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Python's `json.loads` and `json.dumps`, so the queue message the worker reads is byte for byte the one the Python
 * Function wrote (`json.dumps(activity)` of the parsed body): Python's separators, `ensure_ascii` escaping, the key
 * order of the document (a repeated key keeps its first position and its last value, as a dict does), integers written
 * as they came and floats as Python's repr. `loads` also takes what Python takes and JSON.parse does not (NaN, Infinity,
 * -Infinity) and refuses what Python refuses.
 *
 * Both are iterative: a deeply nested body cannot overflow the JavaScript stack. Python itself gives up with a
 * RecursionError (not a ValueError) somewhere above 57,000 levels on a default 8 MiB stack; this does the same past
 * MAX_DEPTH.
 */
import { floatRepr, isObject, PyValueError, type Json } from "./py.js";

/** A number as it was written, so an integer keeps its digits and a float stays a float. */
export class NumberToken {
  constructor(readonly raw: string) {}
  get isInt(): boolean {
    return !/[.eE]/.test(this.raw) && !/[NI]/.test(this.raw);
  }
}

/** What `json.loads` produces, with a dict's order: str, bool, None, numbers, lists and dicts (as Maps). */
export type PyValue = string | boolean | null | number | NumberToken | PyValue[] | Map<string, PyValue>;

export class PyRecursionError extends Error {
  override name = "RecursionError";
  constructor() {
    super("maximum recursion depth exceeded while decoding a JSON document");
  }
}

export const MAX_DEPTH = 50_000;

const WS = new Set([" ", "\t", "\n", "\r"]);
const NUMBER = /-?(?:0|[1-9][0-9]*)(\.[0-9]+)?([eE][-+]?[0-9]+)?/y;
const ESCAPES = new Map([
  ['"', '"'],
  ["\\", "\\"],
  ["/", "/"],
  ["b", "\b"],
  ["f", "\f"],
  ["n", "\n"],
  ["r", "\r"],
  ["t", "\t"],
]);
/** The literals `json.loads` reads, longest first where one is the start of another. */
const LITERALS: readonly (readonly [string, PyValue | (() => PyValue)])[] = [
  ["null", null],
  ["true", true],
  ["false", false],
  ["NaN", () => new NumberToken("NaN")],
  ["Infinity", () => new NumberToken("Infinity")],
  ["-Infinity", () => new NumberToken("-Infinity")],
];
const BOM = String.fromCharCode(0xfeff);
/** What scanValue returns for "{" or "[": a container opens. */
const OPEN = Symbol("open");

function fail(message: string, pos: number): never {
  throw new PyValueError(`${message}: char ${String(pos)}`);
}

function numberValue(token: NumberToken): number {
  if (token.raw === "NaN") return NaN;
  if (token.raw === "Infinity") return Infinity;
  if (token.raw === "-Infinity") return -Infinity;
  return Number(token.raw);
}

const isContainer = (v: PyValue): v is PyValue[] | Map<string, PyValue> => v instanceof Map || Array.isArray(v);

/** The plain JavaScript value of a parsed document (a dict becomes an object with own properties only). */
export function plain(root: PyValue): Json {
  // Iterative post-order conversion.
  const out = new Map<PyValue, Json>();
  const stack: [PyValue, boolean][] = [[root, false]];
  for (let item = stack.pop(); item !== undefined; item = stack.pop()) {
    const [node, done] = item;
    if (!isContainer(node)) continue;
    if (!done) {
      stack.push([node, true]);
      for (const v of node.values()) if (isContainer(v)) stack.push([v, false]);
    } else if (Array.isArray(node)) {
      out.set(
        node,
        node.map((v) => convert(v, out)),
      );
    } else {
      const obj: Record<string, Json> = {};
      for (const [k, v] of node) {
        Object.defineProperty(obj, k, { value: convert(v, out), enumerable: true, writable: true, configurable: true });
      }
      out.set(node, obj);
    }
  }
  return convert(root, out);
}

function convert(node: PyValue, done: Map<PyValue, Json>): Json {
  if (node instanceof NumberToken) return numberValue(node);
  if (isContainer(node)) return done.get(node) ?? null;
  return node;
}

interface Frame {
  container: PyValue[] | Map<string, PyValue>;
  key: string | null;
}

/** One `json.loads` run over `text`. */
class Scanner {
  private pos = 0;
  private readonly stack: Frame[] = [];
  private result: PyValue = null;

  constructor(private readonly text: string) {}

  run(): PyValue {
    if (this.text.startsWith(BOM)) fail("Unexpected UTF-8 BOM (decode using utf-8-sig)", 0);
    this.skip();
    let expectValue = true;
    for (;;) {
      if (expectValue) {
        expectValue = this.valueStep();
        continue;
      }
      const top = this.stack.at(-1);
      if (top === undefined) break;
      expectValue = this.afterValue(top);
    }
    this.skip();
    if (this.pos !== this.text.length) fail("Extra data", this.pos);
    return this.result;
  }

  private at(): string | undefined {
    return this.text[this.pos];
  }

  private skip(): void {
    while (this.pos < this.text.length && WS.has(this.text.charAt(this.pos))) this.pos++;
  }

  /** Where a value is expected (or a container may close). True while a value is still expected. */
  private valueStep(): boolean {
    const top = this.stack.at(-1);
    if (top?.container instanceof Map) {
      // a key is expected (or "}" right after "{")
      this.skip();
      if (this.at() === "}" && top.container.size === 0 && top.key === null) return this.close();
      if (this.at() !== '"') fail("Expecting property name enclosed in double quotes", this.pos);
      top.key = this.scanString();
      this.skip();
      if (this.at() !== ":") fail("Expecting ':' delimiter", this.pos);
      this.pos++;
      this.skip();
    } else if (top !== undefined && top.container.length === 0) {
      this.skip();
      if (this.at() === "]") return this.close();
    }
    const value = this.scanValue();
    if (value !== OPEN) {
      this.attach(value);
      return false;
    }
    this.open();
    // a fresh container: an empty array may close at once
    if (Array.isArray(this.stack.at(-1)?.container)) {
      this.skip();
      if (this.at() === "]") return this.close();
    }
    return true;
  }

  /** After a value: close containers or move to the next item. True when a value is expected next. */
  private afterValue(top: Frame): boolean {
    this.skip();
    const ch = this.at();
    if (ch === (top.container instanceof Map ? "}" : "]")) return this.close();
    if (ch !== ",") fail("Expecting ',' delimiter", this.pos);
    this.pos++;
    this.skip();
    if (top.container instanceof Map && this.at() !== '"') {
      fail("Expecting property name enclosed in double quotes", this.pos);
    }
    return true;
  }

  /** Close the innermost container (its closing bracket is at pos). False: a value is no longer expected. */
  private close(): false {
    this.pos++;
    const top = this.stack.pop();
    if (top !== undefined) this.attach(top.container);
    return false;
  }

  private attach(value: PyValue): void {
    const top = this.stack.at(-1);
    if (top === undefined) this.result = value;
    else if (top.container instanceof Map) top.container.set(top.key ?? "", value);
    else top.container.push(value);
  }

  private open(): void {
    if (this.stack.length >= MAX_DEPTH) throw new PyRecursionError();
    const ch = this.at();
    this.pos++;
    this.stack.push({ container: ch === "{" ? new Map<string, PyValue>() : [], key: null });
  }

  private scanValue(): PyValue | typeof OPEN {
    const ch = this.at();
    if (ch === undefined) fail("Expecting value", this.pos);
    if (ch === '"') return this.scanString();
    if (ch === "{" || ch === "[") return OPEN;
    for (const [literal, value] of LITERALS) {
      if (this.text.startsWith(literal, this.pos)) {
        this.pos += literal.length;
        return typeof value === "function" ? value() : value;
      }
    }
    NUMBER.lastIndex = this.pos;
    const m = NUMBER.exec(this.text);
    if (m === null || m[0] === "-") fail("Expecting value", this.pos);
    this.pos += m[0].length;
    return new NumberToken(m[0]);
  }

  /** A string whose opening quote is at pos. */
  private scanString(): string {
    this.pos++;
    let out = "";
    for (;;) {
      const ch = this.at();
      if (ch === undefined) fail("Unterminated string starting at", this.pos);
      if (ch === '"') {
        this.pos++;
        return out;
      }
      if (ch === "\\") {
        out += this.scanEscape();
        continue;
      }
      if (ch.charCodeAt(0) < 0x20) fail("Invalid control character at", this.pos);
      out += ch;
      this.pos++;
    }
  }

  /** The escape at pos (a backslash), as the text it stands for. */
  private scanEscape(): string {
    const esc = this.text[this.pos + 1];
    if (esc === undefined) fail("Unterminated string starting at", this.pos);
    if (esc !== "u") {
      const mapped = ESCAPES.get(esc);
      if (mapped === undefined) fail("Invalid \\escape", this.pos);
      this.pos += 2;
      return mapped;
    }
    const code = this.hex4(this.pos + 2);
    if (code === null) fail("Invalid \\uXXXX escape", this.pos);
    this.pos += 6;
    if (code >= 0xd800 && code <= 0xdbff && this.text.startsWith("\\u", this.pos)) {
      const low = this.hex4(this.pos + 2);
      if (low !== null && low >= 0xdc00 && low <= 0xdfff) {
        this.pos += 6;
        return String.fromCodePoint(0x10000 + ((code - 0xd800) << 10) + (low - 0xdc00));
      }
    }
    return String.fromCodePoint(code);
  }

  private hex4(at: number): number | null {
    const hex = this.text.slice(at, at + 4);
    return /^[0-9a-fA-F]{4}$/.test(hex) ? parseInt(hex, 16) : null;
  }
}

/** `json.loads(text)`: a PyValue, or PyValueError (JSONDecodeError) / PyRecursionError. */
export function loads(text: string): PyValue {
  return new Scanner(text).run();
}

// --- dumps --------------------------------------------------------------------------------------------------------

const STRING_ESCAPES = new Map([
  ['"', '\\"'],
  ["\\", "\\\\"],
  ["\n", "\\n"],
  ["\r", "\\r"],
  ["\t", "\\t"],
  ["\b", "\\b"],
  ["\f", "\\f"],
]);

function escapeString(value: string, ensureAscii: boolean): string {
  let out = '"';
  for (let i = 0; i < value.length; i++) {
    const ch = value.charAt(i);
    const code = value.charCodeAt(i);
    const escaped = STRING_ESCAPES.get(ch);
    if (escaped !== undefined) out += escaped;
    else if (code < 0x20 || (ensureAscii && code > 0x7e)) out += `\\u${code.toString(16).padStart(4, "0")}`;
    else out += ch;
  }
  return `${out}"`;
}

function floatText(value: number, allowNan: boolean): string {
  if (Number.isFinite(value)) return floatRepr(value);
  if (!allowNan) {
    throw new PyValueError(`Out of range float values are not JSON compliant: ${floatRepr(value)}`);
  }
  if (Number.isNaN(value)) return "NaN";
  return value > 0 ? "Infinity" : "-Infinity";
}

function numberText(value: number | NumberToken, allowNan: boolean): string {
  if (value instanceof NumberToken) {
    if (value.isInt) return value.raw === "-0" ? "0" : value.raw;
    return floatText(numberValue(value), allowNan);
  }
  return Number.isInteger(value) && !Object.is(value, -0) ? String(value) : floatText(value, allowNan);
}

export interface DumpOptions {
  /** (item separator, key separator): Python's default is (", ", ": "). */
  separators?: [string, string];
  ensureAscii?: boolean;
  allowNan?: boolean;
}

type Work = { value: unknown } | { text: string };

/** A container's opening text, its entries (key null in a list) and its closing text; null for a scalar. */
function containerOf(value: unknown): [string, [string | null, unknown][], string] | null {
  if (value instanceof NumberToken) return null;
  if (Array.isArray(value)) return ["[", value.map((v: unknown) => [null, v]), "]"];
  if (value instanceof Map) return ["{", [...(value as Map<string, unknown>).entries()], "}"];
  if (isObject(value)) return ["{", Object.entries(value), "}"];
  return null;
}

function scalarText(value: unknown, ensureAscii: boolean, allowNan: boolean): string {
  if (value === null || value === undefined) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "string") return escapeString(value, ensureAscii);
  if (typeof value === "number" || value instanceof NumberToken) return numberText(value, allowNan);
  throw new TypeError(`Object of type ${typeof value} is not JSON serializable`);
}

/**
 * `json.dumps(value)`. Takes PyValues (Maps keep their order) and plain JavaScript values (an object's own enumerable
 * properties, in JavaScript's order; an integer-valued number is written as an int).
 */
export function dumps(root: unknown, options: DumpOptions = {}): string {
  const [itemSep, keySep] = options.separators ?? [", ", ": "];
  const ensureAscii = options.ensureAscii ?? true;
  const allowNan = options.allowNan ?? true;
  const parts: string[] = [];
  const stack: Work[] = [{ value: root }];
  let depth = 0;
  for (let item = stack.pop(); item !== undefined; item = stack.pop()) {
    if ("text" in item) {
      parts.push(item.text);
      if (item.text === "]" || item.text === "}") depth--;
      continue;
    }
    const container = containerOf(item.value);
    if (container === null) {
      parts.push(scalarText(item.value, ensureAscii, allowNan));
      continue;
    }
    const [open, entries, close] = container;
    parts.push(open);
    if (++depth > MAX_DEPTH) throw new PyRecursionError();
    const work: Work[] = [];
    entries.forEach(([key, v], i) => {
      const prefix = (i ? itemSep : "") + (key === null ? "" : escapeString(key, ensureAscii) + keySep);
      if (prefix) work.push({ text: prefix });
      work.push({ value: v });
    });
    work.push({ text: close });
    for (let i = work.length - 1; i >= 0; i--) stack.push(work[i] as Work);
  }
  return parts.join("");
}
