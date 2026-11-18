// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The Claw API and the platform's `/users/self` as the conformance kit's worker meets them: one fake over real HTTP that
 * answers a chat turn (a session made, its stream followed), keeps the people's notification subscriptions (with the
 * surface each names), takes the assistant's messages and an approval's decision, and records every request. Each person's
 * key is `ak-<id>` and their Claw user id `u-<id>`.
 */
import { FakeHttpServer, type ReceivedRequest, type Reply, type SseFrame } from "../http-server.js";

/** The prefix of the platform API on the fake (SAFE_API_URL is `<url>/api/v1`). */
export const PLATFORM = "/api/v1";

export function keyOf(personId: string): string {
  return `ak-${personId}`;
}

export function clawUserOf(personId: string): string {
  return `u-${personId}`;
}

function personOfKey(request: ReceivedRequest): string {
  const bearer = (request.headers["authorization"] ?? "").replace(/^Bearer /, "");
  return bearer.startsWith("ak-") ? bearer.slice(3) : "";
}

/** A subscription a person's worker made: its id, the secret events are signed with, and what it asked for. */
export interface KitSubscription {
  readonly personId: string;
  readonly id: string;
  readonly secret: string;
  readonly body: Readonly<Record<string, unknown>>;
}

/** The frames of a chat turn that answers `answer` (said as it is written, then the result). */
export function answerFrames(answer: string, messageId: string): SseFrame[] {
  const said = { message_id: messageId, data: { content: [{ type: "text", text: answer }] } };
  const ended = { message_id: messageId, final_text: answer, data: { subtype: "success" } };
  return [
    { event: "AssistantMessage", id: "e1", data: JSON.stringify(said) },
    { event: "ResultMessage", id: "e2", data: JSON.stringify(ended) },
  ];
}

function ok(data: unknown): Reply {
  return { status: 200, json: { ok: true, data } };
}

export class KitClaw {
  readonly subscriptions: KitSubscription[] = [];
  /** What a chat turn answers to the person's words (default: "Echo: <words>"). */
  answer: (text: string) => string = (text) => `Echo: ${text}`;
  private sessions = 0;
  /** The words and the message id of each session's latest turn, by session id. */
  private readonly turns = new Map<string, { readonly text: string; readonly messageId: string }>();

  private constructor(readonly server: FakeHttpServer) {}

  static async start(): Promise<KitClaw> {
    const claw = new KitClaw(await FakeHttpServer.start());
    claw.mount();
    return claw;
  }

  get url(): string {
    return this.server.url;
  }

  get requests(): readonly ReceivedRequest[] {
    return this.server.requests;
  }

  /** The requests to `path` (a string: equal; a RegExp: matching) with `method`. */
  calls(method: string, path: string | RegExp): ReceivedRequest[] {
    return this.server.requests.filter(
      (r) => r.method === method && (typeof path === "string" ? r.path === path : path.test(r.path)),
    );
  }

  close(): Promise<void> {
    return this.server.close();
  }

  /** The requests `personId` made (with their key) to `path` with `method`. */
  callsBy(personId: string, method: string, path: string | RegExp): ReceivedRequest[] {
    return this.calls(method, path).filter((r) => r.headers["authorization"] === `Bearer ${keyOf(personId)}`);
  }

  /** The id Claw gave the latest message of session `id` (what an event of the turn that answers it names). */
  latestMessage(id: string): string | undefined {
    return this.turns.get(id)?.messageId;
  }

  private newSession(text: string): string {
    this.sessions += 1;
    const id = `s-${String(this.sessions)}`;
    this.turns.set(id, { text, messageId: `m-${id}-1` });
    return id;
  }

  private mount(): void {
    const s = this.server;
    s.route("GET", `${PLATFORM}/users/self`, (r) => {
      const person = personOfKey(r);
      return person ? ok({ id: clawUserOf(person), name: person, email: "", type: "user" }) : { status: 401, json: {} };
    });
    s.route("GET", "/v1/sessions", () => ok([]));
    s.route("POST", "/v1/sessions", (r) => {
      const body = r.json as { message?: { content?: unknown } } | undefined;
      const text = typeof body?.message?.content === "string" ? body.message.content : "";
      const id = this.newSession(text);
      return ok({ session_id: id, message: { message_id: this.turns.get(id)?.messageId } });
    });
    s.route("POST", /^\/v1\/sessions\/[^/]+\/messages$/, (r) => {
      const id = r.path.split("/")[3] ?? "";
      const body = r.json as { content?: unknown } | undefined;
      const messageId = `m-${id}-${String(this.requests.length)}`;
      this.turns.set(id, { text: typeof body?.content === "string" ? body.content : "", messageId });
      return { status: 200, json: { message_id: messageId } };
    });
    s.route("GET", /^\/v1\/chat\/sessions\/[^/]+\/messages$/, (r) => {
      const turn = this.turns.get(r.path.split("/")[4] ?? "");
      // (a turn's stream is read once: a reader that comes back after its result hears nothing new)
      if (turn === undefined || r.query.get("after") === "e2") return { sse: [] };
      return { sse: answerFrames(this.answer(turn.text), turn.messageId) };
    });
    s.route("GET", /^\/v1\/sessions\/[^/]+$/, (r) => ok({ session_id: r.path.split("/")[3], status: "idle" }));
    s.route("GET", "/v1/work-items", () => ok([]));
    s.route("GET", /^\/v1\/sessions\/[^/]+\/changes$/, () => ok({ files: [] }));
    s.route("POST", "/v1/assistant", (r) => ok({ session_id: `a-${personOfKey(r)}`, created: false }));
    this.mountSubscriptions();
  }

  private mountSubscriptions(): void {
    const s = this.server;
    s.route("GET", "/v1/notification-subscriptions", (r) =>
      ok(
        this.subscriptions
          .filter((sub) => sub.personId === personOfKey(r))
          .map((sub) => ({ subscription_id: sub.id, enabled: true, ...sub.body })),
      ),
    );
    s.route("POST", "/v1/notification-subscriptions", (r) => {
      const body = (r.json ?? {}) as Record<string, unknown>;
      const id = `sub-${String(this.subscriptions.length + 1)}`;
      const sub = { personId: personOfKey(r), id, secret: `whsec-${id}`, body };
      this.subscriptions.push(sub);
      return ok({ subscription_id: id, secret: sub.secret, enabled: true, ...body });
    });
    s.route("DELETE", /^\/v1\/notification-subscriptions\/[^/]+$/, () => ok({}));
  }
}
