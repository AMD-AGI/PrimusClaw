/**
 * JSON written byte for byte as Python's `json.dumps(value, ensure_ascii=False, indent=1, sort_keys=True)` writes it: the format of
 * the snapshots the Python worker's tests keep, so a TS snapshot compares to the same file without a diff.
 */
function encode(value: unknown, depth: number): string {
  if (value === null || value === undefined) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") return pythonNumber(value);
  if (typeof value === "string") return JSON.stringify(value);
  const inner = " ".repeat(depth + 1);
  const outer = " ".repeat(depth);
  if (Array.isArray(value)) {
    if (value.length === 0) return "[]";
    return `[\n${value.map((v) => inner + encode(v, depth + 1)).join(",\n")}\n${outer}]`;
  }
  const keys = Object.keys(value as object)
    .filter((k) => (value as Record<string, unknown>)[k] !== undefined)
    .sort(byCodePoint);
  if (keys.length === 0) return "{}";
  const record = value as Record<string, unknown>;
  return `{\n${keys.map((k) => `${inner}${JSON.stringify(k)}: ${encode(record[k], depth + 1)}`).join(",\n")}\n${outer}}`;
}

/** Python sorts str keys by code point; JavaScript's default sort compares UTF-16 units (they differ past U+FFFF). */
function byCodePoint(a: string, b: string): number {
  const x = Array.from(a);
  const y = Array.from(b);
  for (let i = 0; i < Math.min(x.length, y.length); i += 1) {
    const d = (x[i]?.codePointAt(0) ?? 0) - (y[i]?.codePointAt(0) ?? 0);
    if (d !== 0) return d;
  }
  return x.length - y.length;
}

function pythonNumber(n: number): string {
  if (!Number.isFinite(n)) throw new Error("JSON has no non-finite numbers");
  return String(n);
}

export function pythonJson(value: unknown): string {
  return encode(value, 0) + "\n";
}
