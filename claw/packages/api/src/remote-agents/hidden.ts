// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The listing of a machine's conversations with the ones its owner hid taken out (or marked): a pure function over the
 * rows `store.listConnectors` reads, apart from the store so that the wire test runs it without a database.
 */
import type { RemoteHiddenCapabilities, RemoteResumableListed } from "@claw/protocol";

type Row = Record<string, any>;

/**
 * An agent row with the conversations its owner hid taken out of `capabilities.resumable` (`includeHidden`: kept, marked
 * `hidden: true`), and how many were (`capabilities.hidden_count`). A conversation a process has open (`live`) or that a session
 * of theirs holds (`attached`) is never hidden: it is listed whatever was asked.
 */
export function withHidden(agent: Row, hidden: Set<string> | undefined, includeHidden: boolean): Row {
  const caps = agent.capabilities;
  if (!hidden?.size || !caps || typeof caps !== "object" || !Array.isArray((caps as Row).resumable)) return agent;
  const kept: RemoteResumableListed[] = [];
  let count = 0;
  for (const entry of (caps as Row).resumable as unknown[]) {
    const ref = entry && typeof entry === "object" ? String((entry as Row).ref ?? "") : "";
    const state = entry && typeof entry === "object" ? (entry as Row).state : null;
    if (!hidden.has(ref) || state === "live" || state === "attached") { kept.push(entry as RemoteResumableListed); continue; }
    count += 1;
    if (includeHidden) kept.push({ ...(entry as Row), hidden: true } satisfies RemoteResumableListed);
  }
  const listed: RemoteHiddenCapabilities = { resumable: kept, hidden_count: count };
  return { ...agent, capabilities: { ...(caps as Row), ...listed } };
}
