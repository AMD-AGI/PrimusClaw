// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The personal agent's Teams ingress: the public side of the Teams bot. It replaces the Python Function the personal
 * agent first ran behind (function_app.py), request for request.
 *
 * It is deliberately almost empty: validate the Bot Framework token, decide which path the activity takes, hand it to
 * the worker's Service Bus queue, return. It holds no business logic, no internal network access and no database, so
 * compromising it yields very little.
 *
 * Activity paths, matching the worker (@primusclaw/personal-agent-teams):
 *
 * - `message` and lifecycle activities are queued and answered out of band.
 * - `adaptiveCard/action` is queued too, and answered at once with a static placeholder card that the worker replaces
 *   via updateActivity (and, because a phone does not redraw that edit, whose outcome it also posts as a new message).
 * - Feedback invokes (`message/submitAction`) are queued and acknowledged with an empty HTTP 200. A card or a
 *   composeExtension result in the body shows "Unable to reach app".
 * - The remaining invokes (message extension search, link unfurling, dialogs) cannot be deferred, because Teams is
 *   holding a spinner and there is no "update later". They are answered with an empty result rather than a hang.
 *
 * The outbound trigger is the fallback delivery path (the worker's OUTBOUND_MODE=servicebus): the worker hands what it
 * does not post itself to the outbound queue, and this delivers it, signing in as the bot's user-assigned managed
 * identity.
 *
 * Service Bus access is identity based when `<prefix>__fullyQualifiedNamespace` is set (the Azure Functions
 * convention, so the outbound trigger and the inbound sender read the same kind of settings) and falls back to the
 * queue SAS connection strings otherwise (docs/configuration.md, "Teams ingress").
 *
 * Everything is read when an Ingress is created (src/main.ts creates one per worker process); tests create one per case
 * with their own settings and fakes. A request's log records go to the sink it is handled with (the invocation's).
 */
import { randomUUID } from "node:crypto";

import { SECURITY_LOGGER, securityEventRecord, type SecurityEventRecord } from "@primusclaw/personal-agent";

import { Auth, AuthError, authSettings } from "./auth.js";
import { MsiTokenProvider } from "./bot-msi.js";
import { type Clock, type Env, type Fetch, SYSTEM_CLOCK } from "./env.js";
import { coreLogger, type Logger, logger, type LogSink } from "./log.js";
import {
  ACK_TYPE,
  connectorErrorCode,
  connectorUrl,
  type ConnectorResponse,
  dictGet,
  responseJson,
  withReference,
} from "./outbound.js";
import {
  EMPTY,
  get,
  hostname,
  isObject,
  type Json,
  type JsonObject,
  or,
  PyValueError,
  str,
  strip,
  truthy,
  urlsplit,
} from "./py.js";
import { dumps, loads, plain, type PyValue } from "./py-json.js";
import { boundedId, type QueueClient, type QueueMessage, type QueueSender, type ServiceBusFactory } from "./queue.js";
import {
  cardResponse,
  empty,
  EMPTY_INVOKE_RESULT,
  jsonReply,
  PLACEHOLDER_CARD,
  type Reply,
  UNAVAILABLE_CARD,
} from "./replies.js";
import {
  INBOUND_IDENTITY_PREFIX,
  namespaceHost,
  OUTBOUND_CONNECTION_SETTING,
  OUTBOUND_IDENTITY_SETTING,
  readSettings,
  type Settings,
} from "./settings.js";

// Invokes that can be deferred behind a placeholder card.
const DEFERRABLE_INVOKES: ReadonlySet<string> = new Set(["adaptiveCard/action"]);
// Invokes that are queued and acknowledged with an empty HTTP 200.
const ACK_ONLY_INVOKES: ReadonlySet<string> = new Set(["message/submitAction"]);

// How long a message waits for the start-up prefetch to finish opening the sender before opening one itself.
export const PREFETCH_WAIT_SECONDS = 3.0;

// How long a message may take to reach the inbound queue, both attempts and the SDK's retries included, before it is
// a 500 that Teams retries. Well inside host.json's functionTimeout (30 s), so a stuck send never runs into the host's
// timeout, which restarts the worker and with it every other request on the instance.
export const SEND_DEADLINE_SECONDS = 20.0;

/** An HTTP request as the handler sees it. */
export interface Request {
  headers: { get(name: string): string | null };
  body: Uint8Array;
}

export interface Deps {
  env: Env;
  fetch: Fetch;
  /** Where records go outside a request (at start-up), and for a request handled without a sink of its own. */
  log: LogSink;
  serviceBus: ServiceBusFactory;
  clock?: Clock;
  /** Starts the start-up prefetch in the background; tests record the call instead. */
  spawn?: (name: string, task: () => Promise<void>) => void;
  uuid?: () => string;
}

/** The loggers one request writes to. */
interface Logs {
  sink: LogSink;
  app: Logger;
  msi: Logger;
}

/** `data.decode("utf-8")`, strict, a BOM kept as a character; null where Python raises UnicodeDecodeError. */
function decodeUtf8(data: Uint8Array): string | null {
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(data);
  } catch {
    return null;
  }
}

/**
 * HttpRequest.get_json(): json.loads(body.decode("utf-8")); a ValueError (a UnicodeDecodeError included) leaves no
 * document. A RecursionError is not a ValueError: Python let it out, and so does this (a 500).
 */
function parseBody(data: Uint8Array): PyValue | null {
  const text = decodeUtf8(data);
  if (text === null) return null;
  try {
    return loads(text);
  } catch (error) {
    if (!(error instanceof PyValueError)) throw error;
    return null;
  }
}

const sleep = (ms: number): Promise<void> =>
  new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref();
  });

/**
 * Which path an activity takes: `queued` (a message, a lifecycle activity, a feedback invoke: queued, an empty 200),
 * `deferred` (a card action: queued, the placeholder card) or `sync` (any other invoke: the empty result, not queued).
 * `name` is the invoke's name; one that is not a string (the caller's) is no invoke we answer.
 */
function pathOf(activity: JsonObject): { path: "queued" | "deferred" | "sync"; name: string } {
  const rawName = get(activity, "name");
  const name = typeof rawName === "string" ? rawName : "";
  if (get(activity, "type") !== "invoke" || ACK_ONLY_INVOKES.has(name)) return { path: "queued", name };
  return { path: DEFERRABLE_INVOKES.has(name) ? "deferred" : "sync", name };
}

const errorName = (error: unknown): string => (error instanceof Error ? error.name : "Error");

/**
 * `work`, or the deadline's reason once `deadline` fires, whichever comes first, so a send that ignores its abort
 * signal still ends at the deadline.
 */
function beforeDeadline<T>(work: Promise<T>, deadline: AbortSignal): Promise<T> {
  const reason = (): Error =>
    deadline.reason instanceof Error ? deadline.reason : new Error("the inbound send deadline passed");
  if (deadline.aborted) return Promise.reject(reason());
  let onAbort = (): void => undefined;
  const expired = new Promise<never>((_resolve, reject) => {
    onAbort = () => {
      reject(reason());
    };
    deadline.addEventListener("abort", onAbort, { once: true });
  });
  return Promise.race([work, expired]).finally(() => {
    deadline.removeEventListener("abort", onAbort);
  });
}

export class Ingress {
  readonly settings: Settings;
  readonly auth: Auth;
  readonly tokens: MsiTokenProvider;
  private readonly fetchImpl: Fetch;
  private readonly logs: Logs;
  private readonly serviceBus: ServiceBusFactory;
  private readonly clock: Clock;
  private readonly uuid: () => string;

  private senderClient: QueueClient | null = null;
  /** The inbound-queue sender, opened once per instance and kept. */
  inbound: QueueSender | null = null;
  prefetch: Promise<void> | null = null;
  private prefetchDone = false;
  private prefetchReport: string | null = null;
  prefetchWaitSeconds = PREFETCH_WAIT_SECONDS;
  sendDeadlineSeconds = SEND_DEADLINE_SECONDS;

  constructor(deps: Deps) {
    this.fetchImpl = deps.fetch;
    this.logs = this.logsFor(deps.log);
    this.serviceBus = deps.serviceBus;
    this.clock = deps.clock ?? SYSTEM_CLOCK;
    this.uuid = deps.uuid ?? randomUUID;
    this.settings = readSettings(deps.env);
    this.auth = new Auth(authSettings(deps.env, coreLogger(deps.log, "connector_hosts")), deps.fetch, this.clock);
    this.tokens = new MsiTokenProvider(
      this.settings.botAppId,
      "PRIMUSCLAW_BOT_APP_ID",
      deps.env,
      deps.fetch,
      this.logs.msi,
      this.clock,
    );
    if (!this.settings.outboundConfigured) {
      this.logs.app.warning(
        `outbound trigger not registered: neither ${OUTBOUND_CONNECTION_SETTING} nor ${OUTBOUND_IDENTITY_SETTING} is set`,
      );
    }
    // Only on a hosted instance: tests and local runs create an Ingress and must not reach the network from it.
    const s = this.settings;
    if (s.hosted && s.botAppId && (s.inboundNamespace || s.inboundConnectionString)) {
      const spawn = deps.spawn ?? ((_name: string, task: () => Promise<void>) => void task());
      spawn("ingress-prefetch", () => this.startPrefetch());
    }
  }

  private logsFor(sink: LogSink): Logs {
    return { sink, app: logger(sink, "function_app"), msi: logger(sink, "bot_msi") };
  }

  // --- Service Bus ----------------------------------------------------------------------------------------------

  /** The inbound-queue client: managed identity when a namespace is set, else the SAS connection string. */
  newClient(log: Logger = this.logs.app): QueueClient {
    const s = this.settings;
    const prefix = INBOUND_IDENTITY_PREFIX;
    if (!s.inboundNamespace) {
      if (!s.inboundConnectionString) {
        throw new PyValueError(
          `neither ${prefix}__fullyQualifiedNamespace nor PRIMUSCLAW_SERVICEBUS_CONNECTION_STRING is set`,
        );
      }
      return this.serviceBus.fromConnectionString(s.inboundConnectionString);
    }
    const namespace = namespaceHost(s.inboundNamespace);
    if (!namespace || namespace.includes("=") || namespace.includes(";")) {
      // A connection string pasted into the namespace setting; never echo it.
      throw new PyValueError(`${prefix}__fullyQualifiedNamespace is not a host name`);
    }
    if (s.inboundCredential && s.inboundCredential !== "managedidentity") {
      throw new PyValueError(`${prefix}__credential must be managedidentity or unset`);
    }
    if (!s.inboundCredential && !s.inboundIdentityClientId) {
      throw new PyValueError(
        `${prefix}__clientId (or PRIMUSCLAW_BOT_APP_ID) is needed for a user-assigned identity; ` +
          `set ${prefix}__credential=managedidentity for the system-assigned one`,
      );
    }
    if (s.inboundConnectionString) {
      log.warning(
        "inbound Service Bus uses the managed identity; PRIMUSCLAW_SERVICEBUS_CONNECTION_STRING is ignored " +
          "and can be removed",
      );
    }
    // No client id: the app's system-assigned identity.
    return this.serviceBus.fromIdentity(namespace, s.inboundIdentityClientId || null);
  }

  /** Reused across invocations on a warm worker; the SDK handles reconnects. */
  private client(log: Logger): QueueClient {
    this.senderClient ??= this.newClient(log);
    return this.senderClient;
  }

  private async closeQuietly(sender: QueueSender, log: Logger): Promise<void> {
    try {
      await sender.close();
    } catch (error) {
      // a sender being thrown away; its close cannot change anything
      log.debug("closing a discarded inbound sender failed", error);
    }
  }

  /**
   * Send on the instance's inbound sender, opening it on first use. A failed send discards the sender and tries once
   * more on a new one, so a kept sender left broken (the service closes idle connections) costs one message a retry
   * instead of every later message an error. The worker dedupes on the activity id, so a message the broker took
   * before the error was seen is not handled twice.
   *
   * Sends on one instance run concurrently on the shared sender (the SDK's sender takes concurrent sends), so a send
   * that hangs holds up only its own request: it fails after `sendDeadlineSeconds`, and the request is a 500. Only the
   * request whose send failed discards the sender, and only while it is still the instance's sender, so a request
   * never throws away a sender another one has just opened.
   */
  async sendInbound(message: QueueMessage, log: Logger = this.logs.app): Promise<void> {
    const deadline = AbortSignal.timeout(this.sendDeadlineSeconds * 1000);
    if (this.inbound === null && this.prefetch !== null && !this.prefetchDone) {
      // A cold instance: the prefetch is already opening the sender, and a second one would only race it.
      await Promise.race([this.prefetch, sleep(this.prefetchWaitSeconds * 1000)]);
    }
    for (const attempt of [1, 2]) {
      this.inbound ??= this.client(log).createSender(this.settings.inboundQueue);
      const sender = this.inbound;
      try {
        await beforeDeadline(sender.sendMessages(message, { abortSignal: deadline }), deadline);
        return;
      } catch (error) {
        if (this.inbound === sender) {
          this.inbound = null;
          // Not awaited: closing a sender whose connection hangs must not hold this request past its deadline.
          void this.closeQuietly(sender, log);
        }
        if (attempt === 2 || deadline.aborted) throw error;
        log.warning("inbound send failed; retrying once on a new sender", error);
      }
    }
  }

  /**
   * Open the inbound sender while the Functions host is still starting, so the first message does not pay for the
   * Service Bus connection and the managed-identity token. Best effort: when it fails, the first send opens a sender
   * itself.
   */
  async prefetchSender(): Promise<void> {
    const started = this.clock.monotonic();
    let sender: QueueSender | null = null;
    let report: string;
    try {
      sender = this.client(this.logs.app).createSender(this.settings.inboundQueue);
      await sender.createMessageBatch(); // opens the connection and the link, which takes the token
      if (this.inbound === null) {
        // else a message opened its own meanwhile, and this one is closed below
        this.inbound = sender;
        sender = null;
      }
      report = `inbound sender ${String(Math.trunc((this.clock.monotonic() - started) * 1000))} ms`;
    } catch (error) {
      report = `inbound sender failed (${errorName(error)})`;
    } finally {
      if (sender !== null) await this.closeQuietly(sender, this.logs.app);
    }
    this.prefetchReport = report;
  }

  startPrefetch(): Promise<void> {
    this.prefetchDone = false;
    this.prefetch = this.prefetchSender().finally(() => {
      this.prefetchDone = true;
    });
    return this.prefetch;
  }

  logPrefetchOnce(log: Logger = this.logs.app): void {
    const report = this.prefetchReport;
    this.prefetchReport = null;
    if (report) log.info(`start-up prefetch: ${report}`);
  }

  // --- the messaging endpoint -------------------------------------------------------------------------------------

  /**
   * The bot's messaging endpoint: `POST /api/messages`. Throws where the Python function raised (a 500). `sink` is
   * where this request's log records go (the invocation's; the Ingress's own sink when not given).
   */
  async messages(req: Request, sink?: LogSink): Promise<Reply> {
    const logs = sink === undefined ? this.logs : this.logsFor(sink);
    this.logPrefetchOnce(logs.app);
    const body = parseBody(req.body);
    const activity = body instanceof Map ? (plain(body) as JsonObject) : null;

    // Authenticate before anything else is decided, so an unauthenticated caller gets a 401 whatever it sent.
    const refused = await this.authenticate(req, activity, logs.sink);
    if (refused !== null) return refused;
    if (activity === null || body === null) return empty(400);

    return this.route(req, activity, body, logs.app);
  }

  /** An authenticated activity: queue it (or answer a synchronous invoke at once), and the reply Teams gets. */
  private async route(req: Request, activity: JsonObject, body: PyValue, log: Logger): Promise<Reply> {
    const correlationId = req.headers.get("x-correlation-id") || this.uuid();
    const { path, name } = pathOf(activity);
    if (path === "sync") {
      // A line break in the caller's name is taken out before it is logged, so it cannot forge a log line (CWE-117).
      log.info(`no sync transport for invoke ${name.replace(/[\r\n]/g, "")}; returning empty result`);
      return jsonReply(EMPTY_INVOKE_RESULT);
    }
    try {
      await this.enqueue(activity, body, correlationId, log);
    } catch (error) {
      log.error("failed to enqueue activity", error);
      if (path === "deferred") return cardResponse(UNAVAILABLE_CARD);
      // Returning 500 lets Teams retry the message; the worker dedupes on activity.id so a retry cannot double-process.
      return empty(500);
    }
    return path === "deferred" ? cardResponse(PLACEHOLDER_CARD) : empty(200);
  }

  /** The token check for a request; a 401 (with its security event) when it fails, null when it passes. */
  private async authenticate(req: Request, activity: JsonObject | null, sink: LogSink): Promise<Reply | null> {
    const serviceUrl = activity ? get(activity, "serviceUrl") : undefined;
    const authorization = req.headers.get("Authorization");
    try {
      if (activity === null) {
        // Not an activity: refused with a 400 once the caller has authenticated. There is no serviceUrl to bind the
        // token to, and nothing is queued, so the token alone decides 401 or 400.
        await this.validateToken(authorization, { appId: this.settings.botAppId });
      } else {
        await this.validate(authorization, { appId: this.settings.botAppId, serviceUrl });
      }
      return null;
    } catch (error) {
      if (!(error instanceof AuthError)) throw error;
      // One structured record per refusal, for a burst alert: the category, the host the activity named and where the
      // request came from. Never the token, the header or the exception text (parts of it are the caller's).
      tokenRejected(sink, { reason: error.reason, service_url_host: urlHost(serviceUrl), client_ip: clientIp(req) });
      return empty(401);
    }
  }

  /** The token check with the serviceUrl binding (Auth.validate); a seam tests replace. */
  validate(authorization: string | null, kw: { appId: string; serviceUrl: unknown }): Promise<JsonObject> {
    return this.auth.validate(authorization, kw.appId, kw.serviceUrl);
  }

  /** The token check alone (Auth.validateToken); a seam tests replace. */
  validateToken(authorization: string | null, kw: { appId: string }): Promise<JsonObject> {
    return this.auth.validateToken(authorization, kw.appId);
  }

  /** Queue the activity, raw, on its conversation's session. `node` is the parsed document it came from. */
  async enqueue(
    activity: JsonObject,
    node: PyValue,
    correlationId: string,
    log: Logger = this.logs.app,
  ): Promise<void> {
    // Ordering is only guaranteed within a session, and a conversation is the unit that needs it. The queue requires
    // sessions.
    const conversation = or(get(activity, "conversation"), EMPTY);
    const conversationId = or(dictGet(conversation, "id"), correlationId);
    const activityId = get(activity, "id");
    await this.sendInbound(
      {
        body: Buffer.from(dumps(node), "utf8"),
        contentType: "application/json",
        correlationId,
        sessionId: boundedId(str(conversationId)),
        // The Python SDK gives a message without an id a random one; the JavaScript SDK sends none.
        messageId: truthy(activityId) ? boundedId(str(activityId)) : this.uuid(),
      },
      log,
    );
  }

  // --- the outbound trigger -----------------------------------------------------------------------------------------

  /** Deliver what the worker queued, signing in as the bot's UAMI. `body` is the queue message's body. */
  async outbound(body: unknown, sink?: LogSink): Promise<void> {
    const logs = sink === undefined ? this.logs : this.logsFor(sink);
    this.logPrefetchOnce(logs.app);
    let envelope: unknown;
    if (body instanceof Uint8Array || typeof body === "string") {
      const text = typeof body === "string" ? body : decodeUtf8(body);
      if (text === null) throw new PyValueError("outbound body is not JSON");
      try {
        envelope = plain(loads(text));
      } catch (error) {
        if (error instanceof PyValueError) throw new PyValueError("outbound body is not JSON", { cause: error });
        throw error;
      }
    } else {
      // The Functions worker hands a JSON body over already parsed.
      envelope = body;
    }
    if (!isObject(envelope)) throw new PyValueError("outbound body must be an object");
    await this.deliverOutbound(envelope, logs);
  }

  /**
   * POST/PUT one Bot Connector activity. Envelope shape is owned by the worker. Operations: `send` (new activity),
   * `reply` (into the thread of `reference.activityId`), `update` (PUT over `activity_id`). A typing indicator is a
   * `send`/`reply` whose activity has `type: typing`. An envelope with `ack` gets a `primusclaw.delivered` message back
   * on the inbound queue carrying the posted activity's id.
   */
  async deliverOutbound(envelope: JsonObject, logs: Logs = this.logs): Promise<void> {
    const operation = str(or(get(envelope, "operation"), "send")).toLowerCase();
    const reference = or(get(envelope, "reference"), EMPTY);
    const activity = or(get(envelope, "activity"), EMPTY);
    if (!isObject(reference) || !isObject(activity)) {
      throw new PyValueError("outbound envelope needs reference and activity objects");
    }
    const url = this.connectorUrl(reference, operation, get(envelope, "activity_id"));
    const body = withReference(activity, reference);
    if (operation === "update") {
      body["id"] = or(get(envelope, "activity_id"), get(body, "id") ?? null) ?? null;
    }
    const resp = await this.post(url, operation, body, logs);
    const ack = get(envelope, "ack");
    if (truthy(ack) && operation !== "update") await this.ackDelivery(str(ack), reference, resp, logs.app);
  }

  /** The Connector call itself, and what its answer means: 401, 429 and 5xx throw (the trigger retries), as do refusals. */
  private async post(url: string, operation: string, body: JsonObject, logs: Logs): Promise<ConnectorResponse> {
    const token = await this.tokens.get(logs.msi);
    let resp: ConnectorResponse;
    try {
      // requests' json=: json.dumps(body, allow_nan=False), a failure of which requests raises as a RequestException.
      const payload = dumps(body, { allowNan: false });
      const response = await this.fetchImpl(url, {
        method: operation !== "update" ? "POST" : "PUT",
        body: payload,
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        signal: AbortSignal.timeout(30_000),
      });
      resp = { status: response.status, ok: response.status < 400, text: await response.text() };
    } catch (error) {
      throw new Error(`bot connector ${operation} failed: ${error instanceof Error ? error.message : String(error)}`, {
        cause: error,
      });
    }
    if (resp.status === 401) {
      this.tokens.invalidate();
      throw new Error("bot connector rejected the managed-identity token");
    }
    const status = String(resp.status);
    if (resp.status >= 500 || resp.status === 429) throw new Error(`bot connector ${operation} got ${status}`);
    if (!resp.ok) {
      // The status and the Connector's error code only: the body of a refusal can quote the activity it refused.
      logs.app.error(`bot connector ${operation} failed ${status} (${connectorErrorCode(resp)})`);
      throw new Error(`bot connector ${operation} failed ${status}`);
    }
    return resp;
  }

  /**
   * Tell the worker which activity id Teams gave the message, so it can edit it later. Best effort: the message is
   * already posted, and raising here would make the trigger retry and post it twice.
   */
  private async ackDelivery(ack: string, reference: JsonObject, resp: ConnectorResponse, log: Logger): Promise<void> {
    let activityId: Json | undefined;
    let activityIdNode: PyValue | undefined;
    try {
      const { value, node } = responseJson(resp);
      // (resp.json() or {}).get("id"): a non-dict answer raises AttributeError, which Python does not catch here.
      activityId = dictGet(or(value, EMPTY), "id");
      activityIdNode = node instanceof Map ? node.get("id") : undefined;
    } catch (error) {
      if (!(error instanceof PyValueError)) throw error;
      activityId = undefined;
    }
    if (!truthy(activityId)) {
      log.warning(`bot connector returned no activity id for ack ${ack}`);
      return;
    }
    const conversationId = or(dictGet(or(get(reference, "conversation"), EMPTY), "id"), ack);
    const document = new Map<string, unknown>([
      ["type", ACK_TYPE],
      ["ack", ack],
      ["activity_id", activityIdNode ?? activityId],
    ]);
    const message: QueueMessage = {
      body: Buffer.from(dumps(document), "utf8"),
      contentType: "application/json",
      correlationId: ack,
      sessionId: boundedId(str(conversationId)),
      messageId: this.uuid(),
    };
    try {
      await this.sendInbound(message, log);
    } catch (error) {
      log.error(`failed to ack delivery ${ack}`, error);
    }
  }

  connectorUrl(reference: JsonObject, operation: string, activityId: unknown): string {
    return connectorUrl(this.auth.serviceUrlHosts, reference, operation, activityId);
  }
}

/**
 * Log one `token_rejected` security event (core's record: only allow-listed, shape-checked fields) on the security
 * logger, at warning, the line SIEM rules and the burst alert match; the record that was logged.
 */
export function tokenRejected(sink: LogSink, fields: Readonly<Record<string, unknown>>): SecurityEventRecord {
  const record = securityEventRecord("token_rejected", fields);
  sink({ logger: SECURITY_LOGGER, level: "warning", message: JSON.stringify(record) });
  return record;
}

/** The host of a URL the caller sent, for the log; the security event helper drops anything not shaped like one. */
export function urlHost(url: unknown): string | null {
  if (typeof url !== "string") return null;
  try {
    return hostname(urlsplit(url));
  } catch (error) {
    if (error instanceof PyValueError) return null;
    throw error;
  }
}

/**
 * The address the request came from, as the Functions front end reports it. The front end appends the client's
 * address (with its port) to `X-Forwarded-For`; whatever is before it was written by the caller and is not trusted,
 * so the last entry is taken. The security event helper drops anything that is not an IP address.
 */
export function clientIp(req: Request): string | null {
  const forwarded = req.headers.get("X-Forwarded-For") || "";
  let entry = strip(forwarded.slice(forwarded.lastIndexOf(",") + 1));
  if (entry.startsWith("[")) {
    // [2001:db8::1]:443
    entry = entry.slice(1).split("]")[0] ?? "";
  } else if ((entry.match(/:/g) ?? []).length === 1) {
    // 203.0.113.7:51234
    entry = entry.split(":")[0] ?? "";
  }
  return entry || null;
}

export function createIngress(deps: Deps): Ingress {
  return new Ingress(deps);
}
