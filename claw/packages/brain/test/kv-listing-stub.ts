// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * A KV whose `keys()` listing behaves the way the deployed nats.js one does.
 *
 * That client ends an open listing when another KV operation is awaited while
 * it is still being iterated: a loop that `get`s each key as it arrives reads
 * the first and then sees the listing finish. Measured in production with the
 * service's own client -- eight keys without a read in the loop, one with --
 * and invisible to any stub whose listing is a plain array, which is how the
 * read-while-listing walks survived their tests.
 *
 * Wraps any KV-shaped object. Every method other than `keys` counts as "another
 * operation"; calling one while a listing is open closes that listing after
 * the key it has already handed out.
 */
export function listingEndsOnOtherOps<T extends object>(kv: T): T {
  const open = new Set<{ closed: boolean }>();
  const closeOpen = () => {
    for (const listing of open) listing.closed = true;
    open.clear();
  };
  return new Proxy(kv, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (typeof value !== "function") return value;
      if (prop === "keys") {
        return async (...args: unknown[]) => {
          const inner = await (value as (...a: unknown[]) => Promise<AsyncIterable<string>>)
            .apply(target, args);
          const listing = { closed: false };
          open.add(listing);
          return (async function* () {
            try {
              for await (const key of inner) {
                if (listing.closed) return;
                yield key;
              }
            } finally {
              open.delete(listing);
            }
          })();
        };
      }
      return (...args: unknown[]) => {
        closeOpen();
        return (value as (...a: unknown[]) => unknown).apply(target, args);
      };
    },
  });
}
