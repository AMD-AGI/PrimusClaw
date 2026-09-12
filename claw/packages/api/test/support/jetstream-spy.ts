// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The JetStream client `routes/a2a.ts` publishes through, replaced by a
 * recorder.
 *
 * `js` is a module binding assigned by `initNats`, so there is no seam a test
 * could write to and no NATS to publish at. The resolve hook swaps the module
 * only for the import in `routes/a2a.ts`; every other importer, this file
 * included, keeps the real one, and the local `js` shadows the re-exported one.
 *
 * Import it after the admission cluster has set the environment and before
 * `routes/a2a.js`: it pulls in `config.ts`, which reads `ADMIT_*` once, and a
 * hook only applies to loads that come after it.
 */

import { registerHooks } from "node:module";

export * from "../../src/infra/nats.js";

const A2A_MODULE = new URL("../../src/routes/a2a.ts", import.meta.url).href;
const SPY_MODULE = import.meta.url;

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (context.parentURL === A2A_MODULE && specifier === "../infra/nats.js") {
      return { url: SPY_MODULE, shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
});

export interface PublishedMessage {
  subject: string;
  payload: string;
}

const published: PublishedMessage[] = [];

export const js = {
  async publish(subject: string, payload: Uint8Array): Promise<void> {
    published.push({ subject, payload: new TextDecoder().decode(payload) });
  },
};

export function clearPublished(): void {
  published.length = 0;
}

export function publishedTo(subject: string): PublishedMessage[] {
  return published.filter((m) => m.subject === subject);
}
