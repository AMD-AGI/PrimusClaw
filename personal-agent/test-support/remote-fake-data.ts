// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/** What the fake remote-agents server (`remote-fake.ts`) holds and what a test sets up: Claw's records, as the API lists them. */
export const UPGRADE =
  "npm install -g @primusclaw/connector@latest && claw-connector stop && claw-connector service install"; // (Claw's)
export const PREFIX = "/v1/remote-agents";
export const KEYS: Readonly<Record<string, string>> = {
  "ak-alice": "u-alice",
  "ak-bob": "u-bob",
};
export const MAX_ACTIVE_SESSIONS = 10;

export interface PermissionOption {
  readonly optionId: string;
  readonly name: string;
  readonly kind: string;
}

export const CLAUDE_OPTIONS: readonly PermissionOption[] = [
  { optionId: "allow-once", name: "Allow once", kind: "allow_once" },
  {
    optionId: "allow-with-updates",
    name: "Allow and update my settings",
    kind: "allow_always",
  },
  { optionId: "reject", name: "Reject", kind: "reject_once" },
];
export const CODEX_OPTIONS: readonly PermissionOption[] = [
  { optionId: "allow_once", name: "Allow once", kind: "allow_once" },
  {
    optionId: "accept_execpolicy_amendment",
    name: "Always allow this command",
    kind: "allow_always",
  },
  { optionId: "cancel", name: "Cancel", kind: "reject_once" },
];
export const CURSOR_OPTIONS: readonly PermissionOption[] = [
  { optionId: "allow-once", name: "Allow once", kind: "allow_once" },
  { optionId: "allow-always", name: "Allow always", kind: "allow_always" },
  { optionId: "reject-once", name: "Reject", kind: "reject_once" },
];

export type Json = Record<string, unknown>;

export interface FakeAgent {
  agent_id: string;
  kind: string;
  name: string;
  capabilities: Json;
}

export interface FakeConnector {
  connector_id: string;
  owner: string;
  name: string;
  online: boolean;
  revoked: boolean;
  version: string;
  version_status: string;
  last_seen_at: string | null;
  paired: boolean | null;
  agents: FakeAgent[];
}

export interface FakeSession {
  session_id: string;
  owner: string;
  connector_id: string;
  agent_id: string;
  cwd: string;
  mode: string | null;
  status: string;
  created_at: string;
  updated_at: string;
}

export interface FakeEvent {
  id: number;
  seq: number;
  type: string;
  ts: number;
  data: Json;
}

/** One accepted command: who, the session, its type, its body, its id. */
export interface FakeCommand {
  user: string;
  session_id: string;
  type: string;
  body: Json;
  cmd_id?: string;
  idempotency_key?: string | null;
}

/** (method, path suffix) -> status, or [status, error word]: fault injection. */
export type Failure = number | readonly [number, string];

export interface ConnectorOptions {
  online?: boolean;
  /** Agent id -> the capabilities its connector reports (`roots`, `modes`, `ask_mode`, ...). */
  caps?: Readonly<Record<string, Json>>;
  version?: string;
  /** What Claw says of `version` (an `unsupported` one starts no session). */
  versionStatus?: string;
  /** Listed as Claw lists it (ISO 8601), when given. */
  lastSeenAt?: string | null;
  paired?: boolean | null;
}

export interface StartedOptions {
  mode?: string;
  modes?: readonly string[];
  unattended?: boolean | null;
  flags?: Readonly<Record<string, boolean>> | null;
}
