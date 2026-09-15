// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Key-value subject matching, as the real bucket does it.
 *
 * Written without building a pattern out of the filter string. A regex
 * assembled from an input has to escape every character the regex language
 * gives meaning to, and a helper that escapes only the ones its author happened
 * to think of quietly matches the wrong keys -- which in a store stub means a
 * test that passes while exercising something other than what it names.
 *
 * The real semantics are simpler than a regex anyway: keys are dot-separated
 * tokens, `*` matches exactly one whole token, and `>` matches one or more
 * trailing tokens. Neither wildcard matches part of a token, which is why a
 * caller wanting a prefix within one has to filter in its own code.
 */

export function matchesKvFilter(key: string, filter: string): boolean {
  const keyTokens = key.split(".");
  const filterTokens = filter.split(".");

  for (let i = 0; i < filterTokens.length; i++) {
    const token = filterTokens[i];
    if (token === ">") return i < keyTokens.length;
    if (i >= keyTokens.length) return false;
    if (token !== "*" && token !== keyTokens[i]) return false;
  }
  return keyTokens.length === filterTokens.length;
}
