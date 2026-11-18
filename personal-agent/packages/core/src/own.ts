// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Lookups in a plain object by a key that is not a literal. A plain object inherits Object.prototype, so `table[key]`
 * answers `table.constructor` for the key "constructor" and `"toString" in table` is true, where the Python dict the
 * code was ported from has no such keys. The lint rule `own-keys/no-prototype-keys` refuses the bare forms; these are
 * the forms it accepts (or use a Map, or build a table with `Object.fromEntries`, which keeps a "__proto__" key as an
 * own key).
 */

/** `table.get(key)` of a Python dict: the table's own value for `key`, else undefined. */
export function own<V>(table: Readonly<Record<string, V>>, key: string): V | undefined {
  return Object.hasOwn(table, key) ? table[key] : undefined;
}
