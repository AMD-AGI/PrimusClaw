// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Seeds Brain's system-env cache through its real loader, from a stand-in for the SYSTEM_ENV bucket: the value is read once and the
 * watch then waits forever without a timer, so it holds no test open.
 */
import type { JetStreamClient } from "nats";
import { initSystemEnvCache } from "../../src/infra/system-env.js";

export async function seedSystemEnv(env: Record<string, string>): Promise<void> {
  const value = { string: () => JSON.stringify(env) };
  const kv = {
    async get() { return value; },
    async watch() {
      return (async function* () { yield value; await new Promise<never>(() => {}); })();
    },
  };
  await initSystemEnvCache({ views: { kv: async () => kv } } as unknown as JetStreamClient);
}
