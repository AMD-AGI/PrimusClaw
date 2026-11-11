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
 *
 * This module is pure (no database, no I/O) so the write path (db.ts) and every
 * launch path read the same rules.
 */
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

export interface OverridableDeclaration {
  image?: { enum?: string[]; description?: string };
  model?: StringRule & { env?: string[] };
  args?: { type?: "array"; items?: StringRule; maxItems?: number; description?: string };
  env?: Record<string, StringRule>;
}

/** A launch's requested values, after they were checked. */
export interface OverrideValues {
  image?: string;
  model?: string;
  args?: string[];
  env?: Record<string, string>;
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
} as const;

/** The variable names an app manifest accepts; the manifest validator has the last word on reserved names. */
const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const TOP_KEYS = new Set(["image", "model", "args", "env"]);

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
  if (!Array.isArray(v) || v.length === 0 || v.length > OVERRIDE_LIMITS.maxEnumEntries
    || !v.every((e) => typeof e === "string" && e.trim() !== "" && e.length <= OVERRIDE_LIMITS.maxValueLength)) {
    out.push({ field: `${at}.enum`, reason: `must be 1-${OVERRIDE_LIMITS.maxEnumEntries} non-empty strings` });
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
      try {
        new RegExp(v.pattern, "u");
      } catch {
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
    if (!TOP_KEYS.has(k)) out.push({ field: `overridable.${k}`, reason: "unknown key (expected image, model, args or env)" });
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
      || !env.every((n) => typeof n === "string" && ENV_NAME_RE.test(n)))) {
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
        if (!ENV_NAME_RE.test(name)) out.push({ field: `overridable.env.${name}`, reason: "is not an environment variable name" });
        else checkStringRule(v.env[name], `overridable.env.${name}`, out);
      }
    }
  }
  return out;
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

function checkStringValue(value: unknown, rule: StringRule, at: string, out: OverrideProblem[]): string | undefined {
  if (typeof value !== "string" || value === "") {
    out.push({ field: at, reason: "must be a non-empty string" });
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
  if (rule.pattern && !new RegExp(rule.pattern, "u").test(value)) {
    out.push({ field: at, reason: "does not match the pattern the plugin declares" });
    return undefined;
  }
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
  app: new Set(["image", "model", "args", "env"]),
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
  plugin: { overridable?: unknown; images?: unknown },
  surface: OverrideSurface,
): { ok: true; values: OverrideValues } | { ok: false; problems: OverrideProblem[] } {
  if (requested === undefined || requested === null) return { ok: true, values: {} };
  if (!isPlainObject(requested)) return { ok: false, problems: [{ field: "overrides", reason: "must be an object" }] };
  const decl = storedOverridable(plugin.overridable);
  const out: OverrideProblem[] = [];
  const values: OverrideValues = {};
  for (const key of Object.keys(requested)) {
    const at = `overrides.${key}`;
    if (!TOP_KEYS.has(key)) {
      out.push({ field: at, reason: "unknown key (expected image, model, args or env)" });
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
      const v = checkStringValue(value, { maxLength: OVERRIDE_LIMITS.maxValueLength }, at, out);
      if (v !== undefined) {
        if (allowed.includes(v)) values.image = v;
        else out.push({ field: at, reason: "is not one of the plugin's images" });
      }
    } else if (k === "model") {
      if (surface === "app" && !(decl.model!.env && decl.model!.env.length > 0)) {
        out.push({ field: at, reason: "the plugin names no env variable that carries the model of an app run" });
        continue;
      }
      const v = checkStringValue(value, decl.model!, at, out);
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
        const v = checkStringValue(a, rule.items ?? {}, `${at}[${i}]`, out);
        if (v !== undefined) args.push(v);
      });
      if (args.length === value.length) values.args = args;
    } else {
      if (!isPlainObject(value)) {
        out.push({ field: at, reason: "must be an object of variable name to value" });
        continue;
      }
      const env: Record<string, string> = {};
      for (const [name, v] of Object.entries(value)) {
        const rule = Object.hasOwn(decl.env!, name) ? decl.env![name] : undefined;
        if (!rule) {
          out.push({ field: `${at}.${name}`, reason: "the plugin does not declare this variable overridable" });
          continue;
        }
        const s = checkStringValue(v, rule, `${at}.${name}`, out);
        if (s !== undefined) env[name] = s;
      }
      values.env = env;
    }
  }
  if (out.length > 0) return { ok: false, problems: out };
  return { ok: true, values };
}

/** Whether any value was given. */
export function hasOverrides(v: OverrideValues): boolean {
  return Object.keys(v).length > 0;
}

/**
 * The manifest an app run gets: the plugin's, with the checked overrides applied.
 * `env` and the model's env names are merged over the manifest's env, `args` are
 * appended to `command`, and `image` becomes the container's default image.
 * The input is not changed.
 */
export function applyAppOverrides<M extends { command: string[]; env?: Record<string, string>; container: { image?: string } }>(
  manifest: M,
  values: OverrideValues,
  decl: OverridableDeclaration,
): M {
  if (!hasOverrides(values)) return manifest;
  const env: Record<string, string> = { ...(manifest.env ?? {}) };
  if (values.model !== undefined) for (const name of decl.model?.env ?? []) env[name] = values.model;
  if (values.env) Object.assign(env, values.env);
  const out: M = {
    ...manifest,
    command: values.args ? [...manifest.command, ...values.args] : [...manifest.command],
    container: values.image !== undefined ? { ...manifest.container, image: values.image } : { ...manifest.container },
  };
  if (Object.keys(env).length > 0 || manifest.env !== undefined) out.env = env;
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
  return keys;
}
