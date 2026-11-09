// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import {
  ClawAnswerInvalid,
  ClawError,
  CredentialMisuse,
  ReviewsRefused,
  isApiKey,
  parseStartedReviews,
  pyStrip,
  cpHead,
  type AssistantMessageOptions,
  type ClawAssistantPort,
  type ClawCredential,
  type JsonObject,
  type ReviewStart,
  type StartReviews,
} from "@primusclaw/personal-agent";
import { anyDataOf, dataOf, messageIdOf, objectOf } from "./answers.js";
import { type ClawHttp, head, modelKeyHeader, pyQuote, readText, requireToken, segment, auth } from "./http.js";

/** A message to the assistant only has to be taken: its answer comes back as an event. */
export const ASSISTANT_SEND_TIMEOUT_MS = 15_000;
/** What Claw takes of the asker's own words, which it quotes to the reviewer as untrusted. */
export const REQUESTER_NOTE_MAX = 2000;
/** A review asked of someone else carries that person's exchanged token and own linked key in these. */
export const ACTING_TOKEN_HEADER = "x-acting-as-token";
export const ACTING_KEY_HEADER = "x-acting-as-api-key";

/** `ClawAssistantPort` over Claw's HTTP API. */
export class HttpAssistant implements ClawAssistantPort {
  constructor(private readonly http: ClawHttp) {}

  async session(key: ClawCredential): Promise<{ sessionId: string; created: boolean }> {
    const data = dataOf(await this.http.json({ method: "POST", path: "/v1/assistant", key, body: {} }), "the assistant");
    const sessionId = data["session_id"];
    if (sessionId === undefined || sessionId === null) throw new ClawAnswerInvalid("the assistant without its session");
    return { sessionId: String(sessionId as string), created: Boolean(data["created"]) };
  }

  async send(
    key: ClawCredential,
    sessionId: string,
    text: string,
    options: AssistantMessageOptions = {},
  ): Promise<string | null> {
    const { context, plugin, modelKey } = options;
    const body = {
      content: text,
      messageType: "text",
      ...(context === undefined || Object.keys(context).length === 0 ? {} : { channel_context: context }),
      ...(plugin === undefined ? {} : { pluginId: plugin }),
    };
    const path = `/v1/sessions/${segment(sessionId)}/messages`;
    const headers = modelKeyHeader(key, modelKey);
    return messageIdOf(await this.http.json({ method: "POST", path, key, body, headers, timeoutMs: ASSISTANT_SEND_TIMEOUT_MS }));
  }

  async brief(key: ClawCredential, lang: string, timezone: string): Promise<JsonObject> {
    const query = new URLSearchParams({ lang, timezone }).toString();
    return dataOf(await this.http.json({ method: "GET", path: `/v1/assistant/brief?${query}`, key }), "the brief");
  }

  async decideConfirmation(token: ClawCredential, confirmationId: string, decision: string): Promise<JsonObject> {
    requireToken(token, "an answer to a held write");
    const path = `/v1/assistant/confirmations/${segment(confirmationId)}/decision`;
    const out = objectOf(await this.http.json({ method: "POST", path, key: token, body: { decision } }), "a decision");
    return dataOrSelf(out);
  }

  async startReviews(token: ClawCredential, request: StartReviews): Promise<ReviewStart[]> {
    requireToken(token, "a review for someone");
    const { actingToken = "", actingKey = "" } = request;
    if (actingToken !== "" && (isApiKey(actingToken) || !isApiKey(actingKey))) {
      throw new CredentialMisuse("a review asked of someone else carries their exchanged token and their own linked key");
    }
    const asked = actingToken !== "";
    const headers = asked
      ? { ...auth(token), [ACTING_TOKEN_HEADER]: actingToken, [ACTING_KEY_HEADER]: actingKey }
      : { ...auth(token), ...modelKeyHeader(token, request.modelKey) };
    const path = "/v1/assistant/reviews";
    const response = await this.http.send({ method: "POST", path, key: token, body: reviewsBody(request), headers });
    const text = await readText(response, path);
    if (response.status === 404) throw new ClawError(404, head(text));
    if (response.status < 400) {
      const out = parse(text);
      return parseStartedReviews(isObject(out) ? out["data"] : undefined, !asked);
    }
    throw refusal(response.status, text);
  }

  async observeScope(key: ClawCredential, scope: string): Promise<JsonObject> {
    const body = { scope, mode: "observe" };
    return dataOf(await this.http.json({ method: "PUT", path: "/v1/assistant/scopes", key, body }), "a scope");
  }

  async observe(key: ClawCredential, scope: string, content: string, messageId: string): Promise<JsonObject> {
    const body = { scope, content, message_id: messageId };
    return dataOf(await this.http.json({ method: "POST", path: "/v1/assistant/observations", key, body }), "an observation");
  }

  async observations(key: ClawCredential, scope: string, limit = 20): Promise<JsonObject[]> {
    const path = `/v1/assistant/observations?scope=${pyQuote(scope)}&limit=${String(Math.trunc(limit))}`;
    let answer: unknown;
    try {
      answer = await this.http.json({ method: "GET", path, key });
    } catch (err) {
      if (err instanceof ClawError && err.status === 404) return [];
      throw err;
    }
    const rows = anyDataOf(answer, "the observations");
    if (!Array.isArray(rows)) throw new ClawAnswerInvalid("the observations are not a list");
    return rows.filter(isObject) as JsonObject[];
  }
}

/** The body of a request for reviews. */
function reviewsBody(request: StartReviews): JsonObject {
  const { prs, actingAs, actingAsName, reviewOnly, model, actingToken = "", requesterNote = "", handoffId = "" } = request;
  const note = pyStrip(requesterNote);
  return {
    prs: prs.map(({ pull, message }) => ({
      owner: pull.owner,
      repo: pull.repo,
      number: pull.number,
      ...(message === "" ? {} : { message }),
    })),
    acting_as: actingAs,
    review_only: reviewOnly,
    ...(actingAsName === "" ? {} : { acting_as_name: cpHead(actingAsName, 100) }),
    ...(model === "" ? {} : { model }),
    ...(actingToken !== "" && note !== "" ? { requester_note: cpHead(note, REQUESTER_NOTE_MAX) } : {}),
    ...(actingToken !== "" && handoffId !== "" ? { handoff_id: handoffId } : {}),
  };
}

/** Claw's refusal of a request for reviews as a whole, or a plain ClawError for an answer that is not one. */
function refusal(status: number, text: string): ClawError {
  const payload = parse(text);
  if (!isObject(payload) || typeof payload["error"] !== "string") return new ClawError(status, head(text));
  const message = payload["message"];
  const data = payload["data"];
  const said = message === undefined || message === null || message === "" ? "" : String(message as string);
  return new ReviewsRefused(status, payload["error"], said, isObject(data) ? data : {});
}

/** `data` when it is an object, else the answer itself (Python's `out["data"] if isinstance(...) else out`). */
export function dataOrSelf(out: Record<string, unknown>): JsonObject {
  const data = out["data"];
  return (isObject(data) ? data : out) as JsonObject;
}

function parse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
