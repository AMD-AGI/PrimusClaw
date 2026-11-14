// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Which model the assistant itself runs on, told to every router turn. Asked "你用的什么模型" the router said it could not see which
 * model it ran on and named the defaults that work items and reviews run on instead (an evaluation run, 2026-11-14):
 * nothing in its prompt named its own model, and the item defaults were the only model names it had.
 *
 * The router's model is the one its turn asks for (the session's model, or the fallback a refused turn is run again on), else the
 * deployment's default (`DEFAULT_MODEL`, the one Brain uses for a turn that names none). When the gateway picks the backend itself,
 * the name it answered the last turn with (`routed_model` of the session's latest answer) is the one that actually served it, and is
 * named beside it. The models work items and reviews run on are chosen per item (the user's defaults, the allow-list, the payer's
 * key, a fallback), so none is named here: the router is told they are the workers', not its own, and says an item's model from what
 * starting it returned.
 */
import pino from "pino";
import type { Querier } from "../infra/db.js";

const logger = pino({ name: "assistant-own-model" });

/** The latest answers of a session searched for the model that served one: a bound on the rows read. */
const RECENT_EVENTS = 200;

/** A model name as it may be written into a prompt: one line, no more than a model name needs. */
function modelName(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const name = raw.trim();
  return name && name.length <= 128 && /^[A-Za-z0-9._:/@+-]+$/.test(name) ? name : null;
}

/** The model a router turn asks for: its own (the session's, or a re-run's fallback), else the deployment's default. */
export function routerTurnModel(taskModel: unknown, deploymentModel: unknown): string | null {
  return modelName(taskModel) ?? modelName(deploymentModel);
}

/**
 * The model the gateway answered the session's latest answer with (`routed_model`), or null when no recent answer carries one. Reads
 * at most the session's newest RECENT_EVENTS events, by `idx_events_session_recent`.
 */
export async function lastServedModel(q: Querier, sessionId: string): Promise<string | null> {
  try {
    const { rows } = await q(
      `SELECT e.data->>'routed_model' AS model
         FROM (SELECT event, data, created_at FROM claw_session_events
                WHERE session_id = $1 AND deleted_at IS NULL
                ORDER BY created_at DESC LIMIT ${RECENT_EVENTS}) e
        WHERE e.event = 'AssistantMessage' AND e.data ? 'routed_model'
        ORDER BY e.created_at DESC LIMIT 1`,
      [sessionId],
    );
    return modelName((rows[0] as { model?: unknown } | undefined)?.model);
  } catch (err) {
    // An extra the turn can do without: a failed read leaves the line without it, never the turn without an answer.
    logger.warn({ sessionId, errMessage: (err as Error)?.message?.slice(0, 200) }, "assistant.own_model_read_failed");
    return null;
  }
}

export interface OwnModelContext {
  /** What this turn asks for (`routerTurnModel`), null when nothing names one and the gateway uses its own default. */
  runsOn: string | null;
  /** The model that served the session's latest answer, when the gateway said. */
  lastServed: string | null;
}

/** The router's line of which model it runs on, and that the models of work items and reviews are not its own. */
export function renderOwnModelState(c: OwnModelContext): string {
  const served = c.lastServed && c.lastServed !== c.runsOn ? `; your latest answer here was served by ${c.lastServed}` : "";
  const own = c.runsOn
    ? `Your model: you, the assistant, run on ${c.runsOn}${served}.`
    : c.lastServed
      ? `Your model: you, the assistant, run on the gateway's default model; your latest answer here was served by ${c.lastServed}.`
      : "Your model: you, the assistant, run on the gateway's default model, whose name Claw is not told.";
  return `${own} Asked which model you run on (你用的什么模型, which model are you), name ${c.runsOn || c.lastServed ? "that one" : "it as that"}, `
    + "as the answer: never say you cannot see your model. "
    + "Work items and reviews run on models chosen for each of them: those are the workers' models, not yours; name one only as "
    + "that item's, from what starting or reading the item said, and only when asked.";
}
