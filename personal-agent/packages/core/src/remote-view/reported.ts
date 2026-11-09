// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * What Claw relays from a connector (a machine, its agents and their capabilities) and what it says of a session, read
 * defensively: a field of the wrong type is a field that is not there. The objects are the Claw client's (zod-checked at that
 * edge); an agent's `capabilities` is the connector's own and opaque to Claw, so it is read here, key by key.
 */
import { z } from "zod";

/** A connector, an agent or a session as Claw lists it. */
export type Reported = Readonly<Record<string, unknown>>;

const Obj = z.record(z.string(), z.unknown());

/** `value` when it is a JSON object, else {}. */
export function obj(value: unknown): Reported {
  const parsed = Obj.safeParse(value);
  return parsed.success && !Array.isArray(value) ? parsed.data : {};
}

/** `value` when it is a JSON object, else null. */
export function objOrNull(value: unknown): Reported | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? obj(value) : null;
}

/** The list `value` is, or []. */
export function list(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : [];
}

/** The objects of the list `value` is, skipping anything else. */
export function objects(value: unknown): Reported[] {
  return list(value).flatMap((item) => {
    const o = objOrNull(item);
    return o ? [o] : [];
  });
}

export function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/** A connector's agents, as Claw lists them (`connector.agents or []`). */
export function agentsOf(connector: Reported): Reported[] {
  return objects(connector["agents"]);
}

/** An agent's `capabilities` (a JSON object), or {}. */
export function capabilitiesOf(agent: Reported | null | undefined): Reported {
  return agent ? obj(agent["capabilities"]) : {};
}
