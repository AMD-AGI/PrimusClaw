// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import type { Lang } from "../locales/lang.js";
import type { Connector } from "../remote/model.js";

/** The connect steps for a card: the first line (the lead, or "You have no machine connected.", then what to run), each command
 * on a line of its own, what to do after, and the per-system notes (one line each, joined by newlines). */
export interface ConnectSteps {
  readonly head: string;
  readonly commands: readonly string[];
  readonly after: string;
  readonly notes: string;
}

/**
 * What the remote-agent views say about connecting a machine and upgrading its connector: the exact commands a person copies
 * (the connector-setup module of the remote-agent domain provides it, from what Claw says or the address Claw is reached at).
 */
export interface ConnectorSetupWords {
  /** The connect steps as markdown for a rich message: the commands in one code block a person copies whole. */
  connectMarkdown(lang: Lang): string;
  /** The same for a card; `lead` replaces the first sentence. */
  connectSteps(lang: Lang, lead?: string): ConnectSteps;
  /** One line under a machine whose connector Claw says is old, with the command that upgrades it; null otherwise. */
  versionNote(connector: Connector, lang: Lang): string | null;
  /** What brings an offline machine back. */
  offlineHint(lang: Lang): string;
  /** The exact `claw-connector login` command. */
  login(): string;
}
