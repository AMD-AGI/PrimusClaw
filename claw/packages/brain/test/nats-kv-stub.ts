// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * An in-memory KV that gets subject-token semantics right.
 *
 * Not a convenience: the bugs these tests exist to catch live entirely in the
 * difference between `*` and `>`. A stub that matched filters by string prefix
 * would pass whether the code under test used either, which is exactly how a
 * scan that can never match anything survives review. `*` spans one token, `>`
 * spans one or more, and a key with an unescaped dot in it has more tokens than
 * whoever wrote the filter was counting on.
 */

/** Translate a NATS subject filter into the regexp it means. */
export function filterToRegExp(filter: string): RegExp {
  const body = filter.split(".").map((token) => {
    if (token === "*") return "[^.]+";
    if (token === ">") return ".+";
    return token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }).join("\\.");
  return new RegExp(`^${body}$`);
}

/** `throwKeys` holds whichever lookup should fail -- a get key or a keys filter. */
export function makeKv(
  values: Map<string, unknown> = new Map(),
  throwKeys: Set<string> = new Set(),
): unknown {
  return {
    get: async (key: string) => {
      if (throwKeys.has(key)) throw new Error("kv unavailable");
      const v = values.get(key);
      return v === undefined ? null : { value: v };
    },
    keys: async (filter = ">") => {
      if (throwKeys.has(filter)) throw new Error("kv unavailable");
      const re = filterToRegExp(filter);
      const matched = [...values.keys()].filter((k) => re.test(k));
      return (async function* () { yield* matched; })();
    },
    put: async (key: string, value: unknown) => { values.set(key, value); },
    delete: async (key: string) => { values.delete(key); },
  };
}
