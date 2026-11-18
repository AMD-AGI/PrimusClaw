// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * npm audit gate (`.github/workflows/security.yml`): a high or critical advisory fails the project, except an advisory
 * on the exception list below, and only while two things hold: it is reached through development dependencies alone
 * (`npm audit --omit=dev` does not report it) and its exception has not expired. An advisory in the production tree
 * always fails, whatever the list says.
 *
 *   node personal-agent/scripts/audit-gate.ts <project directory> [--today YYYY-MM-DD]
 *
 * It runs `npm audit --json` twice in the project (all dependencies, then `--omit=dev`); `--today` is for tests.
 *
 * To remove an exception: delete its entry from AUDIT_EXCEPTIONS (and its test in personal-agent/test/audit-gate.test.ts).
 * An expired entry already fails the gate, so it cannot be left behind silently.
 */
import { execFileSync } from "node:child_process";

export interface AuditException {
  /** The advisory's GHSA id, as the last segment of its URL in `npm audit --json`. */
  id: string;
  /** The last day (UTC, YYYY-MM-DD) the exception holds; from the day after, the advisory fails the gate again. */
  expires: string;
  why: string;
}

export const AUDIT_EXCEPTIONS: readonly AuditException[] = [
  {
    id: "GHSA-fc5q-39xc-vjpf",
    expires: "2026-12-18",
    why:
      "picomatch ReDoS through single-branch repeated extglobs; no fixed version upstream. Reached only from development " +
      "tooling (dependency-cruiser, eslint, c8/test-exclude), never from a published package or an image.",
  },
];

const FAILING = new Set(["high", "critical"]);

export interface Advisory {
  id: string;
  severity: string;
  title: string;
  /** The package the advisory is about. */
  name: string;
}

const text = (v: unknown): string => (typeof v === "string" ? v : "");

/** One `via` entry as an advisory at high or critical severity, or undefined (a package name, or a lower severity). */
function advisoryOf(via: unknown): Advisory | undefined {
  if (typeof via !== "object" || via === null) return undefined;
  const a = via as { url?: unknown; source?: unknown; severity?: unknown; title?: unknown; name?: unknown };
  const severity = text(a.severity);
  if (!FAILING.has(severity)) return undefined;
  const source = typeof a.source === "number" ? String(a.source) : text(a.source);
  const id = text(a.url).split("/").pop() || source || "unknown";
  return { id, severity, title: text(a.title), name: text(a.name) };
}

/** The advisories of an `npm audit --json` report (v7 and later), each once, at high or critical severity. */
export function failingAdvisories(report: unknown): Advisory[] {
  const vulns = (report as { vulnerabilities?: Record<string, { via?: unknown[] }> } | null)?.vulnerabilities ?? {};
  const out = new Map<string, Advisory>();
  for (const v of Object.values(vulns)) {
    for (const via of v.via ?? []) {
      const a = advisoryOf(via);
      if (a) out.set(a.id, a);
    }
  }
  return [...out.values()];
}

/** An `npm audit --json` report: an object with `metadata` and a `vulnerabilities` object, and no `error` (npm prints one when it cannot audit). */
export function isReport(report: unknown): boolean {
  if (typeof report !== "object" || report === null) return false;
  const r = report as { metadata?: unknown; vulnerabilities?: unknown; error?: unknown };
  return (
    typeof r.metadata === "object" &&
    r.metadata !== null &&
    typeof r.vulnerabilities === "object" &&
    r.vulnerabilities !== null &&
    r.error === undefined
  );
}

export interface GateResult {
  ok: boolean;
  /** One line per advisory: why it fails, or which exception lets it pass. */
  lines: string[];
}

/**
 * The verdict for one project. `all` and `prod` are its `npm audit --json` reports without and with `--omit=dev`;
 * `today` is a UTC date, YYYY-MM-DD.
 */
export function gate(
  all: unknown,
  prod: unknown,
  today: string,
  exceptions: readonly AuditException[] = AUDIT_EXCEPTIONS,
): GateResult {
  const lines: string[] = [];
  // Without both reports nothing can be said clean: a production audit that failed would let any advisory pass as dev-only.
  if (!isReport(all) || !isReport(prod)) {
    return {
      ok: false,
      lines: [
        `::error::npm audit gave no report${isReport(all) ? " without development dependencies" : ""}; refusing to report a clean result`,
      ],
    };
  }
  let ok = true;
  const inProd = new Set(failingAdvisories(prod).map((a) => a.id));
  const seen = new Set<string>();
  for (const a of [...failingAdvisories(all), ...failingAdvisories(prod)]) {
    if (seen.has(a.id)) continue;
    seen.add(a.id);
    const what = `${a.id} (${a.severity}, ${a.name}): ${a.title}`;
    const ex = exceptions.find((e) => e.id === a.id);
    if (inProd.has(a.id)) {
      ok = false;
      lines.push(
        `::error::${what}: in the production dependencies${ex ? "; its exception covers development dependencies only" : ""}`,
      );
    } else if (!ex) {
      ok = false;
      lines.push(`::error::${what}`);
    } else if (today > ex.expires) {
      ok = false;
      lines.push(`::error::${what}: its exception expired on ${ex.expires}; fix it or decide again`);
    } else {
      lines.push(`::warning::${what}: development dependencies only, excepted until ${ex.expires}: ${ex.why}`);
    }
  }
  return { ok, lines };
}

function audit(dir: string, omitDev: boolean): unknown {
  try {
    return JSON.parse(
      execFileSync("npm", ["audit", "--json", ...(omitDev ? ["--omit=dev"] : [])], {
        cwd: dir,
        encoding: "utf8",
        maxBuffer: 64 << 20,
      }),
    );
  } catch (err) {
    // npm audit exits non-zero when it finds anything; its report is still on stdout.
    const out = (err as { stdout?: string }).stdout;
    if (typeof out === "string" && out.trim().startsWith("{")) return JSON.parse(out);
    throw err;
  }
}

function main(argv: readonly string[]): number {
  const dir = argv.find((a, i) => !a.startsWith("--") && argv[i - 1] !== "--today");
  const t = argv.indexOf("--today");
  const today = t >= 0 ? (argv[t + 1] ?? "") : new Date().toISOString().slice(0, 10);
  if (dir === undefined || !/^\d{4}-\d{2}-\d{2}$/.test(today)) {
    console.error("usage: audit-gate.ts <project directory> [--today YYYY-MM-DD]");
    return 2;
  }
  const all = audit(dir, false);
  const { ok, lines } = gate(all, audit(dir, true), today);
  for (const l of lines) console.log(l);
  const excepted = lines.filter((l) => l.startsWith("::warning::")).length;
  console.log(
    `${dir}: ${ok ? "passes" : "fails"}: ${String(lines.length)} high or critical advisories, ${String(excepted)} excepted`,
  );
  return ok ? 0 : 1;
}

if (import.meta.filename === process.argv[1]) process.exit(main(process.argv.slice(2)));
