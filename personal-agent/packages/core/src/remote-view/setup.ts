// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import type { Lang } from "../locales/lang.js";
import type { Reported } from "./reported.js";

/** The connect steps for a card: the lead line, each command on a line of its own, what to do after, the per-system notes. */
export interface ConnectSteps {
  readonly lead: string;
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
  /** The same for a card. */
  connectSteps(lang: Lang): ConnectSteps;
  /** One line under a machine whose connector Claw says is old, with the command that upgrades it; null otherwise. */
  versionNote(connector: Reported, lang: Lang): string | null;
  /** What brings an offline machine back. */
  offlineHint(lang: Lang): string;
  /** The exact `claw-connector login` command. */
  login(): string;
}
