// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The worker's counters for the operator's alerts, in memory (they start from zero when the worker restarts), written in
 * the Prometheus text format for `GET /metrics` on its own port (the listener is the channel's assembly). The text is
 * the Python worker's, line for line: the alert queries and dashboards read these names and labels.
 */
import {
  CATEGORIES,
  DELIVERED_EVENT_TYPES,
  FILES_DROPPED_PATHS,
  LIMIT_REASONS,
  SECURITY_EVENTS,
  SECURITY_EVENT_LABELS,
  type Clock,
  type MetricsPort,
  type SecurityEventRecord,
} from "@primusclaw/personal-agent";
import { Histogram } from "./exposition.js";

export const CONTENT_TYPE = "text/plain; version=0.0.4; charset=utf-8";
/** `clawy_inbound_lag_max_ms`: the longest wait of the messages handled in this many milliseconds. */
export const LAG_WINDOW_MS = 60_000;
/** Seconds; the 5 s bucket is the "card within 5 s" line. */
export const EVENT_BUCKETS = [0.5, 1.0, 2.0, 3.0, 5.0, 10.0, 30.0, 60.0] as const;

type Labels = ReadonlyArray<readonly [string, string]>;

/** Series written as 0 from the start, so that each one an alert reads exists before its first event. */
export const ALERTED: ReadonlyArray<readonly [string, Labels]> = [
  ["link_lockout", [["scope", "global"]]],
  ["link_lockout", [["scope", "user"]]],
  [
    "rate_limited",
    [
      ["scope", "user"],
      ["reason", "user_limit"],
    ],
  ],
  [
    "rate_limited",
    [
      ["scope", "user"],
      ["reason", "concurrency_limit"],
    ],
  ],
  ["link_attempt", [["outcome", "wrong"]]],
  ["key_unlinked", [["reason", "rejected"]]],
];

/** Every metric: its type and help text. */
export const HELP: Readonly<Record<string, readonly [string, string]>> = {
  clawy_security_events_total: ["counter", "Security events logged by the worker, by event and category."],
  clawy_inbound_handled_total: ["counter", "Inbound messages handled (completed or abandoned)."],
  clawy_inbound_failed_total: [
    "counter",
    "Inbound messages whose handler failed and that were abandoned for redelivery.",
  ],
  clawy_inbound_handle_ms_total: ["counter", "Milliseconds spent handling inbound messages, summed."],
  clawy_inbound_lag_max_ms: [
    "gauge",
    "Longest time a message handled in the last 60 seconds waited in the inbound queue.",
  ],
  clawy_inbound_limited_total: ["counter", "Messages and tasks refused by a per-user limit, by reason."],
  clawy_event_handle_seconds: [
    "histogram",
    "Seconds from receiving a Claw event to having sent it to the chat, by event type.",
  ],
  clawy_event_to_chat_seconds: [
    "histogram",
    "Seconds from when Claw says an event happened to having sent it to the chat, by event type.",
  ],
  clawy_files_dropped_total: ["counter", "Files a user sent that did not reach Claw, by where they were dropped."],
};

/** Python's ordering of `(event, ((name, value), ...))` tuples. */
function compareTuples(a: readonly string[], b: readonly string[]): number {
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    const x = a[i] ?? "";
    const y = b[i] ?? "";
    if (x !== y) return x < y ? -1 : 1;
  }
  return a.length - b.length;
}

const keyOf = (event: string, labels: Labels): string => JSON.stringify([event, labels]);

/** A count per closed-list word, written as 0 from the start. */
function zeros(words: readonly string[]): Map<string, number> {
  return new Map(words.map((w) => [w, 0]));
}

/** The MetricsPort of a worker, kept in memory and written in the Prometheus text format. */
export class PrometheusMetrics implements MetricsPort {
  private readonly events = new Map<string, { event: string; labels: Labels; value: number }>();
  private handledCount = 0;
  private failedCount = 0;
  private handleMsTotal = 0;
  private readonly limits = zeros(LIMIT_REASONS);
  private readonly dropped = zeros(FILES_DROPPED_PATHS);
  /** (when, lag): decreasing lags, the sliding-window maximum. */
  private readonly lags: Array<readonly [number, number]> = [];
  /** Event type -> (receipt to sent, occurred to sent), each written from the start. */
  private readonly eventTimes = new Map(
    DELIVERED_EVENT_TYPES.map((t) => [t as string, [new Histogram(EVENT_BUCKETS), new Histogram(EVENT_BUCKETS)]]),
  );

  constructor(
    private readonly clock: Clock,
    private readonly lagWindowMs = LAG_WINDOW_MS,
  ) {
    for (const [event, labels] of ALERTED) this.events.set(keyOf(event, labels), { event, labels, value: 0 });
  }

  /** Inbound messages handled so far. */
  get handled(): number {
    return this.handledCount;
  }

  eventDelivered(eventType: string, handleSeconds: number, sinceOccurredSeconds: number | null): void {
    const [handle, since] = this.eventTimes.get(eventType) ?? this.eventTimes.get("other") ?? [];
    handle?.observe(handleSeconds);
    if (sinceOccurredSeconds !== null) since?.observe(sinceOccurredSeconds);
  }

  securityEvent(record: SecurityEventRecord): void {
    const event = record.event as string;
    if (!Object.hasOwn(SECURITY_EVENTS, event)) return;
    const labels: Labels = SECURITY_EVENT_LABELS.flatMap((name) => {
      const value = record[name];
      return typeof value === "string" && CATEGORIES[name]?.has(value) === true ? [[name, value] as const] : [];
    });
    const key = keyOf(event, labels);
    const found = this.events.get(key) ?? { event, labels, value: 0 };
    this.events.set(key, { ...found, value: found.value + 1 });
  }

  processed(lagMs: number | null, handleMs: number, ok: boolean): void {
    const now = this.clock.monotonicMs();
    this.handledCount += 1;
    if (!ok) this.failedCount += 1;
    this.handleMsTotal += Math.max(Math.trunc(handleMs), 0);
    if (lagMs !== null) {
      const lag = Math.max(Math.trunc(lagMs), 0);
      while ((this.lags.at(-1)?.[1] ?? Infinity) <= lag) this.lags.pop();
      this.lags.push([now, lag]);
    }
    this.expire(now);
  }

  limited(reason: string): void {
    const known = this.limits.has(reason) ? reason : "user_limit";
    this.limits.set(known, (this.limits.get(known) ?? 0) + 1);
  }

  filesDropped(path: string, count = 1): void {
    const current = this.dropped.get(path);
    if (current === undefined || count <= 0) return;
    this.dropped.set(path, current + Math.trunc(count));
  }

  /** The longest wait of the messages handled in the window, in milliseconds (0: none). */
  lagMaxMs(): number {
    this.expire(this.clock.monotonicMs());
    return this.lags[0]?.[1] ?? 0;
  }

  private expire(now: number): void {
    while ((this.lags[0]?.[0] ?? Infinity) <= now - this.lagWindowMs) this.lags.shift();
  }

  /** All series in the Prometheus text exposition format (version 0.0.4). */
  render(): string {
    const lines: string[] = [];
    const head = (name: string): void => {
      const [kind, text] = HELP[name] ?? ["untyped", ""];
      lines.push(`# HELP ${name} ${text}`, `# TYPE ${name} ${kind}`);
    };
    head("clawy_security_events_total");
    const events = [...this.events.values()].sort((a, b) =>
      compareTuples([a.event, ...a.labels.flat()], [b.event, ...b.labels.flat()]),
    );
    for (const { event, labels, value } of events) {
      const pairs = [["event", event] as const, ...labels].map(([k, v]) => `${k}="${v}"`).join(",");
      lines.push(`clawy_security_events_total{${pairs}} ${String(value)}`);
    }
    const plain: ReadonlyArray<readonly [string, number]> = [
      ["clawy_inbound_handled_total", this.handledCount],
      ["clawy_inbound_failed_total", this.failedCount],
      ["clawy_inbound_handle_ms_total", this.handleMsTotal],
      ["clawy_inbound_lag_max_ms", this.lagMaxMs()],
    ];
    for (const [name, value] of plain) {
      head(name);
      lines.push(`${name} ${String(value)}`);
    }
    head("clawy_inbound_limited_total");
    for (const [reason, value] of [...this.limits].sort(([a], [b]) => compareTuples([a], [b]))) {
      lines.push(`clawy_inbound_limited_total{reason="${reason}"} ${String(value)}`);
    }
    this.renderHistograms(lines, head);
    head("clawy_files_dropped_total");
    for (const [path, value] of [...this.dropped].sort(([a], [b]) => compareTuples([a], [b]))) {
      lines.push(`clawy_files_dropped_total{path="${path}"} ${String(value)}`);
    }
    return lines.join("\n") + "\n";
  }

  private renderHistograms(lines: string[], head: (name: string) => void): void {
    (["clawy_event_handle_seconds", "clawy_event_to_chat_seconds"] as const).forEach((name, position) => {
      head(name);
      for (const type of DELIVERED_EVENT_TYPES) {
        lines.push(...(this.eventTimes.get(type)?.[position]?.lines(name, `type="${type}"`) ?? []));
      }
    });
  }
}
