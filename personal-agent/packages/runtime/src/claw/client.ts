// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import { silentLogger, type ClawPort, type Clock, type Logger } from "@primusclaw/personal-agent";
import { HttpAssistant } from "./assistant.js";
import { ClawHttp, type Fetch } from "./http.js";
import { HttpRemoteAgents } from "./remote-agents.js";
import { StyleRule } from "./rule.js";
import { HttpSessions } from "./sessions.js";
import { HttpMergeConfirmations, HttpNotifications, HttpSettings, HttpTriggers } from "./settings.js";
import { HttpWorkItems } from "./work-items.js";
import { HttpSkills } from "./skills.js";

/** What Claw's audit trail calls this client by default (`X-Claw-Client`). */
export const DEFAULT_CLIENT_LABEL = "clawy";

/** How the Claw client is made (from the worker's settings). */
export interface ClawClientOptions {
  /** CLAW_API_URL, without a trailing slash. */
  readonly baseUrl: string;
  readonly clock: Clock;
  readonly logger?: Logger;
  /** CLAW_PLUGIN_ID (null: plain sessions). */
  readonly pluginId?: number | null;
  /** CLAWY_MODEL ("" sends none). */
  readonly model?: string;
  /** CLAW_RULE_TOOL_ID (null: no rule rides on a message). */
  readonly ruleToolId?: number | null;
  /** What Claw's audit trail calls this client. */
  readonly clientLabel?: string;
  /** The `fetch` to use (a test passes a fake). */
  readonly fetch?: Fetch;
}

/** Claw's public HTTP API, always called as one person with that person's own credential. */
export function createClawClient(options: ClawClientOptions): ClawPort {
  const http = new ClawHttp(options.baseUrl, options.fetch ?? ((url, init) => fetch(url, init)));
  const toolId = options.ruleToolId ?? null;
  const rule = toolId === null ? null : new StyleRule(http, toolId, options.clock, options.logger ?? silentLogger);
  return {
    baseUrl: options.baseUrl,
    sessions: new HttpSessions(http, { pluginId: options.pluginId ?? null, model: options.model ?? "", rule }),
    workItems: new HttpWorkItems(http),
    assistant: new HttpAssistant(http),
    settings: new HttpSettings(http),
    notifications: new HttpNotifications(http),
    triggers: new HttpTriggers(http),
    mergeConfirmations: new HttpMergeConfirmations(http),
    remoteAgents: new HttpRemoteAgents(http, options.clientLabel ?? DEFAULT_CLIENT_LABEL),
    skills: new HttpSkills(http),
  };
}
