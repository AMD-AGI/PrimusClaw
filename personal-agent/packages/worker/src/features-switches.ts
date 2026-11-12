// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The switches the Python worker's `main.py` read straight from the environment rather than from `Settings` (BRIEF_ENABLED,
 * ASSISTANT_SCHEDULES_ENABLED, ASSISTANT_JOB_WATCH_ENABLED, REMOTE_AGENTS_ENABLED, REMOTE_PUSH_ENABLED, REMOTE_WINDOW_DEFAULT,
 * PROACTIVE_ENABLED, NOTIFY_WEBHOOK_URL), with the same names and the same readings.
 */
import { own, pyStrip } from "@primusclaw/personal-agent";

import { StartupError } from "./startup-error.js";

export type Env = Readonly<Record<string, string | undefined>>;

export interface FeatureSwitches {
  /** BRIEF_ENABLED == "1": `/brief` (it needs Claw's trigger API). */
  readonly brief: boolean;
  /** ASSISTANT_SCHEDULES_ENABLED == "1". */
  readonly schedules: boolean;
  /** ASSISTANT_JOB_WATCH_ENABLED == "1". */
  readonly jobWatch: boolean;
  /** REMOTE_AGENTS_ENABLED == "1". */
  readonly remoteAgents: boolean;
  /** An attached chat hears its agent between turns (`remote_push_wanted`). */
  readonly remotePush: boolean;
  /** REMOTE_WINDOW_DEFAULT: "chat", or "card" for anything else. */
  readonly remoteWindow: "card" | "chat";
  /** PROACTIVE_ENABLED == "1". */
  readonly proactive: boolean;
  /** Where Claw sends this worker's events ("" when proactive messages are off: no subscriptions at all). */
  readonly notifyUrl: string;
}

function on(env: Env, name: string): boolean {
  return (own(env, name) ?? "") === "1";
}

/** NOTIFY_WEBHOOK_URL, required with PROACTIVE_ENABLED and ignored without it (`notify_url_from_env`). */
export function notifyUrlFromEnv(proactive: boolean, raw: string): string {
  const url = pyStrip(raw);
  if (proactive && !url) {
    throw new StartupError(
      "PROACTIVE_ENABLED needs NOTIFY_WEBHOOK_URL (the address Claw sends this worker's events to)",
    );
  }
  return proactive ? url : "";
}

/** On unless REMOTE_PUSH_ENABLED says off, and only with PROACTIVE_ENABLED (`remote_push_wanted`). */
export function remotePushWanted(proactive: boolean, raw: string): boolean {
  return proactive && !["0", "false", "no", "off"].includes(pyStrip(raw).toLowerCase());
}

/** "chat" when REMOTE_WINDOW_DEFAULT says so, else "card" (`remote_window_default`). */
export function remoteWindowDefault(raw: string): "card" | "chat" {
  return pyStrip(raw).toLowerCase() === "chat" ? "chat" : "card";
}

export function featureSwitches(env: Env): FeatureSwitches {
  const proactive = on(env, "PROACTIVE_ENABLED");
  return {
    brief: on(env, "BRIEF_ENABLED"),
    schedules: on(env, "ASSISTANT_SCHEDULES_ENABLED"),
    jobWatch: on(env, "ASSISTANT_JOB_WATCH_ENABLED"),
    remoteAgents: on(env, "REMOTE_AGENTS_ENABLED"),
    remotePush: remotePushWanted(proactive, env["REMOTE_PUSH_ENABLED"] ?? "1"),
    remoteWindow: remoteWindowDefault(env["REMOTE_WINDOW_DEFAULT"] ?? "card"),
    proactive,
    notifyUrl: notifyUrlFromEnv(proactive, env["NOTIFY_WEBHOOK_URL"] ?? ""),
  };
}
