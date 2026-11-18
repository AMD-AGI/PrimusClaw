// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Third-party licence gate: every package a project installs for production (its package-lock.json entries that are
 * not `dev`) must carry a licence compatible with this repository's MIT licence. A copyleft licence, a licence not on
 * the list, or no licence at all fails the check. It reads the lockfile only (npm records each package's `license`
 * field there), so it needs no install and runs in seconds.
 *
 *   node personal-agent/scripts/license-check.ts <path/to/package-lock.json> [--list]
 *
 * An SPDX expression passes when it can be satisfied with allowed licences: `A OR B` needs one side, `A AND B` both.
 */
import { readFileSync } from "node:fs";

/** Licences compatible with distributing this MIT-licensed repository, by SPDX id. Adding one is a reviewed change. */
export const ALLOWED: ReadonlySet<string> = new Set([
  "MIT",
  "MIT-0",
  "ISC",
  "BSD-2-Clause",
  "BSD-3-Clause",
  "Apache-2.0",
  "0BSD",
  "BlueOak-1.0.0",
  "Unlicense",
  "CC0-1.0",
]);

export interface Finding {
  readonly name: string;
  readonly version: string;
  readonly license: string;
  readonly ok: boolean;
}

/** Whether an SPDX expression can be satisfied by allowed licences (parentheses, OR, AND, `+` and WITH stripped). */
export function allowedExpression(expression: string): boolean {
  const text = expression.trim();
  if (text === "") return false;
  const orParts = splitTop(text, "OR");
  if (orParts.length > 1) return orParts.some(allowedExpression);
  const andParts = splitTop(text, "AND");
  if (andParts.length > 1) return andParts.every(allowedExpression);
  if (text.startsWith("(") && text.endsWith(")")) return allowedExpression(text.slice(1, -1));
  const id = (text.split(/\s+WITH\s+/)[0] ?? "").replace(/\+$/, "").trim();
  return ALLOWED.has(id);
}

/** `text` split on ` <word> ` outside parentheses. */
function splitTop(text: string, word: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  const token = ` ${word} `;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === "(") depth++;
    else if (ch === ")") depth--;
    else if (depth === 0 && text.startsWith(token, i)) {
      parts.push(text.slice(start, i));
      start = i + token.length;
      i += token.length - 1;
    }
  }
  parts.push(text.slice(start));
  return parts;
}

/** The licence text npm recorded: a string, or the legacy `{type}` object / array of them. */
function licenseOf(raw: unknown): string {
  if (typeof raw === "string") return raw;
  if (Array.isArray(raw)) return raw.map(licenseOf).filter(Boolean).join(" OR ");
  if (typeof raw === "object" && raw !== null && "type" in raw && typeof raw.type === "string") return raw.type;
  return "";
}

/** One finding per production package of the lockfile, sorted by name. */
export function check(lockfile: unknown): Finding[] {
  const packages =
    typeof lockfile === "object" && lockfile !== null && "packages" in lockfile ? lockfile.packages : undefined;
  if (typeof packages !== "object" || packages === null) throw new Error("not a package-lock.json (v2/v3)");
  const findings: Finding[] = [];
  for (const [path, value] of Object.entries(packages as Record<string, unknown>)) {
    const entry = (typeof value === "object" && value !== null ? value : {}) as Record<string, unknown>;
    if (!path.includes("node_modules/") || entry["dev"] === true || entry["link"] === true) continue;
    const name = path.slice(path.lastIndexOf("node_modules/") + "node_modules/".length);
    const license = licenseOf(entry["license"]);
    findings.push({
      name,
      version: typeof entry["version"] === "string" ? entry["version"] : "",
      license,
      ok: allowedExpression(license),
    });
  }
  return findings.sort((a, b) =>
    a.name === b.name ? a.version.localeCompare(b.version) : a.name.localeCompare(b.name),
  );
}

function main(argv: readonly string[]): number {
  const file = argv.find((a) => !a.startsWith("--"));
  if (file === undefined) {
    console.error("usage: license-check.ts <package-lock.json> [--list]");
    return 2;
  }
  const findings = check(JSON.parse(readFileSync(file, "utf8")) as unknown);
  if (findings.length === 0) {
    console.error(`${file}: no production package found; refusing to report a clean result`);
    return 1;
  }
  if (argv.includes("--list"))
    for (const f of findings) console.log(`${f.name}@${f.version}\t${f.license || "(none)"}`);
  const bad = findings.filter((f) => !f.ok);
  for (const f of bad)
    console.error(`::error::${f.name}@${f.version}: licence "${f.license || "(none)"}" is not on the allowed list`);
  const counts = new Map<string, number>();
  for (const f of findings) counts.set(f.license || "(none)", (counts.get(f.license || "(none)") ?? 0) + 1);
  console.log(
    `${file}: ${String(findings.length)} production packages; ${[...counts].map(([l, n]) => `${l} ${String(n)}`).join(", ")}; ${String(bad.length)} not allowed`,
  );
  return bad.length === 0 ? 0 : 1;
}

if (import.meta.filename === process.argv[1]) process.exit(main(process.argv.slice(2)));
