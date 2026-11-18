// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * An in-memory Claw board for one person's work items (the Python tests' `assistant_fake` work-item routes): accept pins the
 * version, stop and retry follow Claw's refusals (409 with the item as it is now), and an item watches pull requests. A
 * failure for a call is set in `fail` as the error the real client throws.
 */
import type { ClawWorkItemsPort, Decision, JsonObject, ReviewAskedOfOther, WorkItem } from "@primusclaw/personal-agent";
import { ClawError } from "@primusclaw/personal-agent";

type Call = "list" | "asked" | "item" | "accept" | "stop" | "retry" | "pulls" | "watches" | "watch" | "unwatch";

export function workItem(extra: Partial<WorkItem> & { itemId: string }): WorkItem {
  return {
    seq: 1,
    title: "Fix the flaky test",
    boardState: "needs_you",
    resultVersion: 1,
    canAccept: true,
    lastReportKind: "ready",
    pendingQuestion: null,
    summary: "Done.",
    outcome: null,
    kind: "task",
    params: {},
    pull: null,
    updatedAt: "",
    ...extra,
  };
}

export class FakeWorkItems implements Pick<
  ClawWorkItemsPort,
  "list" | "askedOfOthers" | "get" | "accept" | "stop" | "retry" | "pulls" | "watches" | "watchPull" | "unwatchPull"
> {
  readonly items = new Map<string, WorkItem>();
  readonly asked: ReviewAskedOfOther[] = [];
  readonly pullsOf = new Map<string, string[]>();
  readonly subs = new Map<string, JsonObject[]>();
  readonly calls: string[] = [];
  readonly fail = new Map<Call, Error>();
  /** The 409 error word a stop gets (`already_merged`, `merge_in_progress`), per item. */
  readonly stopRefusal = new Map<string, string>();
  retryRefusal = "";

  add(item: WorkItem): WorkItem {
    this.items.set(item.itemId, item);
    return item;
  }

  private check(call: Call, detail = ""): void {
    this.calls.push(detail ? `${call} ${detail}` : call);
    const error = this.fail.get(call);
    if (error) throw error;
  }

  private own(itemId: string): WorkItem {
    const item = this.items.get(itemId);
    if (!item) throw new ClawError(404, '{"error":"not_found"}');
    return item;
  }

  list(): Promise<WorkItem[]> {
    this.check("list");
    return Promise.resolve([...this.items.values()]);
  }

  askedOfOthers(): Promise<ReviewAskedOfOther[]> {
    this.check("asked");
    return Promise.resolve([...this.asked]);
  }

  get(key: string, itemId: string): Promise<WorkItem> {
    this.check("item", `${key} ${itemId}`);
    return Promise.resolve(this.own(itemId));
  }

  accept(key: string, itemId: string, version: number): Promise<Decision> {
    this.check("accept", `${key} ${itemId} v${String(version)}`);
    const item = this.own(itemId);
    if (item.boardState === "done") return Promise.resolve({ ok: false, item, error: "item_closed" });
    if (item.resultVersion !== version) return Promise.resolve({ ok: false, item, error: "version_mismatch" });
    const done = { ...item, boardState: "done", outcome: "accepted", canAccept: false };
    this.items.set(itemId, done);
    return Promise.resolve({ ok: true, item: done, error: "" });
  }

  stop(key: string, itemId: string): Promise<Decision> {
    this.check("stop", `${key} ${itemId}`);
    const item = this.own(itemId);
    const refused = this.stopRefusal.get(itemId);
    if (refused) return Promise.resolve({ ok: false, item, error: refused });
    if (item.boardState === "done") return Promise.resolve({ ok: false, item, error: "item_closed" });
    const done = { ...item, boardState: "done", outcome: "stopped", canAccept: false };
    this.items.set(itemId, done);
    return Promise.resolve({ ok: true, item: done, error: "" });
  }

  retry(key: string, itemId: string): Promise<Decision> {
    this.check("retry", `${key} ${itemId}`);
    const item = this.own(itemId);
    if (this.retryRefusal) return Promise.resolve({ ok: false, item, error: this.retryRefusal });
    const again = { ...item, boardState: "in_progress", outcome: null };
    this.items.set(itemId, again);
    return Promise.resolve({ ok: true, item: again, error: "" });
  }

  pulls(key: string, itemId: string): Promise<{ item: WorkItem; pulls: string[] }> {
    this.check("pulls", `${key} ${itemId}`);
    return Promise.resolve({ item: this.own(itemId), pulls: this.pullsOf.get(itemId) ?? [] });
  }

  watches(key: string, itemId: string): Promise<JsonObject[]> {
    this.check("watches", `${key} ${itemId}`);
    return Promise.resolve([...(this.subs.get(itemId) ?? [])]);
  }

  watchPull(token: string, itemId: string, pull: string, reply = false): Promise<JsonObject> {
    this.check("watch", `${token} ${itemId} ${pull} ${String(reply)}`);
    const sub = { sub_id: `sub-${itemId}`, url: pull, state: "active", reply_allowed: reply };
    this.subs.set(itemId, [...(this.subs.get(itemId) ?? []).filter((s) => s["url"] !== pull), sub]);
    return Promise.resolve(sub);
  }

  unwatchPull(key: string, itemId: string, subId: string): Promise<JsonObject> {
    this.check("unwatch", `${key} ${itemId} ${subId}`);
    this.subs.set(
      itemId,
      (this.subs.get(itemId) ?? []).map((s) => (s["sub_id"] === subId ? { ...s, state: "ended" } : s)),
    );
    return Promise.resolve({});
  }
}
