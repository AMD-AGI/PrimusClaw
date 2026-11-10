// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

// Nothing here may be reported by own-keys/no-prototype-keys (test/no-prototype-keys.test.ts).
import { own } from "../../../packages/core/src/own.js";

type Table = Record<string, string>;
type Verb = "status" | "stop";
const VERBS: Readonly<Record<Verb, string>> = { status: "/status", stop: "/stop" };

export const literalKey = (table: Readonly<Table>): string | undefined => table["status"];
export const literalUnion = (verb: Verb): string => VERBS[verb];
export const viaOwn = (table: Readonly<Table>, key: string): string | undefined => own(table, key);
export const map = (table: ReadonlyMap<string, string>, key: string): string | undefined => table.get(key);
export const arrayIndex = (list: readonly string[], i: number): string | undefined => list[i];
export const stringIndex = (text: string, i: number): string | undefined => text[i];
export const ternary = (table: Readonly<Table>, key: string): string | undefined =>
  Object.hasOwn(table, key) ? table[key] : undefined;
export const and = (table: Readonly<Table>, key: string): boolean => Object.hasOwn(table, key) && table[key] === "x";

export function ifGuard(table: Readonly<Table>, key: string): string | undefined {
  if (Object.hasOwn(table, key) && key !== "") {
    return table[key];
  }
  return undefined;
}

export function earlyReturn(table: Table, key: string, value: string): void {
  if (!Object.hasOwn(table, key)) return;
  table[key] = value;
}

export function nullPrototype(entries: readonly (readonly [string, string])[]): Table {
  const table = Object.create(null) as Table;
  for (const [key, value] of entries) table[key] = value;
  return table;
}

export const built = (entries: readonly (readonly [string, string])[]): Table => Object.fromEntries(entries);
