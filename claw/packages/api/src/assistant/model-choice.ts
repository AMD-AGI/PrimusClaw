// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Which model an assistant item runs on: one function decides it (`resolveItemModel`), for a task item's worker and a review item alike.
 *
 * In order, the first that names a model wins:
 *
 *   1. the model asked for in the message, for this item (the router's `model` argument, or the request's `model` field);
 *   2. the payer's own default for this kind of item (`review_model`, reviews only);
 *   3. the payer's own default (`default_model`);
 *   4. the deployment's default for the kind (`CLAW_ASSISTANT_WORKER_MODEL` for a task, `CLAW_ASSISTANT_REVIEW_MODEL` for a review);
 *   5. nothing: the session names no model and Brain runs its `DEFAULT_MODEL`.
 *
 * The payer is whose key the item runs on: the user for their own items, the reviewer for a review someone else asked of them. A review
 * asked of someone else runs on that person's settings, and the model the requester named is set aside (the caller says so).
 *
 * Every name is checked against the allow-list (`CLAW_ASSISTANT_MODELS`): one that is not on it is refused, with the list, so the router
 * can pick again. A model that is not the deployment's default for the kind is also asked of the gateway with the payer's own key
 * (`GET /models`, cached five minutes per key). A key that cannot use it gets `CLAW_FALLBACK_MODEL` (when that is allowed and usable),
 * else the deployment's default, and the answer says which model it fell back from. When the gateway cannot be asked, a model the
 * user named is refused (nobody can say whether it would run), and a default runs unchecked: the turn's own failure is then the
 * answer (`model-fallback.ts`).
 *
 * The router's model is the deployment's (`CLAW_ASSISTANT_ROUTER_MODEL`) and nothing here changes it.
 *
 * All of it only with `CLAW_ASSISTANT_MODEL_CHOICE` on and a non-empty allow-list; otherwise nothing calls this module and the
 * table it reads does not exist.
 */
import { randomBytes, webcrypto } from "node:crypto";
import pino from "pino";
import { gatewayModelsRequest } from "../auth/byok.js";
import {
  ASSISTANT_DEPLOYMENT_MODEL, CLAW_ASSISTANT_ENABLED, CLAW_ASSISTANT_MODEL_CHOICE, CLAW_ASSISTANT_MODELS, CLAW_ASSISTANT_REVIEW_MODEL,
  CLAW_ASSISTANT_WORKER_MODEL, CLAW_FALLBACK_MODEL, reportSettingProblem,
} from "../config.js";
import type { Querier } from "../infra/db.js";
import { toModelList } from "../routes/models.js";
import { parseSessionModel } from "../sessions/session-model.js";
import { getUpstreamJson } from "../shared/upstream.js";

const logger = pino({ name: "assistant-model-choice" });

export type ItemKind = "task" | "review";

export interface AllowedModel { name: string; label: string }

/** `name=label,name=label`: a name the session-model check refuses is dropped and reported at startup. */
export function parseModelAllowList(raw: string): AllowedModel[] {
  const out: AllowedModel[] = [];
  const seen = new Set<string>();
  for (const part of raw.split(",")) {
    const entry = part.trim();
    if (!entry) continue;
    const eq = entry.indexOf("=");
    const name = (eq < 0 ? entry : entry.slice(0, eq)).trim();
    const label = (eq < 0 ? "" : entry.slice(eq + 1)).replace(/[\u0000-\u001f\u007f]+/g, " ").trim().slice(0, 40);
    const parsed = parseSessionModel(name);
    if (!parsed.ok || !parsed.model) {
      reportSettingProblem(`CLAW_ASSISTANT_MODELS entry ${JSON.stringify(name.slice(0, 64))} is not a model name; left out`);
      continue;
    }
    if (seen.has(parsed.model)) continue;
    seen.add(parsed.model);
    out.push({ name: parsed.model, label });
  }
  return out;
}

const ALLOWED: readonly AllowedModel[] = parseModelAllowList(CLAW_ASSISTANT_MODELS);

/** Whether model choice is on: the switch, the assistant, and at least one model to choose from. */
export function modelChoiceOn(): boolean {
  return CLAW_ASSISTANT_MODEL_CHOICE && CLAW_ASSISTANT_ENABLED && ALLOWED.length > 0;
}

export function allowedModels(): readonly AllowedModel[] {
  return ALLOWED;
}

export function isAllowedModel(name: string): boolean {
  return ALLOWED.some((m) => m.name === name);
}

/** The deployment's default for the kind, or null when the kind has none (Brain's `DEFAULT_MODEL` then). */
export function platformKindModel(kind: ItemKind): string | null {
  return (kind === "review" ? CLAW_ASSISTANT_REVIEW_MODEL : CLAW_ASSISTANT_WORKER_MODEL) || null;
}

/** What a turn of the kind runs on when nothing else names a model: the kind's default, else the deployment's. */
export function platformModel(kind: ItemKind): string | null {
  return platformKindModel(kind) || ASSISTANT_DEPLOYMENT_MODEL || null;
}

/** The fallback, when it is one of the allowed models; null otherwise. */
export function fallbackModel(): string | null {
  return CLAW_FALLBACK_MODEL && isAllowedModel(CLAW_FALLBACK_MODEL) ? CLAW_FALLBACK_MODEL : null;
}

/** A refusal the router (or the HTTP caller) can act on: what was wrong, and the models it may name instead. */
export class ModelChoiceRefused extends Error {
  constructor(readonly code: "model_not_allowed" | "model_unverifiable", message: string, readonly data: Record<string, unknown>) {
    super(message);
    this.name = "ModelChoiceRefused";
  }
}

// --- The user's defaults ----------------------------------------------------------------------------------------------

export interface ModelPrefs { default_model: string | null; review_model: string | null; updated_at: Date | null }

const NO_PREFS: ModelPrefs = { default_model: null, review_model: null, updated_at: null };

export async function readModelPrefs(q: Querier, userId: string): Promise<ModelPrefs> {
  const row = (await q("SELECT default_model, review_model, updated_at FROM claw_user_model_prefs WHERE user_id = $1", [userId])).rows[0] as
    ModelPrefs | undefined;
  return row ? { default_model: row.default_model ?? null, review_model: row.review_model ?? null, updated_at: row.updated_at ?? null } : NO_PREFS;
}

/**
 * Set one or both of the user's defaults; a field left out is kept, `null` clears it. Every name must be an allowed one: the refusal
 * carries the list.
 */
export async function writeModelPrefs(
  q: Querier, userId: string, change: { default_model?: string | null; review_model?: string | null },
): Promise<ModelPrefs> {
  for (const field of ["default_model", "review_model"] as const) {
    const v = change[field];
    if (v === undefined || v === null) continue;
    if (typeof v !== "string" || !isAllowedModel(v)) throw notAllowed(String(v));
  }
  const has = (f: "default_model" | "review_model") => change[f] !== undefined;
  const row = (await q(
    `INSERT INTO claw_user_model_prefs (user_id, default_model, review_model, updated_at)
     VALUES ($1, $2, $3, NOW())
     ON CONFLICT (user_id) DO UPDATE SET
       default_model = CASE WHEN $4 THEN EXCLUDED.default_model ELSE claw_user_model_prefs.default_model END,
       review_model  = CASE WHEN $5 THEN EXCLUDED.review_model  ELSE claw_user_model_prefs.review_model  END,
       updated_at = NOW()
     RETURNING default_model, review_model, updated_at`,
    [userId, change.default_model ?? null, change.review_model ?? null, has("default_model"), has("review_model")],
  )).rows[0] as ModelPrefs;
  return row;
}

/** Refuses a name that is not on the allow-list, with the list. */
export function assertAllowedModel(name: string): void {
  if (!isAllowedModel(name)) throw notAllowed(name);
}

function notAllowed(name: string): ModelChoiceRefused {
  return new ModelChoiceRefused(
    "model_not_allowed",
    `${name.slice(0, 64)} is not one of the models on this deployment: pick one of ${ALLOWED.map((m) => m.name).join(", ")}`,
    { models: ALLOWED.map((m) => ({ name: m.name, label: m.label })) },
  );
}

// --- What the payer's key can use --------------------------------------------------------------------------------------

const LIST_TTL_MS = 5 * 60 * 1000;
const LIST_CACHE_MAX = 1000;
const listCache = new Map<string, { at: number; ids: string[] }>();

/** The gateway's model list for a key, as `GET /v1/models` reads it; throws when there is none to be had. */
async function gatewayModelIds(key: string): Promise<string[]> {
  const request = gatewayModelsRequest(key);
  const list = toModelList(await getUpstreamJson(request.url, request.headers));
  if (!list) throw new Error("the gateway answered with something that is not a model list");
  return list.data.map((m) => m.id);
}

/** The way out to the gateway, so a test can stand in for it. */
export const modelChoicePorts = { listModels: gatewayModelIds };

/**
 * The cache's name for a key: a keyed fingerprint with a secret made for this process, so the cache holds no key and no name that can be
 * matched to one elsewhere. Not password storage or verification.
 */
let fingerprintKey: Promise<webcrypto.CryptoKey> | null = null;
async function cacheIdOf(key: string): Promise<string> {
  fingerprintKey ??= webcrypto.subtle.importKey("raw", randomBytes(32), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = await webcrypto.subtle.sign("HMAC", await fingerprintKey, new TextEncoder().encode(key));
  return Buffer.from(mac).toString("hex");
}

/** The models the key can use, or null when that cannot be known now (no key, the gateway did not answer). Cached per key. */
export async function modelsForKey(key: string): Promise<string[] | null> {
  if (!key) return null;
  const id = await cacheIdOf(key);
  const hit = listCache.get(id);
  if (hit && Date.now() - hit.at < LIST_TTL_MS) return hit.ids;
  try {
    const ids = await modelChoicePorts.listModels(key);
    if (listCache.size >= LIST_CACHE_MAX) listCache.clear();
    listCache.set(id, { at: Date.now(), ids });
    return ids;
  } catch (err) {
    logger.warn({ errMessage: (err as Error)?.message?.slice(0, 200) }, "assistant.model_list_unavailable");
    return null;
  }
}

/** For tests: forget every cached list. */
export function clearModelListCache(): void {
  listCache.clear();
}

// --- The decision -------------------------------------------------------------------------------------------------------

export type ModelSource = "asked" | "user_kind_default" | "user_default" | "platform_kind_default" | "deployment_default";

export interface ResolvedModel {
  /** The model the item runs on; null for the deployment's default (the session names none). */
  model: string | null;
  source: ModelSource;
  /** Set when the chosen model could not be used with the payer's key: the model it was, which the item records as `model_asked`. */
  fellBackFrom?: string;
}

/**
 * The model an item of `kind` runs on, for the payer (whose defaults and whose key), with `asked` the model the message named for it
 * (undefined or null when it named none). Refuses a name off the allow-list, and a named model whose availability cannot be checked.
 */
export async function resolveItemModel(
  q: Querier, input: { kind: ItemKind; payerUserId: string; payerKey: string; asked?: string | null },
): Promise<ResolvedModel> {
  if (input.asked !== undefined && input.asked !== null && !isAllowedModel(input.asked)) throw notAllowed(input.asked);
  let chosen: string | null = null;
  let source: ModelSource = "deployment_default";
  if (input.asked) {
    chosen = input.asked;
    source = "asked";
  } else {
    // A default the allow-list no longer has is passed over, as if it were not set.
    const prefs = await readModelPrefs(q, input.payerUserId);
    const allowed = (m: string | null) => (m && isAllowedModel(m) ? m : null);
    const kindDefault = input.kind === "review" ? allowed(prefs.review_model) : null;
    const own = allowed(prefs.default_model);
    if (kindDefault) { chosen = kindDefault; source = "user_kind_default"; }
    else if (own) { chosen = own; source = "user_default"; }
    else if (platformKindModel(input.kind)) { chosen = platformKindModel(input.kind); source = "platform_kind_default"; }
  }
  if (!chosen) return { model: null, source };
  // The deployment's own default for the kind is what every item ran on before: it is not asked about.
  if (chosen === platformModel(input.kind)) return { model: chosen, source };
  const usable = await modelsForKey(input.payerKey);
  if (usable === null) {
    if (source === "asked") {
      throw new ModelChoiceRefused(
        "model_unverifiable",
        `whether ${chosen} can run on this user's key cannot be checked right now: tell the user, and leave model out to use their default, or try again later`,
        { model: chosen },
      );
    }
    return { model: chosen, source };
  }
  if (usable.includes(chosen)) return { model: chosen, source };
  const fallback = fallbackModel();
  const to = fallback && fallback !== chosen && usable.includes(fallback) ? fallback : platformKindModel(input.kind);
  logger.info({ userId: input.payerUserId, kind: input.kind, from: chosen, to, source }, "assistant.model_fell_back");
  return { model: to, source, fellBackFrom: chosen };
}

/** What the item's `params` records of the decision: the model it runs on, and the one it fell back from. */
export function modelParams(r: ResolvedModel): { model: string | null; model_asked?: string } {
  return { model: r.model, ...(r.fellBackFrom ? { model_asked: r.fellBackFrom } : {}) };
}

/** What a tool answers with about the decision. */
export function modelAnswer(r: ResolvedModel): { model: string | null; fell_back_from?: string } {
  return { model: r.model, ...(r.fellBackFrom ? { fell_back_from: r.fellBackFrom } : {}) };
}
