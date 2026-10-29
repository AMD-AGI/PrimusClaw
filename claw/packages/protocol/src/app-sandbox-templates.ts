// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The names of the templates a grant made available, as the application is told
 * them (`env_map.sandbox_templates`).
 *
 * Agent Sandbox stores a run's templates under names of its own making, expanded
 * from the manifest's (DNS-1123 form of the run id, the template name, and `g<N>`
 * for each GPU count in `per_gpu_count`) and returns them in the grant response,
 * as `templates: { <role>: [<name>, ...] }`. The application must use those names
 * exactly, so Claw never derives one: this module only matches each name the
 * service returned to the manifest template and card count it belongs to, and
 * refuses when they do not line up.
 *
 * The value injected is a JSON object, one entry per role the manifest declares:
 *
 *   { "<role>": { "<cards>": "<template name>", ... }, ... }
 *
 * `<cards>` is the GPU count per sandbox, a decimal string. A template with no
 * `per_gpu_count` is registered under its own name with no `g<N>`; it is listed
 * under the card count it declares in `gpus`, or `"0"` when it declares none.
 * The variable is injected only when a grant was issued (a manifest with no
 * `sandbox_roles` gets none), and the object is stored on the run so a Brain
 * taking the run over injects the same names.
 */
import type { AppManifestV1 } from "./app-manifest.js";
import { APP_SANDBOX_ROLES } from "./app-manifest.js";

/** `{ role: { cards: templateName } }`. */
export type AppSandboxTemplateEnv = Record<string, Record<string, string>>;

/** What the grant service returned: the names it stored, by role. */
export type GrantedTemplateNames = Record<string, string[]>;

export class SandboxTemplateMappingError extends Error {
  constructor(message: string) {
    super(`sandbox templates: ${message}`);
    this.name = "SandboxTemplateMappingError";
  }
}

/** Lower-case, every character outside [a-z0-9] replaced by `-`: how the service spells a template inside a name. */
function dnsPart(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]/g, "-");
}

/** The `templates` of a grant response, or undefined when it has none of the expected shape. */
export function grantedTemplateNamesOf(body: unknown): GrantedTemplateNames | undefined {
  if (!body || typeof body !== "object") return undefined;
  const raw = (body as { templates?: unknown }).templates;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const out: GrantedTemplateNames = {};
  for (const [role, names] of Object.entries(raw as Record<string, unknown>)) {
    if (!Array.isArray(names) || !names.every((n) => typeof n === "string" && n.length > 0)) return undefined;
    out[role] = names as string[];
  }
  return out;
}

/** The fields of a template the mapping reads; the manifest's own or the copy the grant sent. */
export type SandboxTemplateDef = { name?: unknown; per_gpu_count?: unknown; gpus?: unknown };

/** The card counts a template is registered for, with the name suffix each carries. */
function expectedEntries(t: SandboxTemplateDef): Array<{ cards: number; suffix: string }> {
  const base = `-${dnsPart(String(t.name))}`;
  const counts = Array.isArray(t.per_gpu_count) && t.per_gpu_count.length > 0 ? (t.per_gpu_count as number[]) : undefined;
  if (counts) return counts.map((cards) => ({ cards, suffix: `${base}-g${cards}` }));
  const gpus = typeof t.gpus === "number" && Number.isInteger(t.gpus) && t.gpus >= 0 ? t.gpus : 0;
  return [{ cards: gpus, suffix: base }];
}

/**
 * The prefix every returned name of a role shares: the one for which each expected
 * suffix is present as `prefix + suffix`. Throws when no prefix, or more than one,
 * accounts for all of them.
 */
function runPrefix(role: string, names: string[], suffixes: string[]): string {
  const first = suffixes[0];
  if (first === undefined) return "";
  const candidates = new Set<string>();
  for (const n of names) {
    if (!n.endsWith(first)) continue;
    const prefix = n.slice(0, n.length - first.length);
    if (suffixes.every((sfx) => names.includes(prefix + sfx))) candidates.add(prefix);
  }
  if (candidates.size === 1) return [...candidates][0]!;
  // Nothing lines up: report the first entry that has no name, as before.
  const missing = suffixes.find((sfx) => !names.some((n) => n.endsWith(sfx)));
  if (candidates.size === 0) {
    throw new SandboxTemplateMappingError(
      `role ${role}: no run prefix is shared by the returned names${missing ? ` (nothing ends with ${missing})` : ""}`,
    );
  }
  throw new SandboxTemplateMappingError(`role ${role}: the returned names carry more than one run prefix`);
}

/**
 * The application's template map, from the manifest and the names the grant
 * response returned. Throws {@link SandboxTemplateMappingError} when a role's
 * response is missing, a template or card count has no name, two would take one
 * slot, or the response carries a name nothing in the manifest accounts for.
 * Nothing is guessed.
 */
export function buildSandboxTemplateEnv(
  manifest: Pick<AppManifestV1, "sandbox_roles"> & { sandbox_templates?: ReadonlyArray<SandboxTemplateDef> },
  granted: GrantedTemplateNames | undefined,
): AppSandboxTemplateEnv {
  const out: AppSandboxTemplateEnv = {};
  const defs = new Map((manifest.sandbox_templates ?? []).map((t) => [t.name, t] as const));
  for (const role of APP_SANDBOX_ROLES) {
    const listed = manifest.sandbox_roles?.[role];
    if (!listed || listed.length === 0) continue;
    const names = granted?.[role];
    if (!names) throw new SandboxTemplateMappingError(`the grant response has no templates for role ${role}`);
    const unused = new Set(names);
    const entries: Record<string, string> = {};
    // Every name is `<prefix><suffix>` with one prefix for the whole role, so the
    // match is anchored: a name that merely ends with a suffix (`w1-gpu-runner`
    // ends with `-runner`) is not that template's unless the prefixes agree.
    const wanted: Array<{ templateName: string; cards: number; suffix: string }> = [];
    for (const templateName of listed) {
      const def = defs.get(templateName);
      if (!def) throw new SandboxTemplateMappingError(`role ${role} names template ${templateName}, which the manifest does not define`);
      for (const { cards, suffix } of expectedEntries(def)) wanted.push({ templateName, cards, suffix });
    }
    const prefix = runPrefix(role, names, wanted.map((w) => w.suffix));
    for (const { templateName, cards, suffix } of wanted) {
      const matches = names.filter((n) => n === prefix + suffix);
      if (matches.length !== 1) {
        throw new SandboxTemplateMappingError(
          `role ${role}: template ${templateName} for ${cards} card(s) matches ${matches.length} returned name(s), expected exactly 1`,
        );
      }
      const key = String(cards);
      if (entries[key] !== undefined) throw new SandboxTemplateMappingError(`role ${role}: two templates take ${cards} card(s)`);
      entries[key] = matches[0]!;
      unused.delete(matches[0]!);
    }
    if (unused.size > 0) throw new SandboxTemplateMappingError(`role ${role}: the grant response names ${unused.size} template(s) the manifest does not account for`);
    out[role] = entries;
  }
  if (Object.keys(out).length === 0) throw new SandboxTemplateMappingError("the manifest declares no sandbox role");
  return out;
}
