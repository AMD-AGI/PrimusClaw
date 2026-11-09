// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * A recording Bot Connector: the Bot Connector v3 calls a worker makes in direct mode, answered as Teams answers them and
 * recorded, nothing reaching Teams. Teams' stream rules are applied (one open stream per conversation, streamed text only
 * grows, nothing after the final; a request Teams would refuse is refused the same way, 403 ContentStreamNotAllowed, and
 * noted). Creating a 1:1 conversation and reading a group's members are refused (403, 404): its people are in no roster.
 * The same protocol the release gate's external driver serves (its `gate_recording.Recorder` and `connector_app`), so a
 * worker that passes against this one is driven by the gate alike. It also serves files at `/gate-files/<name>`.
 */
import { FakeHttpServer, type ReceivedRequest, type Reply } from "./http-server.js";

type Json = Record<string, unknown>;

export interface Record_ {
  readonly t: number;
  readonly op: string;
  readonly conversation: string;
  readonly activity: Json;
  readonly activityId: string | undefined;
  readonly streamId?: string;
}

export interface Refusal {
  readonly t: number;
  readonly conversation: string;
  readonly why: string;
  readonly text: string;
}

class Refused extends Error {}

interface OpenStream {
  readonly id: string;
  text: string;
  last: number;
}

function isJson(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The stream entity of an activity (`streaminfo`), if it has one. */
export function streamInfo(activity: Json): Json | undefined {
  const entities = Array.isArray(activity["entities"]) ? activity["entities"] : [];
  return entities.filter(isJson).find((e) => e["type"] === "streaminfo");
}

/** What reached the chat: every request, with Teams' answers and Teams' stream rules. */
export class Recorder {
  readonly records: Record_[] = [];
  readonly refusals: Refusal[] = [];
  private n = 0;
  private readonly open = new Map<string, OpenStream>();

  constructor(private readonly now: () => number = () => performance.now() / 1000) {}

  private nextId(): string {
    this.n += 1;
    return `gate-msg-${String(this.n)}`;
  }

  private record(op: string, conversation: string, activity: Json, activityId: string | undefined, streamId?: string) {
    const copy = JSON.parse(JSON.stringify(activity)) as Json;
    this.records.push({
      t: this.now(),
      op,
      conversation,
      activity: copy,
      activityId,
      ...(streamId ? { streamId } : {}),
    });
  }

  /** A message, an edit or a delete: the id Teams would answer with (undefined for a typing indicator). */
  take(op: string, conversation: string, activity: Json, activityId?: string): string | undefined {
    const id =
      op === "update" || op === "delete"
        ? (activityId ?? "")
        : activity["type"] === "typing"
          ? undefined
          : this.nextId();
    this.record(op, conversation, activity, id);
    return id;
  }

  /** One request of a Teams stream: the stream's id for its first request and its final, undefined otherwise. */
  takeStream(conversation: string, activity: Json): string | undefined {
    const info = streamInfo(activity) ?? {};
    const kind = info["streamType"];
    let sid = typeof info["streamId"] === "string" ? info["streamId"] : "";
    const now = this.now();
    const text = typeof activity["text"] === "string" ? activity["text"] : "";
    const refuse = (why: string): never => {
      this.refusals.push({ t: now, conversation, why, text: text.slice(0, 200) });
      throw new Refused(why);
    };
    let current = this.open.get(conversation);
    let answer: string | undefined;
    if (!sid) {
      if (current !== undefined) refuse("a second stream opened while one is open in the conversation");
      sid = this.nextId();
      current = { id: sid, text: "", last: 0 };
      this.open.set(conversation, current);
      answer = sid;
    } else {
      if (current?.id !== sid) return refuse(`a request for stream ${sid}, which is not open`);
      if (now - current.last < 0.9)
        this.refusals.push({ t: now, conversation, why: "more than one request a second", text: "" });
    }
    if (kind === "streaming") {
      if (!text.startsWith(current.text)) refuse("streamed text that does not start with what was streamed before");
      current.text = text;
    }
    current.last = now;
    if (kind === "final") {
      this.open.delete(conversation);
      answer = sid; // (Teams' final message is the streamed message itself: it keeps the stream's id)
    }
    this.record("stream", conversation, activity, answer, sid);
    return answer;
  }

  /** The text of every message a conversation was sent (sends, replies and finals), in order. */
  texts(conversation?: string): string[] {
    return this.records
      .filter((r) => conversation === undefined || r.conversation === conversation)
      .filter((r) => r.activity["type"] === "message")
      .map((r) => (typeof r.activity["text"] === "string" ? r.activity["text"] : ""));
  }
}

const ACTIVITIES = /^\/v3\/conversations\/([^/]+)\/activities(?:\/([^/]+))?$/;

export class RecordingConnector {
  readonly recorder: Recorder;
  /** createConversation calls the worker made (refused). */
  readonly opened: unknown[] = [];

  private constructor(
    readonly server: FakeHttpServer,
    readonly files: Map<string, string>,
    now?: () => number,
  ) {
    this.recorder = new Recorder(now);
  }

  static async start(now?: () => number): Promise<RecordingConnector> {
    const connector = new RecordingConnector(await FakeHttpServer.start(), new Map(), now);
    connector.mount();
    return connector;
  }

  /** The base URL, the serviceUrl of the activities a gate sends (with its trailing slash). */
  get url(): string {
    return this.server.url;
  }

  private post(request: ReceivedRequest): Reply {
    const match = ACTIVITIES.exec(request.path);
    const activity = request.json;
    if (!match || !isJson(activity))
      return { status: 400, json: { error: { code: "BadArgument", message: "not an activity" } } };
    const conversation = decodeURIComponent(match[1] ?? "");
    const op = match[2] === undefined ? "send" : "reply";
    try {
      const answer = streamInfo(activity)
        ? this.recorder.takeStream(conversation, activity)
        : this.recorder.take(op, conversation, activity);
      return answer ? { status: 201, json: { id: answer } } : { status: 200, json: {} };
    } catch (error) {
      if (!(error instanceof Refused)) throw error;
      return { status: 403, json: { error: { code: "ContentStreamNotAllowed", message: error.message } } };
    }
  }

  private edit(request: ReceivedRequest, op: "update" | "delete"): Reply {
    const match = ACTIVITIES.exec(request.path);
    const activity = op === "delete" ? {} : request.json;
    if (!match?.[2] || !isJson(activity))
      return { status: 400, json: { error: { code: "BadArgument", message: "not an activity" } } };
    const id = decodeURIComponent(match[2]);
    this.recorder.take(op, decodeURIComponent(match[1] ?? ""), activity, id);
    return { status: 200, json: op === "delete" ? {} : { id } };
  }

  private mount(): void {
    this.server.route("POST", ACTIVITIES, (r) => this.post(r));
    this.server.route("PUT", ACTIVITIES, (r) => this.edit(r, "update"));
    this.server.route("DELETE", ACTIVITIES, (r) => this.edit(r, "delete"));
    this.server.route("POST", "/v3/conversations", (r) => {
      this.opened.push(r.json);
      return { status: 403, json: { error: { code: "BotNotInConversationRoster", message: "a made-up person" } } };
    });
    this.server.route("GET", /^\/v3\/conversations\/[^/]+\/members$/, () => ({
      status: 404,
      json: { error: { code: "NotFound", message: "no roster" } },
    }));
    this.server.route("GET", /^\/gate-files\/[^/]+$/, (r) => {
      const content = this.files.get(decodeURIComponent(r.path.slice("/gate-files/".length)));
      return content === undefined
        ? { status: 404, text: "" }
        : { status: 200, text: content, headers: { "content-type": "text/markdown" } };
    });
  }

  close(): Promise<void> {
    return this.server.close();
  }
}
