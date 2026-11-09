// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import {
  ClawAnswerInvalid,
  ClawError,
  decidedItem,
  parseRequesterView,
  parseWorkItem,
  squashSpaces,
  cpHead,
  type AskerView,
  type BoardState,
  type ClawCredential,
  type ClawWorkItemsPort,
  type Decision,
  type JsonObject,
  type ReviewAskedOfOther,
  type WorkItem,
} from "@primusclaw/personal-agent";
import { anyDataOf, dataOf, objectOf, rowsOf } from "./answers.js";
import { type ClawHttp, head, readText, segment } from "./http.js";

/** A pull request as a worker reports it. */
const PULL_URL = /^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/pull\/[0-9]+$/;

/** `ClawWorkItemsPort` over Claw's HTTP API. */
export class HttpWorkItems implements ClawWorkItemsPort {
  constructor(private readonly http: ClawHttp) {}

  async list(key: ClawCredential, state?: BoardState): Promise<WorkItem[]> {
    const path = "/v1/work-items" + (state === undefined ? "" : `?state=${segment(state)}`);
    const rows = rowsOf(await this.http.json({ method: "GET", path, key }), "the board");
    return rows.flatMap((row) => parseWorkItem(row) ?? []);
  }

  async askedOfOthers(key: ClawCredential): Promise<ReviewAskedOfOther[]> {
    let answer: unknown;
    try {
      answer = await this.http.json({ method: "GET", path: "/v1/work-items/asked-of-others", key });
    } catch (err) {
      if (err instanceof ClawError && err.status === 404) return [];
      throw err;
    }
    return rowsOf(answer, "the reviews asked of others").flatMap(askedOfOther);
  }

  async get(key: ClawCredential, itemId: string): Promise<WorkItem> {
    const item = parseWorkItem(await this.data(key, itemId));
    if (item === null) throw new ClawAnswerInvalid("a work item without an id");
    return item;
  }

  async requesterView(key: ClawCredential, itemId: string): Promise<AskerView> {
    const view = parseRequesterView(await this.data(key, itemId), itemId);
    if (view === null) throw new ClawAnswerInvalid("an answer without the asker's view of the item");
    return view;
  }

  accept(key: ClawCredential, itemId: string, version: number): Promise<Decision> {
    return this.decide(key, itemId, "accept", { version });
  }

  retry(key: ClawCredential, itemId: string): Promise<Decision> {
    return this.decide(key, itemId, "retry", {});
  }

  stop(key: ClawCredential, itemId: string): Promise<Decision> {
    return this.decide(key, itemId, "stop", {});
  }

  async pulls(key: ClawCredential, itemId: string): Promise<{ item: WorkItem; pulls: string[] }> {
    const data = await this.data(key, itemId);
    const item = parseWorkItem(data);
    if (item === null) throw new ClawAnswerInvalid("a work item without an id");
    return { item, pulls: reportedPulls(data) };
  }

  async watchPull(token: ClawCredential, itemId: string, pull: string, reply = true): Promise<JsonObject> {
    const path = `/v1/work-items/${segment(itemId)}/subscriptions`;
    return dataOf(await this.http.json({ method: "POST", path, key: token, body: { pr: pull, reply } }), "a watch");
  }

  async watches(key: ClawCredential, itemId: string): Promise<JsonObject[]> {
    const path = `/v1/work-items/${segment(itemId)}/subscriptions`;
    const data = anyDataOf(await this.http.json({ method: "GET", path, key }), "the watches");
    return Array.isArray(data) ? (data.filter(isObject) as JsonObject[]) : [];
  }

  async unwatchPull(key: ClawCredential, itemId: string, subId: string): Promise<JsonObject> {
    const path = `/v1/work-items/${segment(itemId)}/subscriptions/${segment(subId)}`;
    return dataOf(await this.http.json({ method: "DELETE", path, key }), "a watch");
  }

  private async data(key: ClawCredential, itemId: string): Promise<unknown> {
    return anyDataOf(await this.http.json({ method: "GET", path: `/v1/work-items/${segment(itemId)}`, key }), "an item");
  }

  /** An accept, stop or retry; a 409 says why not and carries the item as it is now. */
  private async decide(key: ClawCredential, itemId: string, action: string, body: JsonObject): Promise<Decision> {
    const path = `/v1/work-items/${segment(itemId)}/${action}`;
    const response = await this.http.send({ method: "POST", path, key, body });
    const text = await readText(response, path);
    if (response.status === 409) return refused(itemId, text);
    if (response.status >= 400) throw new ClawError(response.status, head(text));
    const item = decidedItem(itemId, objectOf(parse(text), "a decision")["data"]);
    if (item === null) throw new ClawAnswerInvalid("an accepted or stopped item without an id");
    return { ok: true, item, error: "" };
  }
}

/** A 409 of a decision: the item as it is now and Claw's reason; one that carries no item is a plain ClawError. */
function refused(itemId: string, text: string): Decision {
  const payload = parse(text);
  const item = isObject(payload) ? decidedItem(itemId, payload["data"]) : null;
  if (item === null || !isObject(payload)) throw new ClawError(409, head(text));
  const error = payload["error"];
  return { ok: false, item, error: typeof error === "string" ? error : "" };
}

function parse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** One row of the reviews asked of others, or nothing for a row without an id or a view. */
function askedOfOther(row: Record<string, unknown>): ReviewAskedOfOther[] {
  const itemId = row["item_id"];
  if (typeof itemId !== "string" || itemId === "") return [];
  const view = parseRequesterView(row["view"], itemId);
  if (view === null) return [];
  const reviewer = row["reviewer"];
  return [{ itemId, reviewer: typeof reviewer === "string" ? cpHead(squashSpaces(reviewer), 100) : "", view }];
}

/** The pull requests the item's worker reported (`refs` of type `pr`), newest first, each once. */
function reportedPulls(data: unknown): string[] {
  const events = isObject(data) && Array.isArray(data["events"]) ? data["events"] : [];
  const out: string[] = [];
  for (const event of events) {
    const result: unknown = isObject(event) ? event["result"] : undefined;
    const refs: unknown = isObject(result) ? result["refs"] : undefined;
    for (const ref of Array.isArray(refs) ? refs : []) {
      const url: unknown = isObject(ref) && ref["type"] === "pr" ? ref["url"] : undefined;
      if (typeof url === "string" && PULL_URL.test(url) && !out.includes(url)) out.push(url);
    }
  }
  return out;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
