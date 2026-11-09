// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import {
  ClawAnswerInvalid,
  ClawError,
  cpHead,
  notAClawId,
  pyStr,
  pyTruthy,
  type ClawCredential,
  type ClawMergeConfirmationsPort,
  type ClawNotificationsPort,
  type ClawSettingsPort,
  type ClawSubscription,
  type ClawTriggersPort,
  type GithubConnection,
  type JsonObject,
  type MemoryState,
  type TriggerInput,
} from "@primusclaw/personal-agent";
import { dataOrSelf } from "./assistant.js";
import { dataOf, objectOf, rowsOf } from "./answers.js";
import { type ClawHttp, head, pyQuote, readText, requireToken, segment } from "./http.js";

/** `ClawSettingsPort` over Claw's HTTP API. */
export class HttpSettings implements ClawSettingsPort {
  constructor(private readonly http: ClawHttp) {}

  async memory(key: ClawCredential, limit = 5): Promise<MemoryState> {
    const settings = dataOf(
      await this.http.json({ method: "GET", path: "/v1/users/me/memory-settings", key }),
      "memory",
    );
    const items = rowsOf(await this.http.json({ method: "GET", path: "/v1/users/me/memories", key }), "memories");
    const texts = items
      .filter((m) => m["category"] !== "user_profile")
      .map((m) => ("content" in m ? pyStr(m["content"]) : ""));
    return {
      enabled: Boolean(settings["enabled"]),
      available: "available" in settings ? pyTruthy(settings["available"]) : true,
      items: texts.slice(0, limit),
    };
  }

  async setMemory(key: ClawCredential, enabled: boolean): Promise<{ enabled: boolean; available: boolean }> {
    const answer = await this.http.json({
      method: "PUT",
      path: "/v1/users/me/memory-settings",
      key,
      body: { enabled },
    });
    const data = dataOf(answer, "memory");
    return { enabled: Boolean(data["enabled"]), available: "available" in data ? pyTruthy(data["available"]) : true };
  }

  async models(key: ClawCredential): Promise<string[]> {
    const out = await this.http.json({ method: "GET", path: "/v1/models", key });
    const data = isObject(out) ? out["data"] : undefined;
    if (!Array.isArray(data)) throw new ClawError(502, "not a model list");
    return data.flatMap((m: unknown) =>
      isObject(m) && typeof m["id"] === "string" && m["id"] !== "" ? [m["id"]] : [],
    );
  }

  async assistantSettings(token: ClawCredential): Promise<JsonObject | null> {
    const out = await this.#optional(token, "/v1/assistant/settings");
    if (out === null) return null;
    const data = out["data"];
    if (!isObject(data)) throw new ClawError(502, "not the assistant's settings");
    return data as JsonObject;
  }

  async reviewMode(token: ClawCredential): Promise<string> {
    const out = await this.http.json({ method: "GET", path: "/v1/github-review/settings", key: token });
    const data: unknown = isObject(out) ? ("data" in out ? out["data"] : out) : {};
    const mode = isObject(data) ? data["review_mode"] : undefined;
    return pyStr(mode);
  }

  async setReviewMode(token: ClawCredential, mode: string): Promise<void> {
    await this.http.json({
      method: "PUT",
      path: "/v1/github-review/settings",
      key: token,
      body: { review_mode: mode },
    });
  }

  async githubConnection(token: ClawCredential): Promise<GithubConnection | null> {
    const out = await this.#optional(token, "/v1/github/connection");
    if (out === null) return null;
    const data = out["data"];
    if (!isObject(data)) throw new ClawError(502, "not a GitHub connection");
    const reads = data["reads_with"];
    return {
      readsWith: reads === "env" || reads === "binding" ? reads : "",
      login: cpHead(pyStr(data["login"]), 100),
      missing: cpHead(pyStr(data["missing"]), 20),
      bindingReads: data["binding_reads"] === true,
    };
  }

  /** A GET that a Claw without the route answers 404 (null); other failures are ClawError. */
  async #optional(token: ClawCredential, path: string): Promise<Record<string, unknown> | null> {
    const response = await this.http.send({ method: "GET", path, key: token });
    const text = await readText(response, path);
    if (response.status === 404) return null;
    if (response.status >= 400) throw new ClawError(response.status, head(text));
    try {
      return objectOf(JSON.parse(text), path);
    } catch {
      throw new ClawAnswerInvalid(`${path}: not an object`);
    }
  }
}

/** `ClawNotificationsPort` over Claw's HTTP API. */
export class HttpNotifications implements ClawNotificationsPort {
  constructor(private readonly http: ClawHttp) {}

  async list(key: ClawCredential): Promise<ClawSubscription[]> {
    const path = "/v1/notification-subscriptions";
    return rowsOf(await this.http.json({ method: "GET", path, key }), "the subscriptions");
  }

  async create(
    key: ClawCredential,
    url: string,
    eventTypes: readonly string[] = [],
    sources: readonly string[] = [],
  ): Promise<ClawSubscription> {
    const body = {
      url,
      ...(eventTypes.length === 0 ? {} : { event_types: eventTypes }),
      ...(sources.length === 0 ? {} : { sources }),
    };
    const path = "/v1/notification-subscriptions";
    return dataOf(await this.http.json({ method: "POST", path, key, body }), "a subscription");
  }

  async updateTypes(
    key: ClawCredential,
    subscriptionId: string,
    eventTypes: readonly string[],
    options: { enable?: boolean; sources?: readonly string[] } = {},
  ): Promise<ClawSubscription> {
    const { enable = false, sources = [] } = options;
    const body = {
      event_types: eventTypes,
      ...(sources.length === 0 ? {} : { sources }),
      ...(enable ? { enabled: true } : {}),
    };
    const path = `/v1/notification-subscriptions/${segment(subscriptionId)}`;
    return dataOf(await this.http.json({ method: "PATCH", path, key, body }), "a subscription");
  }

  async delete(key: ClawCredential, subscriptionId: string): Promise<void> {
    await this.http.json({ method: "DELETE", path: `/v1/notification-subscriptions/${segment(subscriptionId)}`, key });
  }
}

/** `ClawTriggersPort` over Claw's HTTP API. */
export class HttpTriggers implements ClawTriggersPort {
  constructor(private readonly http: ClawHttp) {}

  async list(key: ClawCredential): Promise<JsonObject[]> {
    return rowsOf(await this.http.json({ method: "GET", path: "/v1/triggers", key }), "the triggers");
  }

  async create(key: ClawCredential, trigger: TriggerInput): Promise<JsonObject> {
    const { name, prompt, schedule, timezone, action = "" } = trigger;
    const body = { name, prompt, schedule, timezone, ...(action === "" ? {} : { action }) };
    return dataOf(await this.http.json({ method: "POST", path: "/v1/triggers", key, body }), "a trigger");
  }

  async update(key: ClawCredential, triggerId: string, trigger: TriggerInput): Promise<JsonObject> {
    const { name, prompt, schedule, timezone } = trigger;
    const path = `/v1/triggers/${segment(triggerId)}`;
    const body = { name, prompt, schedule, timezone };
    return dataOf(await this.http.json({ method: "PATCH", path, key, body }), "a trigger");
  }

  async delete(key: ClawCredential, triggerId: string): Promise<void> {
    await this.http.json({ method: "DELETE", path: `/v1/triggers/${segment(triggerId)}`, key });
  }
}

/** `ClawMergeConfirmationsPort` over Claw's HTTP API. */
export class HttpMergeConfirmations implements ClawMergeConfirmationsPort {
  constructor(private readonly http: ClawHttp) {}

  async pending(key: ClawCredential, sessionId: string): Promise<JsonObject[]> {
    const path = `/v1/github-review/confirmations?session_id=${pyQuote(sessionId)}&status=pending`;
    const out = objectOf(await this.http.json({ method: "GET", path, key }), "the confirmations");
    const data = out["data"];
    let items: unknown = out["items"];
    if (items === undefined && isObject(data)) items = data["items"];
    if (items === undefined && Array.isArray(data)) items = data;
    return Array.isArray(items) ? (items.filter(isObject) as JsonObject[]) : [];
  }

  async decide(token: ClawCredential, confirmationId: string, decision: string): Promise<JsonObject> {
    requireToken(token, "a merge decision");
    if (confirmationId === "." || confirmationId === "..") throw notAClawId();
    const path = `/v1/github-review/confirmations/${pyQuote(confirmationId)}/decision`;
    return dataOrSelf(
      objectOf(await this.http.json({ method: "POST", path, key: token, body: { decision } }), "a decision"),
    );
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
