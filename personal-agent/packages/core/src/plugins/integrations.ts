// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import type { Lang } from "../locales/lang.js";
import type { KeyOwner } from "./identity-lookup.js";

/**
 * Services of one deployment that the worker names, registered here so that the worker's own code names none of them
 * (the Python worker's `integrations.py`). A deployment may run MCP servers of its own whose steps should read as
 * "Querying <name>", and may have accounts whose kind decides what else a person can use, said as one more line of
 * /whoami. Those names and lines come from the deployment's assembly (`register(registry)`), never from core.
 */
export interface IntegrationRegistry {
  /**
   * An MCP server (its name lower case as Claw's tool names carry it, `mcp__<server>__<verb>`) people see as `shown`;
   * with `query`, its `get_*` / `list_*` steps read as "Querying <shown>" in progress lines.
   */
  addMcpServer(name: string, shown: string, options?: { readonly query?: boolean }): void;
  /**
   * One line of /whoami's connections, after GitHub's: a function of the key's owner (undefined when it could not be
   * read) and the language of the chat.
   */
  addConnectionLine(line: (owner: KeyOwner | undefined, lang: Lang) => string): void;
}

/** What a registry holds, as the features that use it read it. */
export interface Integrations {
  /** MCP server name (lower case) -> the name people see. */
  readonly mcpServers: ReadonlyMap<string, string>;
  /** The servers whose reads a progress line names ("Querying <name>"). */
  readonly queryServers: ReadonlySet<string>;
  readonly connectionLines: readonly ((owner: KeyOwner | undefined, lang: Lang) => string)[];
}

/** A registry, and what has been registered in it. */
export function integrationRegistry(): IntegrationRegistry & Integrations {
  const mcpServers = new Map<string, string>();
  const queryServers = new Set<string>();
  const connectionLines: ((owner: KeyOwner | undefined, lang: Lang) => string)[] = [];
  return {
    mcpServers,
    queryServers,
    connectionLines,
    addMcpServer(name, shown, options = {}) {
      mcpServers.set(name.toLowerCase(), shown);
      if (options.query === true) queryServers.add(name.toLowerCase());
    },
    addConnectionLine(line) {
      connectionLines.push(line);
    },
  };
}

/** No integrations: the public build names no deployment's services. */
export const noIntegrations: Integrations = {
  mcpServers: new Map(),
  queryServers: new Set(),
  connectionLines: [],
};
