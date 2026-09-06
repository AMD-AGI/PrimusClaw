// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The admission roster as one durable record in the registry bucket.
 *
 * Fleet-wide because that bucket is, and race-safe because every mutation is a
 * compare-and-set against the revision the mutating replica read. A single key
 * rather than one per slot: the ceiling is a property of the set, so deciding
 * it from a walk of many keys would be the read-then-write shape the roster
 * exists to forbid.
 */

import { StringCodec, type KV } from "nats";
import { isRevisionConflict } from "@claw/utils";
import { BRAIN_ID } from "../config.js";
import type { Roster, RosterConfig, RosterStore } from "./admission-roster.js";
import type { CapacitySettings } from "./keepalive-capacity.js";

const sc = StringCodec();
const ROSTER_KEY = "keepalive.roster";
/** Held long enough that neither a slow sweep nor a slow but live provisioning
 *  loses its reservation. */
const RECLAIM_HORIZON_MS = 15 * 60_000;

export function rosterStore(kv: KV): RosterStore {
  return {
    async read() {
      const entry = await kv.get(ROSTER_KEY);
      if (!entry) return null;
      return { roster: JSON.parse(sc.decode(entry.value)) as Roster, revision: entry.revision };
    },
    async write(roster, expectedRevision) {
      try {
        const encoded = sc.encode(JSON.stringify(roster));
        if (expectedRevision === null) await kv.create(ROSTER_KEY, encoded);
        else await kv.update(ROSTER_KEY, encoded, expectedRevision);
        return true;
      } catch (err) {
        if (isRevisionConflict(err)) return false;
        throw err;
      }
    },
  };
}

/**
 * The roster half of the keepalive sweep's dependencies, or nothing where
 * background shells are off and there is no ceiling to hold.
 */
export function rosterDeps(
  kv: KV, capacity: CapacitySettings,
): { roster?: { store: RosterStore; config: RosterConfig } } {
  if (capacity.ceiling <= 0) return {};
  return {
    roster: {
      store: rosterStore(kv),
      config: {
        ceiling: capacity.ceiling,
        reconciliationReserve: capacity.reconciliationReserve,
        reclaimHorizonMs: RECLAIM_HORIZON_MS,
        replicaId: BRAIN_ID,
      },
    },
  };
}
