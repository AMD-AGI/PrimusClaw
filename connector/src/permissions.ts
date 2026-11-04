// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/** Permission requests waiting for a person: what was offered, what may be answered, and when to give up. */
import { randomUUID } from "node:crypto";
import type { AutoAllowRule } from "./config.js";
import { globMatches } from "./glob.js";
import { relativeInside } from "./roots.js";
import { isObject, truncateBytes } from "./util.js";

export interface OfferedOption {
  optionId: string;
  name: string;
  /** ACP's classification: allow_once, allow_always, reject_once, reject_always. Carried through, never interpreted here beyond auto-allow. */
  kind: string;
}

/** Only strings the adapter actually sent, as plain data. The option ids are the adapter's own: they are passed through verbatim and never invented. */
export function normalizeOptions(raw: unknown): OfferedOption[] {
  if (!Array.isArray(raw)) return [];
  const out: OfferedOption[] = [];
  for (const o of raw.slice(0, 12)) {
    if (!isObject(o) || typeof o.optionId !== "string" || o.optionId === "") continue;
    out.push({
      optionId: o.optionId,
      name: typeof o.name === "string" ? o.name.slice(0, 200) : o.optionId,
      kind: typeof o.kind === "string" ? o.kind : "allow_once",
    });
  }
  return out;
}

/** The tool input as shown on a phone: the object itself when small, otherwise a cut-down string that says how much was cut. */
export function boundedInput(raw: unknown, max = 4096): unknown {
  if (raw === undefined || raw === null) return null;
  const text = typeof raw === "string" ? raw : JSON.stringify(raw);
  if (Buffer.byteLength(text, "utf8") <= max) return raw;
  return truncateBytes(text, max).text;
}

/** Paths a tool call says it touches: the adapter's `locations`, and the usual path fields of its raw input. */
export function toolPaths(toolCall: Record<string, unknown>): string[] {
  const out: string[] = [];
  if (Array.isArray(toolCall.locations)) for (const l of toolCall.locations) if (isObject(l) && typeof l.path === "string") out.push(l.path);
  if (isObject(toolCall.rawInput)) for (const k of ["file_path", "filePath", "path", "target_file"]) {
    const v = (toolCall.rawInput as Record<string, unknown>)[k];
    if (typeof v === "string") out.push(v);
  }
  return [...new Set(out)];
}

/**
 * The rule that lets this call through without asking, or null. A rule needs the
 * same `kind` and EVERY path the call touches to sit inside the working
 * directory and match the glob. A call that names no path never matches (there
 * is nothing to check the glob against), and neither does one that escapes.
 */
export function matchAutoAllow(rules: AutoAllowRule[], toolCall: Record<string, unknown>, cwd: string): AutoAllowRule | null {
  const kind = typeof toolCall.kind === "string" ? toolCall.kind : "";
  const paths = toolPaths(toolCall);
  if (!kind || paths.length === 0) return null;
  const rel: string[] = [];
  for (const p of paths) {
    const r = relativeInside(p, cwd);
    if (r === null) return null;
    rel.push(r);
  }
  return rules.find((rule) => rule.kind === kind && rel.every((r) => globMatches(rule.pathGlob, r))) ?? null;
}

export type Outcome = { outcome: "selected"; optionId: string } | { outcome: "cancelled" };

export interface PendingPermission {
  actionId: string;
  options: OfferedOption[];
  /** The `permissionRequest` event data, kept so it can be sent again after a reconnect. */
  payload: Record<string, unknown>;
  /** Answer the adapter. `null` means cancelled. */
  settle(optionId: string | null): void;
  timer: NodeJS.Timeout;
}

export type DecideResult = { ok: true; optionId: string } | { ok: false; reason: "unknown_action" | "option_not_offered" };

export class PermissionBook {
  private readonly pending = new Map<string, PendingPermission>();

  constructor(private readonly ttlMs: number, private readonly onExpire: (actionId: string) => void) {}

  get ttl(): number { return this.ttlMs; }

  open(options: OfferedOption[], payload: (actionId: string) => Record<string, unknown>, settle: (optionId: string | null) => void): PendingPermission {
    const actionId = randomUUID();
    const p: PendingPermission = {
      actionId, options, payload: payload(actionId), settle,
      timer: setTimeout(() => {
        if (this.pending.delete(actionId)) { clearTimeout(p.timer); settle(null); this.onExpire(actionId); }
      }, this.ttlMs),
    };
    p.timer.unref?.();
    this.pending.set(actionId, p);
    return p;
  }

  /** Answer with one of the options that were offered; anything else leaves the request pending. */
  decide(actionId: string, optionId: string): DecideResult {
    const p = this.pending.get(actionId);
    if (!p) return { ok: false, reason: "unknown_action" };
    if (!p.options.some((o) => o.optionId === optionId)) return { ok: false, reason: "option_not_offered" };
    this.pending.delete(actionId);
    clearTimeout(p.timer);
    p.settle(optionId);
    return { ok: true, optionId };
  }

  /** Answer every waiting request `cancelled` (a cancel, a close, an adapter that went away). */
  cancelAll(): string[] {
    const ids = [...this.pending.keys()];
    for (const id of ids) {
      const p = this.pending.get(id)!;
      this.pending.delete(id);
      clearTimeout(p.timer);
      p.settle(null);
    }
    return ids;
  }

  list(): PendingPermission[] {
    return [...this.pending.values()];
  }

  get size(): number { return this.pending.size; }
}
