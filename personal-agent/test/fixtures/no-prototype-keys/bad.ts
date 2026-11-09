// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

// Every line marked "REPORTED" must be reported by own-keys/no-prototype-keys (test/no-prototype-keys.test.ts).
const VERBS = { status: "/status", stop: "/stop" } as const;
type Table = Record<string, string>;

export function verb(word: string): string {
  return VERBS[word as keyof typeof VERBS] ?? "usage"; // REPORTED: the #586 shape, the cast hides a plain string
}

export function read(table: Readonly<Table>, key: string): string | undefined {
  return table[key]; // REPORTED
}

export function write(table: Table, key: string, value: string): void {
  table[key] = value; // REPORTED: "__proto__" replaces the prototype
}

export function remove(table: Table, key: string): void {
  delete table[key]; // REPORTED
}

export function has(table: Readonly<Table>, key: string): boolean {
  return key in table; // REPORTED
}

export function fromUnknown(table: Readonly<Table>, key: unknown): string | undefined {
  return table[key as string]; // REPORTED
}

export function templated(table: Readonly<Table>, key: `cmd_${string}`): string | undefined {
  return table[key]; // REPORTED
}

export function generic<K extends string>(table: Readonly<Record<K, string>>, key: K): string {
  return table[key]; // REPORTED
}

export function wrongGuard(table: Readonly<Table>, other: Readonly<Table>, key: string): string | undefined {
  return Object.hasOwn(other, key) ? table[key] : undefined; // REPORTED: the check is of another object
}

export function elseBranch(table: Readonly<Table>, key: string): string | undefined {
  return Object.hasOwn(table, key) ? undefined : table[key]; // REPORTED: the branch where it is not own
}

export function reassigned(reset: boolean, key: string): string | undefined {
  let table = Object.create(null) as Table;
  if (reset) table = {};
  return table[key]; // REPORTED: a let may hold a plain object by now
}
