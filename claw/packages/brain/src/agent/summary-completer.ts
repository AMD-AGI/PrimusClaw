// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Which model writes the one-sentence summary on an approval card, and whose key pays for it.
 *
 * The summary used to be one more call on the run's own model. A reasoning model with unbounded
 * thinking cannot answer a 40-word request inside the card's budget, so a deployment can name a
 * small, fast model (HITL_SUMMARY_MODEL) for it. Two rules hold either way:
 *
 *   - The key is the run's own. `open` is given the model name and nothing else: the gateway and the
 *     key come from the run (the asking user's key, or the platform key in proxy mode), so the tokens
 *     are billed exactly as the run's are and no other credential exists on this path.
 *   - A model the key may not call leaves the card without a summary. It never switches key and never
 *     falls back to another model: the run's model is the one that could not answer in time.
 */
import pino from "pino";
import type { LlmSession } from "../llm/provider.js";
import type { Completer } from "./approval-explain.js";

const logger = pino({ name: "approval-summary-model" });

/** The statuses a gateway answers with when the key may not call the model, or there is no such model. */
const REFUSED_STATUSES = new Set([401, 403, 404]);
/** Some gateways answer a model they do not serve with a 400 that says so. */
const MODEL_UNKNOWN_MESSAGE =
  /invalid model|no access to model|model\b[^.]{0,60}\b(?:not found|does not exist|not allowed|not available|not supported)/i;

/** The status of a refusal that means "this key cannot use this model"; undefined for any other failure. */
export function modelRefusalStatus(err: unknown): number | undefined {
  if (typeof err !== "object" || err === null) return undefined;
  const { status, message } = err as { status?: unknown; message?: unknown };
  if (typeof status !== "number") return undefined;
  if (REFUSED_STATUSES.has(status)) return status;
  if (status === 400 && typeof message === "string" && MODEL_UNKNOWN_MESSAGE.test(message)) return status;
  return undefined;
}

export interface SummaryCompleterDeps {
  /** HITL_SUMMARY_MODEL; empty means the run's own model. */
  model: string;
  /** The run's own session: what answers when no summary model is configured. */
  runSession: Pick<LlmSession, "complete">;
  /** A session on `model`, on the run's gateway and with the run's key. */
  open: (model: string) => Pick<LlmSession, "complete">;
  /** Called once per completer, the first time the gateway refuses the configured model. */
  onRefused?: (model: string, status: number) => void;
}

export function summaryCompleter(deps: SummaryCompleterDeps): Completer {
  const model = deps.model.trim();
  // Unchanged: the run's own model, the call exactly as it was before the setting existed.
  if (!model) return (system, user, maxTokens, signal) => deps.runSession.complete(system, user, maxTokens, signal);

  let session: Pick<LlmSession, "complete"> | undefined;
  let refused: number | undefined;
  return async (system, user, maxTokens, signal) => {
    // A refusal is about the key and the model, neither of which changes during a run.
    if (refused !== undefined) throw new Error(`approval summary model refused (status ${refused})`);
    session ??= deps.open(model);
    try {
      return await session.complete(system, user, maxTokens, signal, { effort: "low" });
    } catch (err) {
      const status = modelRefusalStatus(err);
      if (status !== undefined && refused === undefined) {
        refused = status;
        deps.onRefused?.(model, status);
        logger.warn({ model, status }, "approval.summary_model_refused");
      }
      throw err;
    }
  };
}
