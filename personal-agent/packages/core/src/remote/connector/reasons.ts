// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * What a connector's refusal means for a person, and what fixes it.
 *
 * A connector ends a session it cannot open or keep safe with `session_closed {reason}`, ends a turn it could not run with
 * `turn_end {stopReason: "error", error}`, and refuses a command with `command_rejected {type, reason}`. The reason is a code
 * ("mode_unavailable", "cwd_outside_roots"), which on its own tells a person on a phone nothing. `describe` turns it into one
 * sentence of what happened and one of what to do, in the person's language. A code that is not in the catalog gets a generic
 * sentence that names it; a reason that is not a code (words an older connector wrote) is shown as it is.
 */
import { connectorReasonHints, connectorReasonText } from "../../locales/connector-reasons.js";
import type { Lang } from "../../locales/lang.js";
import { Setup, UPGRADE_COMMAND } from "./setup.js";

/** A sentence in both languages: [Chinese, English]. */
export type Pair = readonly [zh: string, en: string];

/** The release whose Claude agent runs as root with `approval = "never"`; an older connector there refuses every new session. */
export const FIXED_IN: readonly [number, number, number] = [0, 1, 5];

const CODE = /^[a-z][a-z0-9_]{0,63}$/u;
const VERSION = /^v?(\d+)\.(\d+)\.(\d+)/u;

const both = (fn: (lang: Lang) => string): Pair => [fn("zh"), fn("en")];

/** The one upgrade command: it installs the new version and restarts the connector on it, under whichever supervisor it has. */
export const UPGRADE: Pair = both((lang) => connectorReasonHints.in(lang).upgrade({ command: UPGRADE_COMMAND }));
export const SANDBOX: Pair = both((lang) => connectorReasonHints.in(lang).sandbox);
export const STATUS: Pair = both((lang) => connectorReasonHints.in(lang).status);

/** Codes an older connector hits on a root machine with `approval = "never"`: an upgrade fixes them (see `FIXED_IN`). */
export const OLD_CONNECTOR: ReadonlySet<string> = new Set(["mode_unavailable", "mode_not_enforced"]);

// Codes that end on a new-session hint / a retry hint, after their sentence.
const THEN_NEW: ReadonlySet<string> = new Set([
  "adapter_gone",
  "adapter_cannot_resume",
  "unknown_session",
  "resume_not_supported",
  "session_closed",
  "set_mode_failed",
  "machine_reconnected",
]);
const THEN_RETRY: ReadonlySet<string> = new Set(["catalog_unavailable", "twin_check_failed", "adapter_unavailable"]);

const KNOWN: ReadonlySet<string> = new Set(Object.keys(connectorReasonText.in("en")));

/** Every code that has a sentence of its own. */
export function knownReasons(): string[] {
  return [...KNOWN];
}

/** `0.1.4` (or `v0.1.4`, `0.1.5-rc.1`) as [major, minor, patch]; null for anything else. */
export function parseVersion(value: unknown): [number, number, number] | null {
  const match = VERSION.exec(typeof value === "string" ? value.trim() : "");
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

function older(version: readonly number[], than: readonly number[]): boolean {
  for (let i = 0; i < than.length; i++) {
    const a = version[i] ?? 0;
    const b = than[i] ?? 0;
    if (a !== b) return a < b;
  }
  return false;
}

export function isCode(reason: string): boolean {
  return CODE.test(reason);
}

function sentence(code: string, lang: Lang, setup: Setup): string {
  const text = connectorReasonText.in(lang)[code as keyof ReturnType<typeof connectorReasonText.in>];
  return code === "revoked" ? text.replaceAll("{login}", setup.login()) : text;
}

/** What follows a known code's sentence: the upgrade (or status) for an old-connector code, a new-session or retry hint. */
function hintAfter(code: string, lang: Lang, version: unknown): { sep: string; hint: string } | null {
  const hints = connectorReasonHints.in(lang);
  if (OLD_CONNECTOR.has(code)) {
    const parsed = parseVersion(version);
    if (parsed === null || older(parsed, FIXED_IN))
      return { sep: "\n\n", hint: `${hints.upgrade({ command: UPGRADE_COMMAND })}\n\n${hints.sandbox}\n\n` };
    return { sep: " ", hint: hints.status }; // (a fixed connector refused anyway: not the root case)
  }
  if (THEN_NEW.has(code)) return { sep: " ", hint: hints.newSession };
  if (THEN_RETRY.has(code)) return { sep: " ", hint: hints.retry };
  return null;
}

/**
 * [Chinese, English] for one reason code: what happened and what to do. An unknown code gets a generic pair that names it.
 * `setup`: the commands of the address this worker reaches Claw at (the login a revoked connector is given).
 */
export function explain(code: string, version: unknown = null, setup: Setup = new Setup("", null)): Pair {
  if (!KNOWN.has(code)) return both((lang) => connectorReasonHints.in(lang).unknown({ code }));
  return both((lang) => {
    const after = hintAfter(code, lang, version);
    const own = sentence(code, lang, setup);
    return after ? `${own}${after.sep}${after.hint}` : own;
  });
}

/** A reason as given: trimmed, without the full stops at its end. */
export function bareReason(reason: string | null | undefined): string {
  return (reason ?? "").trim().replace(/\.+$/u, "").trim();
}

function inLang(lang: Lang | null, pair: Pair): string {
  if (lang === "zh") return pair[0];
  if (lang === "en") return pair[1];
  return `${pair[0]}\n${pair[1]}`;
}

/**
 * The sentence(s) for a reason a connector gave, in `lang` (null: Chinese, then English on the next line). '' for no reason. A
 * reason that is not a code (words, or an internal error withheld) is kept as it is, as a sentence.
 */
export function describe(
  reason: string | null | undefined,
  lang: Lang | null,
  version: unknown = null,
  setup?: Setup,
): string {
  const bare = bareReason(reason);
  if (!bare) return "";
  if (!isCode(bare)) return `${bare}.`;
  return inLang(lang, explain(bare, version, setup));
}

/** `lead` ("the session could not start") with the reason after it, as one paragraph in `lang` (null: both, one per line). */
export function ended(
  lead: Pair,
  reason: string | null | undefined,
  lang: Lang | null,
  version: unknown = null,
  setup?: Setup,
): string {
  if (lang === null) return (["zh", "en"] as const).map((one) => ended(lead, reason, one, version, setup)).join("\n");
  const why = describe(reason, lang, version, setup);
  const hints = connectorReasonHints.in(lang);
  const head = inLang(lang, lead);
  return why ? `${head}${hints.leadSep}${why}` : `${head}${hints.leadEnd}`;
}
