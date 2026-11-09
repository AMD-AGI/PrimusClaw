// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Claw's work-items routes as the Python tests' `assistant_fake.FakeAssistantClaw` keeps them, in memory and behind the port the
 * worker calls (the runtime client's mapping: a 409 that carries the item is a refused Decision, any other error status a
 * ClawError). Every row is its owner's (the key, or an exchanged token speaking for the same person): another person's item is
 * 404. What a worker or the router does to a row is not simulated: a test says it (`report`, `reopen`), by the plan's transition
 * table and accept rule. A failure for a call is injected in `fail`: a status (Claw's `{"ok": false, "error": "injected"}`), a
 * status with its error word, or an error to throw (no answer at all).
 */
import type { ClawWorkItemsPort, Decision, JsonObject, ReviewAskedOfOther, WorkItem } from "@primusclaw/personal-agent";

import { ClawError } from "../../packages/core/src/claw/errors.js";

/** Each key and the Claw user id it is of; an exchanged token speaks for the same person as their key. */
export const CLAW_USERS: Readonly<Record<string, string>> = {
  "ak-alice": "u-alice",
  "ak-bob": "u-bob",
  "ak-carol": "u-carol",
  "ak-dave": "u-dave",
};
export const TOKENS: Readonly<Record<string, string>> = { "tok-alice": "ak-alice", "tok-bob": "ak-bob" };

export type BoardCall = "list" | "asked" | "accept" | "stop" | "retry" | "pulls" | "watches" | "watch" | "unwatch";
export type Failure = number | readonly [number, string] | Error;

export interface Row {
  readonly itemId: string;
  readonly owner: string;
  readonly seq: number;
  title: string;
  summary: string;
  boardState: string;
  lastReportKind: string | null;
  pendingQuestion: string | null;
  outcome: string | null;
  resultVersion: number;
  acceptedVersion: number | null;
  readonly workerSessionId: string;
  tick: number;
  readonly kind: string;
  readonly params: JsonObject;
  readonly stopRefusal: string;
}

export interface AddItem {
  readonly summary?: string;
  readonly board?: string;
  readonly last?: string | null;
  readonly version?: number;
  readonly question?: string | null;
  readonly outcome?: string | null;
  readonly kind?: string;
  readonly params?: JsonObject;
  readonly stopRefusal?: string;
}

export interface Watch {
  readonly itemId: string;
  readonly pr: string;
  reply: boolean | null;
  readonly token: string;
}

interface Transition {
  readonly board: string;
  readonly question: string | null;
  readonly newResult: boolean;
  readonly outcome: string | null;
}

/** Where a worker's report moves an item (the plan's §5 table). */
function transition(kind: string, question: string | null): Transition {
  const q = question?.trim() ? question.trim() : null;
  const quiet: Transition = { board: "in_progress", question: null, newResult: false, outcome: null };
  const needs: Transition = { ...quiet, board: "needs_you" };
  const table: Record<string, Transition> = {
    progress: quiet,
    waiting: q ? { ...needs, question: q } : quiet,
    blocked: { ...needs, question: q },
    ready: { ...needs, newResult: true },
    failed: needs,
    dropped: { ...quiet, board: "done", outcome: "dropped" },
  };
  const found = table[kind];
  if (found === undefined) throw new RangeError(`not a report kind: ${kind}`);
  return found;
}

function refusedWith(status: number, error: string): ClawError {
  return new ClawError(status, JSON.stringify({ ok: false, error }));
}

export class FakeBoardClaw implements Pick<
  ClawWorkItemsPort,
  "list" | "askedOfOthers" | "accept" | "stop" | "retry" | "pulls" | "watches" | "watchPull" | "unwatchPull"
> {
  readonly items = new Map<string, Row>();
  /** owner (a key) -> the reviews they asked of others. */
  readonly asked = new Map<string, ReviewAskedOfOther[]>();
  /** False: a Claw before the asked-of-others route (the client reads it as none). */
  askedRoute = true;
  /** [method, path, Claw user id of the caller]: everything the worker asked. */
  readonly calls: [string, string, string][] = [];
  readonly fail = new Map<BoardCall, Failure>();
  /** Worker sessions a stop interrupted. */
  readonly stoppedWorkers: string[] = [];
  /** A stop closes the item, then cannot interrupt its worker (503 interrupt_not_recorded). */
  interruptFails = false;
  /** Items run again by a retry. */
  readonly retried: string[] = [];
  maxActive = 5;
  /** item id -> the pull requests its worker reported (the Python fake's `pulls`). */
  readonly reported = new Map<string, string[]>();
  /** Every subscription made; sub_id n is subscriptions[n - 1] (the Python fake's `watches`). */
  readonly subscriptions: Watch[] = [];
  readonly watchEnded: number[] = [];
  /** The tokens Claw takes `reply: true` from (the person signed in themselves). */
  attendedTokens = new Set<string>();
  private ticks = 0;
  private n = 0;

  private tick(): number {
    this.ticks += 1;
    return this.ticks;
  }

  addItem(owner: string, title: string, o: AddItem = {}): string {
    const seq = 1 + Math.max(0, ...[...this.items.values()].filter((i) => i.owner === owner).map((i) => i.seq));
    this.n += 1;
    const itemId = `wi-${String(this.n).padStart(4, "0")}`;
    this.items.set(itemId, {
      itemId,
      owner,
      seq,
      title,
      summary: o.summary ?? "",
      boardState: o.board ?? "in_progress",
      lastReportKind: o.last ?? null,
      pendingQuestion: o.question ?? null,
      outcome: o.outcome ?? null,
      resultVersion: o.version ?? 0,
      acceptedVersion: null,
      workerSessionId: `worker-${itemId}`,
      tick: this.tick(),
      kind: o.kind ?? "task",
      params: o.params ?? {},
      stopRefusal: o.stopRefusal ?? "",
    });
    return itemId;
  }

  row(itemId: string): Row {
    const row = this.items.get(itemId);
    if (row === undefined) throw new RangeError(`no item ${itemId}`);
    return row;
  }

  static canAccept(row: Row): boolean {
    return row.boardState === "needs_you" && row.lastReportKind === "ready";
  }

  view(itemId: string): WorkItem {
    const r = this.row(itemId);
    return {
      itemId: r.itemId,
      seq: r.seq,
      title: r.title,
      boardState: r.boardState,
      resultVersion: r.resultVersion,
      canAccept: FakeBoardClaw.canAccept(r),
      lastReportKind: r.lastReportKind,
      pendingQuestion: r.pendingQuestion,
      summary: r.summary,
      outcome: r.outcome,
      kind: r.kind,
      params: r.params,
      pull: null,
      updatedAt: new Date((1_700_000_000 + r.tick) * 1000).toISOString(),
    };
  }

  /** A worker's report: moves the item as the plan's table says (a closed item is not moved). */
  report(itemId: string, kind: string, summary = "", question: string | null = null): void {
    const row = this.row(itemId);
    const t = transition(kind, question);
    if (row.boardState === "done") return;
    Object.assign(row, {
      boardState: t.board,
      lastReportKind: kind,
      summary: summary || row.summary,
      pendingQuestion: t.question,
      resultVersion: row.resultVersion + (t.newResult ? 1 : 0),
      outcome: t.outcome,
      tick: this.tick(),
    });
  }

  /** The person asked for more on the item: it is in progress again and the old result is not the one to accept. */
  reopen(itemId: string): void {
    Object.assign(this.row(itemId), {
      boardState: "in_progress",
      lastReportKind: "progress",
      pendingQuestion: null,
      tick: this.tick(),
    });
  }

  /** An `assistant.say` event of the plan's §3 for `owner`: `item` carries what a card needs. */
  say(owner: string, text: string, itemId?: string): JsonObject {
    return this.event(owner, "assistant.say", text, itemId);
  }

  event(owner: string, type: string, text: string, itemId?: string, extra: JsonObject = {}): JsonObject {
    let item: JsonObject | undefined;
    if (itemId !== undefined) {
      const v = this.view(itemId);
      item = {
        item_id: v.itemId,
        seq: v.seq,
        title: v.title,
        board_state: v.boardState,
        result_version: v.resultVersion,
        can_accept: v.canAccept,
      };
    }
    this.n += 1;
    return {
      event_id: `ev-${String(this.n)}`,
      type,
      occurred_at: "2026-10-30T04:53:20Z",
      user_id: CLAW_USERS[owner] ?? "",
      text,
      ...(item ? { item } : {}),
      ...extra,
    };
  }

  /** The caller, named by the key it used; the call is recorded and a failure injected for it thrown. */
  private enter(call: BoardCall, method: string, path: string, key: string): string {
    const owner = TOKENS[key] ?? key;
    this.calls.push([method, path, CLAW_USERS[owner] ?? "?"]);
    const failure = this.fail.get(call);
    if (failure instanceof Error) throw failure;
    if (typeof failure === "number") throw refusedWith(failure, "injected");
    if (failure !== undefined) throw refusedWith(failure[0], failure[1]);
    if (CLAW_USERS[owner] === undefined) throw refusedWith(401, "unauthorized");
    return owner;
  }

  private own(owner: string, itemId: string): Row {
    const row = this.items.get(itemId);
    if (row === undefined || row.owner !== owner) throw refusedWith(404, "not_found");
    return row;
  }

  list(key: string): Promise<WorkItem[]> {
    const owner = this.enter("list", "GET", "/v1/work-items", key);
    const rows = [...this.items.values()].filter((i) => i.owner === owner).sort((a, b) => b.tick - a.tick);
    return Promise.resolve(rows.map((r) => this.view(r.itemId)));
  }

  askedOfOthers(key: string): Promise<ReviewAskedOfOther[]> {
    const owner = this.enter("asked", "GET", "/v1/work-items/asked-of-others", key);
    return Promise.resolve(this.askedRoute ? [...(this.asked.get(owner) ?? [])] : []);
  }

  accept(key: string, itemId: string, version: number): Promise<Decision> {
    const row = this.own(this.enter("accept", "POST", `/v1/work-items/${itemId}/accept`, key), itemId);
    if (FakeBoardClaw.canAccept(row) && row.resultVersion === version) {
      Object.assign(row, { boardState: "done", outcome: "accepted", acceptedVersion: version, tick: this.tick() });
      return Promise.resolve({ ok: true, item: this.view(itemId), error: "" });
    }
    const error = FakeBoardClaw.canAccept(row) ? "version_mismatch" : "not_acceptable";
    return Promise.resolve({ ok: false, item: this.view(itemId), error });
  }

  stop(key: string, itemId: string): Promise<Decision> {
    const row = this.own(this.enter("stop", "POST", `/v1/work-items/${itemId}/stop`, key), itemId);
    if (row.stopRefusal) return Promise.resolve({ ok: false, item: this.view(itemId), error: row.stopRefusal });
    if (row.boardState !== "done") {
      Object.assign(row, { boardState: "done", outcome: "stopped", pendingQuestion: null, tick: this.tick() });
    } else if (row.outcome !== "stopped") {
      return Promise.resolve({ ok: false, item: this.view(itemId), error: "item_closed" });
    }
    if (this.interruptFails) throw refusedWith(503, "interrupt_not_recorded");
    this.stoppedWorkers.push(row.workerSessionId);
    return Promise.resolve({ ok: true, item: this.view(itemId), error: "" });
  }

  /** The rule of claw's retry.ts: a task that failed, or was stopped, runs again; anything else is not_retryable. */
  retry(key: string, itemId: string): Promise<Decision> {
    const row = this.own(this.enter("retry", "POST", `/v1/work-items/${itemId}/retry`, key), itemId);
    const failed = row.boardState === "needs_you" && row.lastReportKind === "failed";
    const stopped = row.boardState === "done" && row.outcome === "stopped";
    if (row.kind !== "task" || !(failed || stopped)) {
      return Promise.resolve({ ok: false, item: this.view(itemId), error: "not_retryable" });
    }
    const active = [...this.items.values()].filter((i) => i.owner === row.owner && i.boardState !== "done").length;
    if (stopped && active >= this.maxActive) {
      return Promise.resolve({ ok: false, item: this.view(itemId), error: "too_many_active_items" });
    }
    Object.assign(row, {
      boardState: "in_progress",
      lastReportKind: "progress",
      outcome: null,
      pendingQuestion: null,
      tick: this.tick(),
    });
    this.retried.push(itemId);
    return Promise.resolve({ ok: true, item: this.view(itemId), error: "" });
  }

  pulls(key: string, itemId: string): Promise<{ item: WorkItem; pulls: string[] }> {
    this.own(this.enter("pulls", "GET", `/v1/work-items/${itemId}`, key), itemId);
    return Promise.resolve({ item: this.view(itemId), pulls: [...(this.reported.get(itemId) ?? [])] });
  }

  private watchView(n: number): JsonObject {
    const w = this.subscriptions[n - 1];
    if (w === undefined) throw new RangeError(`no watch ${String(n)}`);
    const ended = this.watchEnded.includes(n);
    return {
      sub_id: n,
      item_id: w.itemId,
      pr: "acme/app#12",
      url: w.pr,
      reply_allowed: Boolean(w.reply) && !ended,
      state: ended ? "ended" : "active",
    };
  }

  /** `reply: true` only from a token of the person signed in themselves. */
  watchPull(token: string, itemId: string, pull: string, reply?: boolean): Promise<JsonObject> {
    const row = this.own(this.enter("watch", "POST", `/v1/work-items/${itemId}/subscriptions`, token), itemId);
    if (reply === true && !this.attendedTokens.has(token)) throw refusedWith(403, "not_attended");
    if (row.boardState === "done") throw refusedWith(409, "item_closed");
    const at = this.subscriptions.findIndex(
      (w, i) => w.itemId === itemId && w.pr === pull && !this.watchEnded.includes(i + 1),
    );
    const found = this.subscriptions[at];
    if (found !== undefined) {
      if (reply !== undefined) found.reply = reply;
      return Promise.resolve({ ...this.watchView(at + 1), created: false });
    }
    this.subscriptions.push({ itemId, pr: pull, reply: reply ?? null, token });
    return Promise.resolve({ ...this.watchView(this.subscriptions.length), created: true });
  }

  watches(key: string, itemId: string): Promise<JsonObject[]> {
    this.own(this.enter("watches", "GET", `/v1/work-items/${itemId}/subscriptions`, key), itemId);
    const ns = this.subscriptions.flatMap((w, i) => (w.itemId === itemId ? [i + 1] : []));
    return Promise.resolve(ns.map((n) => this.watchView(n)));
  }

  unwatchPull(key: string, itemId: string, subId: string): Promise<JsonObject> {
    const owner = this.enter("unwatch", "DELETE", `/v1/work-items/${itemId}/subscriptions/${subId}`, key);
    const row = this.items.get(itemId);
    const n = /^[0-9]+$/.test(subId) ? Number(subId) : 0;
    if (
      row?.owner !== owner ||
      n < 1 ||
      n > this.subscriptions.length ||
      this.subscriptions[n - 1]?.itemId !== itemId
    ) {
      throw refusedWith(404, "not_found");
    }
    if (!this.watchEnded.includes(n)) this.watchEnded.push(n);
    return Promise.resolve(this.watchView(n));
  }
}
