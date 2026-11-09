// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import {
  ClawAnswerInvalid,
  cpHead,
  messageContent,
  pyStr,
  pyTruthy,
  type ClawCredential,
  type ClawSessionsPort,
  type JsonObject,
  type NewSession,
  type SendOptions,
  type SseEvent,
  type UploadFile,
} from "@primusclaw/personal-agent";
import { dataOf, messageIdOf, objectOf, rowsOf } from "./answers.js";
import { type ClawHttp, modelKeyHeader, pyQuote, requireToken, segment } from "./http.js";
import type { StyleRule } from "./rule.js";
import { sseEvents } from "./sse-stream.js";

/** Claw takes a file for this many days (one of its tiers: 1, 2, 7, 15, 30). */
export const UPLOAD_TTL_DAYS = 7;
/** The newest event alone is a few KB; more is a Claw that ignored `tail=1` and sent everything. */
export const LAST_EVENT_MAX_BYTES = 262_144;
/** A changes reply lists at most 200 files per repository: a few hundred KB at the very most. */
export const CHANGES_MAX_BYTES = 1_048_576;

/** What a session's messages carry besides the text. */
export interface MessageDefaults {
  /** CLAW_PLUGIN_ID, named as the web client names it (`pluginId`); null none. */
  readonly pluginId: number | null;
  /** CLAWY_MODEL: what a new session asks for when its caller names none ("" none). */
  readonly model: string;
  /** The reply-style rule, when a rule tool is configured. */
  readonly rule: StyleRule | null;
}

/** `ClawSessionsPort` over Claw's HTTP API. */
export class HttpSessions implements ClawSessionsPort {
  constructor(
    private readonly http: ClawHttp,
    private readonly defaults: MessageDefaults,
  ) {}

  async checkKey(key: ClawCredential): Promise<void> {
    await this.http.json({ method: "GET", path: "/v1/sessions?limit=1", key });
  }

  async create(key: ClawCredential, session: NewSession): Promise<{ sessionId: string; messageId: string }> {
    const acting = (session.actingAs ?? "") !== "";
    if (acting) requireToken(key, "a session that acts as a user");
    const headers = { "Idempotency-Key": session.idempotencyKey, ...modelKeyHeader(key, session.modelKey) };
    const withMessage = session.withMessage ?? true;
    const body: JsonObject = {
      name: cpHead(session.text, 50),
      mode: "claw",
      config: sessionConfig(session),
      ...(withMessage ? { message: await this.#textMessage(key, session.text, acting) } : {}),
    };
    const model = session.model !== undefined && session.model !== "" ? session.model : this.defaults.model;
    const sent = model === "" ? body : { ...body, model };
    const data = dataOf(
      await this.http.json({ method: "POST", path: "/v1/sessions", key, body: sent, headers }),
      "a session",
    );
    const sessionId = data["session_id"];
    const message = data["message"];
    const messageId = withMessage && isObject(message) ? message["message_id"] : "";
    if (typeof sessionId !== "string" || typeof messageId !== "string") {
      throw new ClawAnswerInvalid("a session without its id");
    }
    return { sessionId, messageId };
  }

  async uploadFiles(
    key: ClawCredential,
    sessionId: string,
    folder: string,
    files: readonly UploadFile[],
  ): Promise<{ paths: string[]; refused: string[] }> {
    const form = new FormData();
    for (const file of files) {
      form.append(
        "file",
        new Blob([Uint8Array.from(file.content)], { type: file.mediaType }),
        `${folder}/${file.name}`,
      );
    }
    const path = `/v1/sessions/${segment(sessionId)}/upload?ttl_days=${String(UPLOAD_TTL_DAYS)}`;
    const out = objectOf(await this.http.json({ method: "POST", path, key, timeoutMs: 120_000, form }), "an upload");
    const uploaded = Array.isArray(out["uploaded"]) ? out["uploaded"] : [];
    const paths = uploaded.flatMap((u: unknown) =>
      isObject(u) && typeof u["path"] === "string" && u["path"] !== "" ? [`/workspace/.uploads/${u["path"]}`] : [],
    );
    const taken = new Set(paths.map((p) => p.slice(p.lastIndexOf("/") + 1)));
    return { paths, refused: files.map((f) => f.name).filter((name) => !taken.has(name)) };
  }

  async setModel(key: ClawCredential, sessionId: string, model: string): Promise<void> {
    await this.http.json({ method: "PATCH", path: `/v1/sessions/${segment(sessionId)}`, key, body: { model } });
  }

  async sendMessage(
    key: ClawCredential,
    sessionId: string,
    text: string,
    options: SendOptions = {},
  ): Promise<string | null> {
    const headers = modelKeyHeader(key, options.modelKey);
    const body = await this.#textMessage(key, text, options.acting ?? false);
    const path = `/v1/sessions/${segment(sessionId)}/messages`;
    return messageIdOf(await this.http.json({ method: "POST", path, key, body, headers }));
  }

  async turn(key: ClawCredential, sessionId: string): Promise<{ running: boolean; messageId: string | null }> {
    const data = dataOf(
      await this.http.json({ method: "GET", path: `/v1/sessions/${segment(sessionId)}`, key }),
      "a session",
    );
    const running = data["agent_status"] === "running";
    const gate = data["agent_gate_message_id"];
    return { running, messageId: running && pyTruthy(gate) ? pyStr(gate) : null };
  }

  async events(
    key: ClawCredential,
    sessionId: string,
    options: { tail?: number; maxBytes?: number } = {},
  ): Promise<JsonObject[]> {
    const { tail, maxBytes } = options;
    let path = `/v1/chat/sessions/${segment(sessionId)}/messages?mode=replay`;
    if (tail !== undefined) {
      if (tail < 1) throw new RangeError("tail must be at least 1");
      path += `&tail=${String(Math.trunc(tail))}`;
    }
    const request = { method: "GET", path, key };
    const answer =
      maxBytes === undefined ? await this.http.json(request) : await this.http.boundedJson(request, maxBytes);
    const rows = rowsOf(answer, "replay");
    return tail === undefined ? rows : rows.slice(-tail);
  }

  async lastEventId(key: ClawCredential, sessionId: string): Promise<string | null> {
    const rows = await this.events(key, sessionId, { tail: 1, maxBytes: LAST_EVENT_MAX_BYTES });
    const id = rows.at(-1)?.["event_id"];
    return typeof id === "string" && id !== "" ? id : null;
  }

  async changes(key: ClawCredential, sessionId: string, timeoutMs: number): Promise<unknown> {
    const path = `/v1/sessions/${segment(sessionId)}/changes`;
    return this.http.boundedJson({ method: "GET", path, key }, CHANGES_MAX_BYTES, AbortSignal.timeout(timeoutMs));
  }

  deliveryLink(sessionId: string, deliveryId: string): string | null {
    if (!this.http.baseUrl.startsWith("https://")) return null;
    // A dot segment would be resolved by the browser to another path of Claw's (the Python worker wrote it as it was).
    if ([sessionId, deliveryId].some((id) => id === "" || id === "." || id === "..")) return null;
    return `${this.http.baseUrl}/v1/sessions/${pyQuote(sessionId)}/deliveries/${pyQuote(deliveryId)}`;
  }

  async interrupt(key: ClawCredential, sessionId: string): Promise<void> {
    await this.#say(key, sessionId, { messageType: "interrupt" }, false);
  }

  async decide(
    key: ClawCredential,
    sessionId: string,
    toolUseId: string,
    action: string,
    options: { acting?: boolean } = {},
  ): Promise<void> {
    const body = { messageType: "decision", extData: { tool_use_id: toolUseId, action } };
    await this.#say(key, sessionId, body, options.acting ?? false);
  }

  async answer(
    key: ClawCredential,
    sessionId: string,
    toolUseId: string,
    answers: Readonly<Record<string, string>>,
    skipped: readonly string[],
    options: { acting?: boolean } = {},
  ): Promise<void> {
    const body = { messageType: "answer", extData: { tool_use_id: toolUseId, answers, skipped } };
    await this.#say(key, sessionId, body, options.acting ?? false);
  }

  async vote(
    key: ClawCredential,
    sessionId: string,
    messageId: string,
    vote: "up" | "down",
    reason?: string,
  ): Promise<void> {
    const body = { message_id: messageId, vote, ...(reason === undefined || reason === "" ? {} : { reason }) };
    await this.http.json({ method: "PUT", path: `/v1/sessions/${segment(sessionId)}/feedback`, key, body });
  }

  stream(key: ClawCredential, sessionId: string, after?: string, signal?: AbortSignal): AsyncIterable<SseEvent> {
    return sseEvents(this.http, `/v1/chat/sessions/${segment(sessionId)}/messages`, key, after, signal);
  }

  async #say(key: ClawCredential, sessionId: string, body: JsonObject, acting: boolean): Promise<void> {
    if (acting) requireToken(key, "an answer in a session that acts as a user");
    await this.http.json({ method: "POST", path: `/v1/sessions/${segment(sessionId)}/messages`, key, body });
  }

  /**
   * A person's message, carrying the plugin id the way the web client does. A session that acts as a user gets the
   * text alone: no plugin (its tools act with the requester's own key, and such a session reads a stranger's pull
   * request) and nothing appended.
   */
  async #textMessage(key: ClawCredential, text: string, acting: boolean): Promise<JsonObject> {
    if (acting) return { content: text, messageType: "text" };
    const { rule, pluginId } = this.defaults;
    const ruleText = rule === null ? "" : await rule.text(key);
    return {
      content: messageContent(text, ruleText, rule !== null),
      messageType: "text",
      ...(pluginId === null ? {} : { pluginId }),
    };
  }
}

/** `config` of a new session. */
function sessionConfig(session: NewSession): JsonObject {
  const { repo, actingAs, shared, reviewTarget, reviewOnly } = session;
  return {
    notify_on_finish: true,
    ...(repo === undefined ? {} : { repo: { url: repo.url, ...(repo.branch === "" ? {} : { branch: repo.branch }) } }),
    ...(actingAs === undefined || actingAs === "" ? {} : { acting_as: actingAs }),
    ...(shared === true ? { memory: "off" } : {}),
    ...(reviewTarget === undefined
      ? {}
      : { review_target: { owner: reviewTarget.owner, repo: reviewTarget.repo, number: reviewTarget.number } }),
    ...(reviewOnly === true ? { review_only: true } : {}),
  };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
