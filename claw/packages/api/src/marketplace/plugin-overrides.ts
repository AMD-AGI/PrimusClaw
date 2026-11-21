// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Run-time overrides of a plugin: what a launch may change without a new plugin.
 *
 * A plugin's author declares, in `plugins.overridable`, which keys a launch may
 * set and what a value must look like. A launch (an app run, or a single task)
 * names its values in `overrides`; each is checked against the declaration and
 * the plugin's own `images`, and only then applied. Nothing is overridable
 * unless declared: a plugin with no declaration (every plugin written before the
 * column existed) refuses every override, so its launches behave as before.
 *
 * The keys:
 *
 *   image  a sandbox image; must be one of the plugin's `images` repos, or of the
 *          declaration's own `enum`.
 *   model  the model a run uses. On a task it is the task's model; on an app run
 *          it is written into the env names the declaration lists in `env`.
 *   args   extra arguments appended to an app's `command`.
 *   env    one entry per environment variable an app run may set.
 *   sandbox_templates
 *          per named template of an app manifest: its `fromImage`, its card
 *          count (`per_gpu_count`) and its `resources`, each within the bounds
 *          the declaration sets. App runs only.
 *
 * This module is pure (no database, no I/O) so the write path (db.ts) and every
 * launch path read the same rules.
 */
import { createContext, runInContext } from "node:vm";
import { BadRequestError } from "../shared/errors.js";

/** The surfaces a plugin is launched from. */
export type OverrideSurface = "app" | "task";

/** One string value's rules: a small JSON Schema subset. */
export interface StringRule {
  type?: "string";
  enum?: string[];
  pattern?: string;
  maxLength?: number;
  description?: string;
}

/** One integer value's rules: a list of values, or a range. */
export interface IntegerRule {
  type?: "integer";
  enum?: number[];
  minimum?: number;
  maximum?: number;
  description?: string;
}

/** The most a launch may ask for of one resource, as a Kubernetes quantity. */
export interface QuantityMax {
  max: string;
  description?: string;
}

/** Which resources of a template a launch may size, and how far. */
export interface TemplateResourcesRule {
  cpu?: QuantityMax;
  memory?: QuantityMax;
  ephemeralStorage?: QuantityMax;
  sharedMemory?: QuantityMax;
  description?: string;
}

/** What a launch may change in one sandbox template of the app manifest. */
export interface TemplateOverridable {
  fromImage?: StringRule;
  per_gpu_count?: IntegerRule;
  resources?: TemplateResourcesRule;
  description?: string;
}

export interface OverridableDeclaration {
  image?: { enum?: string[]; description?: string };
  model?: StringRule & { env?: string[] };
  args?: { type?: "array"; items?: StringRule; maxItems?: number; description?: string };
  env?: Record<string, StringRule>;
  sandbox_templates?: Record<string, TemplateOverridable>;
}

/** A launch's sizing of one template: Kubernetes container resources, plus the template's `/dev/shm`. */
export interface TemplateResourceValues {
  requests?: Record<string, string>;
  limits?: Record<string, string>;
  sharedMemory?: string;
}

/** A launch's values for one template. */
export interface TemplateOverrideValues {
  fromImage?: string;
  per_gpu_count?: number;
  resources?: TemplateResourceValues;
}

/** A launch's requested values, after they were checked. */
export interface OverrideValues {
  image?: string;
  model?: string;
  args?: string[];
  env?: Record<string, string>;
  sandbox_templates?: Record<string, TemplateOverrideValues>;
}

export interface OverrideProblem {
  field: string;
  reason: string;
}

/** Bounds on a declaration, so one plugin cannot make every launch expensive to check. */
export const OVERRIDE_LIMITS = {
  /** Longest value any string may have, and the default `maxLength`. */
  maxValueLength: 4096,
  /** Longest `pattern`. A pattern is compiled once per check, against a bounded value. */
  maxPatternLength: 512,
  maxEnumEntries: 256,
  maxEnvEntries: 64,
  /** Most `args`, and the default `maxItems`. */
  maxArgs: 64,
  defaultMaxArgs: 16,
  maxDescriptionLength: 1000,
  /** Most templates one declaration names. */
  maxTemplates: 64,
  /** Largest card count a template may be given, and most entries of an integer `enum`. */
  maxGpuCount: 1024,
  maxIntegerEnumEntries: 64,
  /** Longest Kubernetes quantity accepted, in characters. */
  maxQuantityLength: 64,
  /**
   * Wall-clock budget for every `pattern` test of one launch, together. A
   * pattern is the author's and a value the caller's, and a backtracking
   * pattern (`^(a+)+$`) can take seconds on a short value: the tests run in a
   * VM context whose timeout interrupts them, so the most a launch can hold the
   * event loop for is this, and a value whose test did not finish is refused.
   */
  patternBudgetMs: 50,
} as const;

/** The variable names an app manifest accepts; the manifest validator has the last word on reserved names. */
const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
/** A name that is a valid variable name and also a special property of every object; refused outright. */
const isEnvName = (n: unknown): n is string => typeof n === "string" && ENV_NAME_RE.test(n) && n !== "__proto__";
const TOP_KEYS = new Set(["image", "model", "args", "env", "sandbox_templates"]);
const TOP_KEYS_TEXT = "image, model, args, env or sandbox_templates";
/** A template name, as the app manifest spells one. */
const TEMPLATE_NAME_RE = /^[a-z][a-z0-9_-]{0,62}$/;
const TEMPLATE_KEYS = ["fromImage", "per_gpu_count", "resources"] as const;
/** The container resources a launch may size, by their Kubernetes name, to the declaration's key. */
const RESOURCE_RULE_KEY: Readonly<Record<string, "cpu" | "memory" | "ephemeralStorage">> = Object.freeze(
  Object.assign(Object.create(null), { cpu: "cpu", memory: "memory", "ephemeral-storage": "ephemeralStorage" }),
);
const RESOURCE_NAMES = ["cpu", "memory", "ephemeral-storage"] as const;

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

function checkKeys(v: Record<string, unknown>, allowed: string[], at: string, out: OverrideProblem[]): void {
  for (const k of Object.keys(v)) {
    if (!allowed.includes(k)) out.push({ field: `${at}.${k}`, reason: "unknown key" });
  }
}

function checkDescription(v: Record<string, unknown>, at: string, out: OverrideProblem[]): void {
  if (v.description === undefined) return;
  if (typeof v.description !== "string" || v.description.length > OVERRIDE_LIMITS.maxDescriptionLength) {
    out.push({ field: `${at}.description`, reason: `must be a string of at most ${OVERRIDE_LIMITS.maxDescriptionLength} characters` });
  }
}

function checkEnum(v: unknown, at: string, out: OverrideProblem[]): void {
  if (v === undefined) return;
  // No surrounding whitespace: a launch path that trims (the app image does)
  // would otherwise run a value the declaration does not list.
  if (!Array.isArray(v) || v.length === 0 || v.length > OVERRIDE_LIMITS.maxEnumEntries
    || !v.every((e) => typeof e === "string" && e !== "" && e.trim() === e && e.length <= OVERRIDE_LIMITS.maxValueLength)) {
    out.push({ field: `${at}.enum`, reason: `must be 1-${OVERRIDE_LIMITS.maxEnumEntries} non-empty strings without surrounding whitespace` });
  }
}

function checkStringRule(v: unknown, at: string, out: OverrideProblem[], extraKeys: string[] = []): void {
  if (!isPlainObject(v)) {
    out.push({ field: at, reason: "must be an object" });
    return;
  }
  checkKeys(v, ["type", "enum", "pattern", "maxLength", "description", ...extraKeys], at, out);
  if (v.type !== undefined && v.type !== "string") out.push({ field: `${at}.type`, reason: "must be \"string\"" });
  checkEnum(v.enum, at, out);
  if (v.pattern !== undefined) {
    if (typeof v.pattern !== "string" || v.pattern === "" || v.pattern.length > OVERRIDE_LIMITS.maxPatternLength) {
      out.push({ field: `${at}.pattern`, reason: `must be a non-empty string of at most ${OVERRIDE_LIMITS.maxPatternLength} characters` });
    } else {
      // Compiled where it is tested: in the pattern context, under its timeout.
      if (patternCompiles(v.pattern) !== true) {
        out.push({ field: `${at}.pattern`, reason: "is not a valid regular expression" });
      }
    }
  }
  if (v.maxLength !== undefined && !(Number.isSafeInteger(v.maxLength)
    && (v.maxLength as number) >= 1 && (v.maxLength as number) <= OVERRIDE_LIMITS.maxValueLength)) {
    out.push({ field: `${at}.maxLength`, reason: `must be an integer from 1 to ${OVERRIDE_LIMITS.maxValueLength}` });
  }
  checkDescription(v, at, out);
}

/**
 * The problems with a declaration, or none. `undefined` and `null` are no
 * declaration (nothing overridable), which is not a problem.
 */
export function overridableDeclarationProblems(v: unknown): OverrideProblem[] {
  const out: OverrideProblem[] = [];
  if (v === undefined || v === null) return out;
  if (!isPlainObject(v)) return [{ field: "overridable", reason: "must be an object" }];
  for (const k of Object.keys(v)) {
    if (!TOP_KEYS.has(k)) out.push({ field: `overridable.${k}`, reason: `unknown key (expected ${TOP_KEYS_TEXT})` });
  }
  if (v.image !== undefined) {
    if (!isPlainObject(v.image)) out.push({ field: "overridable.image", reason: "must be an object" });
    else {
      checkKeys(v.image, ["enum", "description"], "overridable.image", out);
      checkEnum(v.image.enum, "overridable.image", out);
      checkDescription(v.image, "overridable.image", out);
    }
  }
  if (v.model !== undefined) {
    checkStringRule(v.model, "overridable.model", out, ["env"]);
    const env = isPlainObject(v.model) ? v.model.env : undefined;
    if (env !== undefined && (!Array.isArray(env) || env.length > OVERRIDE_LIMITS.maxEnvEntries
      || !env.every(isEnvName))) {
      out.push({ field: "overridable.model.env", reason: "must be a list of environment variable names" });
    }
  }
  if (v.args !== undefined) {
    if (!isPlainObject(v.args)) out.push({ field: "overridable.args", reason: "must be an object" });
    else {
      checkKeys(v.args, ["type", "items", "maxItems", "description"], "overridable.args", out);
      if (v.args.type !== undefined && v.args.type !== "array") out.push({ field: "overridable.args.type", reason: "must be \"array\"" });
      if (v.args.items !== undefined) checkStringRule(v.args.items, "overridable.args.items", out);
      if (v.args.maxItems !== undefined && !(Number.isSafeInteger(v.args.maxItems)
        && (v.args.maxItems as number) >= 1 && (v.args.maxItems as number) <= OVERRIDE_LIMITS.maxArgs)) {
        out.push({ field: "overridable.args.maxItems", reason: `must be an integer from 1 to ${OVERRIDE_LIMITS.maxArgs}` });
      }
      checkDescription(v.args, "overridable.args", out);
    }
  }
  if (v.env !== undefined) {
    if (!isPlainObject(v.env)) out.push({ field: "overridable.env", reason: "must be an object of variable name to rule" });
    else {
      const names = Object.keys(v.env);
      if (names.length > OVERRIDE_LIMITS.maxEnvEntries) {
        out.push({ field: "overridable.env", reason: `at most ${OVERRIDE_LIMITS.maxEnvEntries} variables` });
      }
      for (const name of names) {
        if (!isEnvName(name)) out.push({ field: `overridable.env.${name}`, reason: "is not an environment variable name" });
        else checkStringRule(v.env[name], `overridable.env.${name}`, out);
      }
    }
  }
  if (v.sandbox_templates !== undefined) {
    const at = "overridable.sandbox_templates";
    if (!isPlainObject(v.sandbox_templates)) out.push({ field: at, reason: "must be an object of template name to declaration" });
    else {
      const names = Object.keys(v.sandbox_templates);
      if (names.length === 0 || names.length > OVERRIDE_LIMITS.maxTemplates) {
        out.push({ field: at, reason: `must name 1-${OVERRIDE_LIMITS.maxTemplates} templates` });
      }
      for (const name of names) {
        if (!TEMPLATE_NAME_RE.test(name)) out.push({ field: `${at}.${name}`, reason: "is not a template name" });
        else checkTemplateDeclaration(v.sandbox_templates[name], `${at}.${name}`, out);
      }
    }
  }
  return out;
}

const DECIMAL_SUFFIX_EXPONENT: Readonly<Record<string, number>> = Object.freeze(
  Object.assign(Object.create(null), { n: -9, u: -6, m: -3, "": 0, k: 3, M: 6, G: 9, T: 12, P: 15, E: 18 }),
);
const BINARY_SUFFIX_POWER: Readonly<Record<string, number>> = Object.freeze(
  Object.assign(Object.create(null), { Ki: 1, Mi: 2, Gi: 3, Ti: 4, Pi: 5, Ei: 6 }),
);
/** Largest decimal exponent (`1e<n>`) a quantity may carry here; far above any real size. */
const MAX_QUANTITY_EXPONENT = 64;

/**
 * A positive Kubernetes quantity, exactly, in nano-units (1e-9), rounded up as
 * Kubernetes rounds a value finer than its nano scale; undefined for anything
 * else. Exact so that a comparison with a declared maximum is the comparison
 * Kubernetes makes: no value a float rounds down to the maximum gets past it.
 */
function quantityOf(v: unknown): bigint | undefined {
  if (typeof v !== "string" || v === "" || v.trim() !== v || v.length > OVERRIDE_LIMITS.maxQuantityLength) return undefined;
  const m = /^([0-9]+)?(?:\.([0-9]*))?(?:([eE])([+-]?[0-9]+)|(Ki|Mi|Gi|Ti|Pi|Ei)|([numkMGTPE]))?$/.exec(v);
  if (!m || (m[1] === undefined && !m[2])) return undefined;
  const whole = m[1] ?? "";
  const fraction = m[2] ?? "";
  let exponent = 9 - fraction.length; // in nano-units
  if (m[3] !== undefined) {
    const e = Number(m[4]);
    if (!Number.isSafeInteger(e) || Math.abs(e) > MAX_QUANTITY_EXPONENT) return undefined;
    exponent += e;
  } else if (m[6] !== undefined) exponent += DECIMAL_SUFFIX_EXPONENT[m[6]]!;
  let n = BigInt(`${whole}${fraction}` || "0");
  if (m[5] !== undefined) n *= 1024n ** BigInt(BINARY_SUFFIX_POWER[m[5]]!);
  if (exponent >= 0) n *= 10n ** BigInt(exponent);
  else {
    const d = 10n ** BigInt(-exponent);
    n = (n + d - 1n) / d;
  }
  return n > 0n ? n : undefined;
}

const QUANTITY_TEXT = "must be a positive Kubernetes quantity string, such as \"64\" or \"2048Gi\"";

const isCardCount = (n: unknown): n is number =>
  Number.isSafeInteger(n) && (n as number) >= 1 && (n as number) <= OVERRIDE_LIMITS.maxGpuCount;

function checkIntegerRule(v: unknown, at: string, out: OverrideProblem[]): void {
  if (!isPlainObject(v)) {
    out.push({ field: at, reason: "must be an object" });
    return;
  }
  checkKeys(v, ["type", "enum", "minimum", "maximum", "description"], at, out);
  if (v.type !== undefined && v.type !== "integer") out.push({ field: `${at}.type`, reason: "must be \"integer\"" });
  const range = `an integer from 1 to ${OVERRIDE_LIMITS.maxGpuCount}`;
  if (v.enum !== undefined && !(Array.isArray(v.enum) && v.enum.length > 0 && v.enum.length <= OVERRIDE_LIMITS.maxIntegerEnumEntries
    && v.enum.every(isCardCount) && new Set(v.enum).size === v.enum.length)) {
    out.push({ field: `${at}.enum`, reason: `must be 1-${OVERRIDE_LIMITS.maxIntegerEnumEntries} distinct values, each ${range}` });
  }
  for (const k of ["minimum", "maximum"] as const) {
    if (v[k] !== undefined && !isCardCount(v[k])) out.push({ field: `${at}.${k}`, reason: `must be ${range}` });
  }
  if (v.enum === undefined && v.maximum === undefined) out.push({ field: at, reason: "needs an enum or a maximum" });
  if (isCardCount(v.minimum) && isCardCount(v.maximum) && v.minimum > v.maximum) {
    out.push({ field: `${at}.minimum`, reason: "must not exceed maximum" });
  }
  checkDescription(v, at, out);
}

function checkTemplateDeclaration(v: unknown, at: string, out: OverrideProblem[]): void {
  if (!isPlainObject(v)) {
    out.push({ field: at, reason: "must be an object" });
    return;
  }
  checkKeys(v, [...TEMPLATE_KEYS, "description"], at, out);
  if (TEMPLATE_KEYS.every((k) => v[k] === undefined)) {
    out.push({ field: at, reason: "declares nothing overridable (expected fromImage, per_gpu_count or resources)" });
  }
  if (v.fromImage !== undefined) {
    checkStringRule(v.fromImage, `${at}.fromImage`, out);
    // An image is what a sandbox runs: the declaration says which, never "any".
    if (isPlainObject(v.fromImage) && v.fromImage.enum === undefined && v.fromImage.pattern === undefined) {
      out.push({ field: `${at}.fromImage`, reason: "needs an enum or a pattern" });
    }
  }
  if (v.per_gpu_count !== undefined) checkIntegerRule(v.per_gpu_count, `${at}.per_gpu_count`, out);
  if (v.resources !== undefined) {
    const rat = `${at}.resources`;
    const r = v.resources;
    if (!isPlainObject(r)) out.push({ field: rat, reason: "must be an object" });
    else {
      const keys = ["cpu", "memory", "ephemeralStorage", "sharedMemory"] as const;
      checkKeys(r, [...keys, "description"], rat, out);
      if (keys.every((k) => r[k] === undefined)) {
        out.push({ field: rat, reason: "declares no resource (expected cpu, memory, ephemeralStorage or sharedMemory)" });
      }
      for (const k of keys) {
        const m = r[k];
        if (m === undefined) continue;
        if (!isPlainObject(m)) {
          out.push({ field: `${rat}.${k}`, reason: "must be an object with max" });
          continue;
        }
        checkKeys(m, ["max", "description"], `${rat}.${k}`, out);
        if (quantityOf(m.max) === undefined) out.push({ field: `${rat}.${k}.max`, reason: QUANTITY_TEXT });
        checkDescription(m, `${rat}.${k}`, out);
      }
      checkDescription(r, rat, out);
    }
  }
  checkDescription(v, at, out);
}

/**
 * The declaration to store: `{}` for none, the value itself when valid.
 * Throws BadRequestError (400 at every plugin write route) naming every problem.
 */
export function normalizeOverridable(v: unknown): OverridableDeclaration {
  if (v === undefined || v === null) return {};
  const problems = overridableDeclarationProblems(v);
  if (problems.length > 0) {
    throw new BadRequestError(`invalid overridable: ${problems.map((p) => `${p.field} ${p.reason}`).join("; ")}`);
  }
  return v as OverridableDeclaration;
}

/** The declaration a stored row holds; anything malformed reads as none, so it can only narrow. */
export function storedOverridable(v: unknown): OverridableDeclaration {
  if (!isPlainObject(v)) return {};
  return overridableDeclarationProblems(v).length === 0 ? (v as OverridableDeclaration) : {};
}

/** A pattern test deferred until every value is known, so one budget covers them all. */
interface PatternJob {
  at: string;
  pattern: string;
  value: string;
}

let patternContext: ReturnType<typeof createContext> | undefined;

/** Run `script` over `data` (a JSON string, as `__jobs`) in the pattern context; its JSON answer, or null when it did not finish. */
function inPatternContext(script: string, data: string, budgetMs: number): unknown {
  patternContext ??= createContext(Object.create(null));
  patternContext.__jobs = data;
  try {
    return JSON.parse(String(runInContext(script, patternContext, { timeout: budgetMs, displayErrors: false })));
  } catch {
    return null;
  } finally {
    patternContext.__jobs = undefined;
  }
}

/** Whether `pattern` compiles as a `u`-flag regular expression; null when the check did not finish. */
export function patternCompiles(pattern: string): boolean | null {
  const out = inPatternContext(
    "JSON.stringify((() => { try { new RegExp(JSON.parse(__jobs), 'u'); return true; } catch { return false; } })())",
    JSON.stringify(pattern),
    OVERRIDE_LIMITS.patternBudgetMs,
  );
  return typeof out === "boolean" ? out : null;
}

/**
 * Which of `jobs` match, as one interruptible run; `null` when the run did not
 * finish within `budgetMs` (or failed), which the caller treats as no match.
 */
export function runPatternJobs(jobs: Array<{ pattern: string; value: string }>, budgetMs: number = OVERRIDE_LIMITS.patternBudgetMs): boolean[] | null {
  if (jobs.length === 0) return [];
  // Only a string crosses into the context, and only a string comes back.
  const parsed = inPatternContext(
    "JSON.stringify(JSON.parse(__jobs).map(([p, v]) => new RegExp(p, 'u').test(v)))",
    JSON.stringify(jobs.map((j) => [j.pattern, j.value])),
    budgetMs,
  );
  return Array.isArray(parsed) && parsed.length === jobs.length ? parsed.map((x) => x === true) : null;
}

function checkStringValue(
  value: unknown,
  rule: StringRule,
  at: string,
  out: OverrideProblem[],
  patterns: PatternJob[],
): string | undefined {
  if (typeof value !== "string" || value === "" || value.trim() !== value) {
    out.push({ field: at, reason: "must be a non-empty string without surrounding whitespace" });
    return undefined;
  }
  const max = rule.maxLength ?? OVERRIDE_LIMITS.maxValueLength;
  if (value.length > max) {
    out.push({ field: at, reason: `must be at most ${max} characters` });
    return undefined;
  }
  if (rule.enum && !rule.enum.includes(value)) {
    out.push({ field: at, reason: "is not one of the values the plugin allows" });
    return undefined;
  }
  // Tested later, with every other pattern of this launch, under one budget.
  if (rule.pattern) patterns.push({ at, pattern: rule.pattern, value });
  return value;
}

/** Every usable repo a plugin's `images` list names, in order. */
export function pluginImageRepos(images: unknown): string[] {
  if (!Array.isArray(images)) return [];
  const out: string[] = [];
  for (const e of images) {
    if (!isPlainObject(e)) continue;
    const repo = String(e.repo ?? "").trim();
    if (repo && !out.includes(repo)) out.push(repo);
  }
  return out;
}

/** What a surface can apply. */
const APPLICABLE: Record<OverrideSurface, ReadonlySet<keyof OverrideValues>> = {
  app: new Set(["image", "model", "args", "env", "sandbox_templates"]),
  task: new Set(["image", "model"]),
};

/**
 * Check a launch's `overrides` against the plugin's declaration.
 *
 * `undefined`/`null` is no override at all and is always fine. Anything else must
 * be an object whose every key the plugin declares, applies to this surface, and
 * holds a value the declaration accepts. All problems are reported at once.
 */
export function checkOverrides(
  requested: unknown,
  plugin: { overridable?: unknown; images?: unknown; resource?: unknown },
  surface: OverrideSurface,
): { ok: true; values: OverrideValues } | { ok: false; problems: OverrideProblem[] } {
  if (requested === undefined || requested === null) return { ok: true, values: {} };
  if (!isPlainObject(requested)) return { ok: false, problems: [{ field: "overrides", reason: "must be an object" }] };
  const decl = storedOverridable(plugin.overridable);
  const out: OverrideProblem[] = [];
  const patterns: PatternJob[] = [];
  const values: OverrideValues = {};
  for (const key of Object.keys(requested)) {
    const at = `overrides.${key}`;
    if (!TOP_KEYS.has(key)) {
      out.push({ field: at, reason: `unknown key (expected ${TOP_KEYS_TEXT})` });
      continue;
    }
    const k = key as keyof OverrideValues;
    if (decl[k] === undefined) {
      out.push({ field: at, reason: "the plugin does not declare this overridable" });
      continue;
    }
    if (!APPLICABLE[surface].has(k)) {
      out.push({ field: at, reason: `does not apply to a ${surface === "app" ? "app run" : "task"}` });
      continue;
    }
    const value = requested[key];
    if (k === "image") {
      const allowed = [...pluginImageRepos(plugin.images), ...(decl.image!.enum ?? [])];
      const v = checkStringValue(value, { maxLength: OVERRIDE_LIMITS.maxValueLength }, at, out, patterns);
      if (v !== undefined) {
        if (allowed.includes(v)) values.image = v;
        else out.push({ field: at, reason: "is not one of the plugin's images" });
      }
    } else if (k === "model") {
      if (surface === "app" && !(decl.model!.env && decl.model!.env.length > 0)) {
        out.push({ field: at, reason: "the plugin names no env variable that carries the model of an app run" });
        continue;
      }
      const v = checkStringValue(value, decl.model!, at, out, patterns);
      if (v !== undefined) values.model = v;
    } else if (k === "args") {
      const rule = decl.args!;
      const max = rule.maxItems ?? OVERRIDE_LIMITS.defaultMaxArgs;
      if (!Array.isArray(value) || value.length > max) {
        out.push({ field: at, reason: `must be a list of at most ${max} strings` });
        continue;
      }
      const args: string[] = [];
      value.forEach((a, i) => {
        const v = checkStringValue(a, rule.items ?? {}, `${at}[${i}]`, out, patterns);
        if (v !== undefined) args.push(v);
      });
      if (args.length === value.length) values.args = args;
    } else if (k === "sandbox_templates") {
      const v = checkTemplateOverrides(value, decl.sandbox_templates!, plugin.resource, at, out, patterns);
      if (v !== undefined) values.sandbox_templates = v;
    } else {
      if (!isPlainObject(value)) {
        out.push({ field: at, reason: "must be an object of variable name to value" });
        continue;
      }
      const entries: Array<[string, string]> = [];
      for (const [name, v] of Object.entries(value)) {
        const rule = isEnvName(name) && Object.hasOwn(decl.env!, name) ? decl.env![name] : undefined;
        if (!rule) {
          out.push({ field: `${at}.${name}`, reason: "the plugin does not declare this variable overridable" });
          continue;
        }
        const s = checkStringValue(v, rule, `${at}.${name}`, out, patterns);
        if (s !== undefined) entries.push([name, s]);
      }
      values.env = Object.fromEntries(entries);
    }
  }
  const matched = runPatternJobs(patterns);
  patterns.forEach((j, i) => {
    if (matched === null) out.push({ field: j.at, reason: "could not be checked against the plugin's pattern in time" });
    else if (!matched[i]) out.push({ field: j.at, reason: "does not match the pattern the plugin declares" });
  });
  if (out.length > 0) return { ok: false, problems: out };
  return { ok: true, values };
}

/** The sandbox templates (by name) and roles of a plugin's app manifest; none when it has no manifest. */
function manifestTemplates(resource: unknown): { templates: Map<string, Record<string, unknown>>; roles: Record<string, unknown> } {
  const app = isPlainObject(resource) ? resource.app : undefined;
  const manifest = isPlainObject(app) ? app.manifest : undefined;
  const list = isPlainObject(manifest) && Array.isArray(manifest.sandbox_templates) ? manifest.sandbox_templates : [];
  const templates = new Map<string, Record<string, unknown>>();
  for (const t of list) if (isPlainObject(t) && typeof t.name === "string" && !templates.has(t.name)) templates.set(t.name, t);
  const roles = isPlainObject(manifest) && isPlainObject(manifest.sandbox_roles) ? manifest.sandbox_roles : {};
  return { templates, roles };
}

/** The card counts a template is registered for (as the app's template map keys them). */
function cardCounts(t: Record<string, unknown>): number[] {
  if (Array.isArray(t.per_gpu_count) && t.per_gpu_count.length > 0) return t.per_gpu_count as number[];
  return [typeof t.gpus === "number" && Number.isInteger(t.gpus) && t.gpus >= 0 ? t.gpus : 0];
}

/**
 * The app is handed one template name per role and card count, so two templates
 * of one role may not take the same count. A changed count that would collide is
 * refused here rather than by the grant, after the run was admitted.
 */
function cardCountCollisions(
  effective: Map<string, Record<string, unknown>>,
  changed: Set<string>,
  roles: Record<string, unknown>,
  at: string,
  out: OverrideProblem[],
): void {
  for (const [role, names] of Object.entries(roles)) {
    if (!Array.isArray(names)) continue;
    const taken = new Map<number, string>();
    for (const name of names) {
      const t = typeof name === "string" ? effective.get(name) : undefined;
      if (!t) continue;
      for (const n of cardCounts(t)) {
        const other = taken.get(n);
        if (other === undefined) taken.set(n, name);
        else if (other !== name && (changed.has(name) || changed.has(other))) {
          const mine = changed.has(name) ? name : other;
          out.push({
            field: `${at}.${mine}.per_gpu_count`,
            reason: `role ${role} would have two templates for ${n} card(s) (${other} and ${name})`,
          });
        }
      }
    }
  }
}

function checkTemplateOverrides(
  value: unknown,
  decls: Record<string, TemplateOverridable>,
  resource: unknown,
  at: string,
  out: OverrideProblem[],
  patterns: PatternJob[],
): Record<string, TemplateOverrideValues> | undefined {
  const { templates, roles } = manifestTemplates(resource);
  if (!isPlainObject(value) || Object.keys(value).length === 0) {
    out.push({ field: at, reason: "must be an object of template name to values, naming at least one template" });
    return undefined;
  }
  const entries: Array<[string, TemplateOverrideValues]> = [];
  for (const [name, given] of Object.entries(value)) {
    const tat = `${at}.${name}`;
    const rule = TEMPLATE_NAME_RE.test(name) && Object.hasOwn(decls, name) ? decls[name]! : undefined;
    if (!rule) {
      out.push({ field: tat, reason: "the plugin does not declare this template overridable" });
      continue;
    }
    const template = templates.get(name);
    if (!template) {
      out.push({ field: tat, reason: "the app manifest has no sandbox template of this name" });
      continue;
    }
    if (!isPlainObject(given) || Object.keys(given).length === 0) {
      out.push({ field: tat, reason: "must be an object naming at least one of fromImage, per_gpu_count and resources" });
      continue;
    }
    const before = out.length;
    const tv: TemplateOverrideValues = {};
    for (const key of Object.keys(given)) {
      if (!(TEMPLATE_KEYS as readonly string[]).includes(key)) {
        out.push({ field: `${tat}.${key}`, reason: "unknown key (expected fromImage, per_gpu_count or resources)" });
      } else if (rule[key as (typeof TEMPLATE_KEYS)[number]] === undefined) {
        out.push({ field: `${tat}.${key}`, reason: "the plugin does not declare this overridable for the template" });
      }
    }
    if (given.fromImage !== undefined && rule.fromImage) {
      const v = checkStringValue(given.fromImage, rule.fromImage, `${tat}.fromImage`, out, patterns);
      if (v !== undefined) tv.fromImage = v;
    }
    if (given.per_gpu_count !== undefined && rule.per_gpu_count) {
      const n = given.per_gpu_count;
      const r = rule.per_gpu_count;
      if (!isCardCount(n)) out.push({ field: `${tat}.per_gpu_count`, reason: `must be an integer from 1 to ${OVERRIDE_LIMITS.maxGpuCount}` });
      else if (r.enum && !r.enum.includes(n)) out.push({ field: `${tat}.per_gpu_count`, reason: `must be one of ${r.enum.join(", ")}` });
      else if ((r.minimum !== undefined && n < r.minimum) || (r.maximum !== undefined && n > r.maximum)) {
        out.push({ field: `${tat}.per_gpu_count`, reason: `must be from ${r.minimum ?? 1} to ${r.maximum ?? OVERRIDE_LIMITS.maxGpuCount}` });
      } else tv.per_gpu_count = n;
    }
    if (given.resources !== undefined && rule.resources) {
      const r = checkTemplateResources(given.resources, rule.resources, `${tat}.resources`, out);
      if (r !== undefined) tv.resources = r;
    }
    if (out.length > before) continue;
    // What the template is with these values: a request above its limit, or a
    // shared memory the container cannot hold, would only be refused later, by
    // Agent Sandbox, after the run was admitted.
    effectiveTemplateProblems(applyTemplateOverride(template, tv), tv, tat, out);
    entries.push([name, tv]);
  }
  const recounted = entries.filter(([, tv]) => tv.per_gpu_count !== undefined);
  if (recounted.length > 0) {
    const effective = new Map(templates);
    for (const [name, tv] of recounted) effective.set(name, { ...templates.get(name)!, per_gpu_count: [tv.per_gpu_count!] });
    cardCountCollisions(effective, new Set(recounted.map(([name]) => name)), roles, at, out);
  }
  return Object.fromEntries(entries);
}

function checkTemplateResources(
  value: unknown,
  rule: TemplateResourcesRule,
  at: string,
  out: OverrideProblem[],
): TemplateResourceValues | undefined {
  if (!isPlainObject(value) || Object.keys(value).length === 0) {
    out.push({ field: at, reason: "must be an object naming at least one of requests, limits and sharedMemory" });
    return undefined;
  }
  const before = out.length;
  checkKeys(value, ["requests", "limits", "sharedMemory"], at, out);
  const res: TemplateResourceValues = {};
  const bounded = (q: unknown, max: QuantityMax | undefined, qat: string): string | undefined => {
    if (!max) {
      out.push({ field: qat, reason: "the plugin declares no maximum for this resource" });
      return undefined;
    }
    const n = quantityOf(q);
    if (n === undefined) {
      out.push({ field: qat, reason: QUANTITY_TEXT });
      return undefined;
    }
    if (n > quantityOf(max.max)!) {
      out.push({ field: qat, reason: `must be at most ${max.max}` });
      return undefined;
    }
    return q as string;
  };
  for (const side of ["requests", "limits"] as const) {
    const list = value[side];
    if (list === undefined) continue;
    if (!isPlainObject(list) || Object.keys(list).length === 0) {
      out.push({ field: `${at}.${side}`, reason: "must be an object of resource name to quantity, naming at least one" });
      continue;
    }
    const entries: Array<[string, string]> = [];
    for (const [name, q] of Object.entries(list)) {
      const key = RESOURCE_RULE_KEY[name];
      if (!key) {
        out.push({ field: `${at}.${side}.${name}`, reason: "only cpu, memory and ephemeral-storage may be set" });
        continue;
      }
      const v = bounded(q, rule[key], `${at}.${side}.${name}`);
      if (v !== undefined) entries.push([name, v]);
    }
    res[side] = Object.fromEntries(entries);
  }
  if (value.sharedMemory !== undefined) {
    const v = bounded(value.sharedMemory, rule.sharedMemory, `${at}.sharedMemory`);
    if (v !== undefined) res.sharedMemory = v;
  }
  return out.length > before ? undefined : res;
}

/** Where a template's container fields live: inside `template` in the wrapped form, else at its top (as Agent Sandbox reads it). */
function containerOf(t: Record<string, unknown>): Record<string, unknown> {
  const nested = t.template;
  const named = (v: unknown) => typeof v === "string" && v !== "";
  if (isPlainObject(nested) && (named(nested.fromImage) || !named(t.fromImage))) return nested;
  return t;
}

/**
 * One template with a launch's values applied. `per_gpu_count` becomes the
 * template's only card count; `fromImage` and `resources` are written where
 * Agent Sandbox reads them (inside `template` when the template is in that
 * form); each given request or limit replaces that one entry, and
 * `sharedMemory` is the template's `gpu.sharedMemory`. The input is not changed.
 */
export function applyTemplateOverride(template: Record<string, unknown>, v: TemplateOverrideValues): Record<string, unknown> {
  const out: Record<string, unknown> = structuredClone(template);
  if (v.per_gpu_count !== undefined) out.per_gpu_count = [v.per_gpu_count];
  const container = containerOf(out);
  if (v.fromImage !== undefined) container.fromImage = v.fromImage;
  const r = v.resources;
  if (r?.requests || r?.limits) {
    const current = isPlainObject(container.resources) ? container.resources : {};
    const merged: Record<string, unknown> = { ...current };
    for (const side of ["requests", "limits"] as const) {
      if (!r[side]) continue;
      merged[side] = Object.fromEntries([
        ...Object.entries(isPlainObject(current[side]) ? current[side] : {}),
        ...Object.entries(r[side]),
      ]);
    }
    container.resources = merged;
  }
  if (r?.sharedMemory !== undefined) {
    out.gpu = { ...(isPlainObject(out.gpu) ? out.gpu : {}), sharedMemory: r.sharedMemory };
  }
  return out;
}

/**
 * Agent Sandbox's memory, per card, for a GPU template that sets no memory
 * request or limit (it scales with the card count). Shared memory is charged to
 * the container's memory, so it is what a `sharedMemory` is held to there.
 */
export const SANDBOX_DEFAULT_MEMORY_PER_CARD = "224Gi";

/**
 * What the effective template could not run with, for the values a launch gave.
 * Resolved as Agent Sandbox resolves it: a resource set on one side only has
 * that value on both; memory set on neither is the per-card default times the
 * card count.
 */
function effectiveTemplateProblems(t: Record<string, unknown>, v: TemplateOverrideValues, at: string, out: OverrideProblem[]): void {
  const r = v.resources;
  if (!r && v.per_gpu_count === undefined) return;
  const resources = containerOf(t).resources;
  const list = (side: string): Record<string, unknown> => {
    const l = isPlainObject(resources) ? resources[side] : undefined;
    return isPlainObject(l) ? l : {};
  };
  const requests = list("requests");
  const limits = list("limits");
  for (const name of RESOURCE_NAMES) {
    if (r?.requests?.[name] === undefined && r?.limits?.[name] === undefined) continue;
    const req = quantityOf(requests[name]);
    const lim = quantityOf(limits[name]);
    if (req !== undefined && lim !== undefined && req > lim) {
      const side = r?.requests?.[name] !== undefined ? "requests" : "limits";
      out.push({ field: `${at}.resources.${side}.${name}`, reason: `the request ${String(requests[name])} exceeds the limit ${String(limits[name])}` });
    }
  }
  const cards = Array.isArray(t.per_gpu_count) ? t.per_gpu_count.filter((c): c is number => isCardCount(c)) : [];
  // The field a shared-memory problem is named by: the launch value that made it one.
  const shmAt = r?.sharedMemory !== undefined ? `${at}.resources.sharedMemory`
    : r?.limits?.memory !== undefined ? `${at}.resources.limits.memory`
    : r?.requests?.memory !== undefined ? `${at}.resources.requests.memory`
    : `${at}.per_gpu_count`;
  if (r?.sharedMemory !== undefined && cards.length === 0) {
    out.push({ field: shmAt, reason: "applies only to a template with per_gpu_count" });
    return;
  }
  // The memory of the launch's own values or of the card count it sets now bounds the template's shared memory.
  const touchesMemory = r?.sharedMemory !== undefined || v.per_gpu_count !== undefined
    || r?.requests?.memory !== undefined || r?.limits?.memory !== undefined;
  const gpu = isPlainObject(t.gpu) ? t.gpu : undefined;
  if (!touchesMemory || gpu?.sharedMemory === undefined || cards.length === 0) return;
  const shm = quantityOf(gpu.sharedMemory);
  if (shm === undefined) return; // the manifest validator names a malformed value
  const memory = limits.memory ?? requests.memory;
  if (memory !== undefined) {
    const mem = quantityOf(memory);
    if (mem !== undefined && shm > mem) {
      out.push({ field: shmAt, reason: `shared memory ${String(gpu.sharedMemory)} exceeds the memory limit ${String(memory)}` });
    }
    return;
  }
  const fewest = Math.min(...cards);
  const mem = quantityOf(SANDBOX_DEFAULT_MEMORY_PER_CARD)! * BigInt(fewest);
  if (shm > mem) {
    out.push({
      field: shmAt,
      reason: `shared memory ${String(gpu.sharedMemory)} exceeds the memory limit of ${fewest} card(s) (${SANDBOX_DEFAULT_MEMORY_PER_CARD} per card when the template sets no memory); give a memory limit`,
    });
  }
}

/** Whether any value was given. */
export function hasOverrides(v: OverrideValues): boolean {
  return Object.keys(v).length > 0;
}

/**
 * The manifest an app run gets: the plugin's, with the checked overrides applied.
 * `env` and the model's env names are merged over the manifest's env, `args` are
 * appended to `command`, `image` becomes the container's default image, and each
 * named template gets its values (see applyTemplateOverride).
 * The input is not changed.
 */
export function applyAppOverrides<M extends {
  command: string[];
  env?: Record<string, string>;
  container: { image?: string };
  sandbox_templates?: Array<{ name: string; [field: string]: unknown }>;
}>(
  manifest: M,
  values: OverrideValues,
  decl: OverridableDeclaration,
): M {
  if (!hasOverrides(values)) return manifest;
  // Built from entries (later ones win), never by assigning to a caller-named key.
  const model = values.model;
  const env: Record<string, string> = Object.fromEntries([
    ...Object.entries(manifest.env ?? {}),
    ...(model !== undefined ? (decl.model?.env ?? []).filter(isEnvName).map((name): [string, string] => [name, model]) : []),
    ...Object.entries(values.env ?? {}).filter(([name]) => isEnvName(name)),
  ]);
  const out: M = {
    ...manifest,
    command: values.args ? [...manifest.command, ...values.args] : [...manifest.command],
    container: values.image !== undefined ? { ...manifest.container, image: values.image } : { ...manifest.container },
  };
  if (Object.keys(env).length > 0 || manifest.env !== undefined) out.env = env;
  const templates = values.sandbox_templates;
  if (templates && manifest.sandbox_templates) {
    out.sandbox_templates = manifest.sandbox_templates.map((t) => {
      const v = Object.hasOwn(templates, t.name) ? templates[t.name] : undefined;
      return v ? applyTemplateOverride(t, v) as typeof t : t;
    });
  }
  return out;
}

/** What is written down about an applied override: on the task's metadata, and (keys only) in the log. */
export function overridesAudit(values: OverrideValues, plugin: { id: unknown; version?: unknown }): Record<string, unknown> {
  return {
    plugin_id: Number(plugin.id),
    plugin_version: plugin.version === undefined || plugin.version === null ? null : String(plugin.version),
    values,
  };
}

/** The keys an override set, for a log line that must not carry values. */
export function overrideKeys(values: OverrideValues): string[] {
  const keys: string[] = [];
  for (const k of ["image", "model", "args"] as const) if (values[k] !== undefined) keys.push(k);
  for (const name of Object.keys(values.env ?? {})) keys.push(`env.${name}`);
  for (const [name, v] of Object.entries(values.sandbox_templates ?? {})) {
    for (const k of TEMPLATE_KEYS) if (v[k] !== undefined) keys.push(`sandbox_templates.${name}.${k}`);
  }
  return keys;
}
